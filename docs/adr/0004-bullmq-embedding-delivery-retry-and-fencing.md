# ADR-0004: BullMQ embedding 전달, 재시도, repair와 publication fence

- Status: Accepted
- Date: 2026-09-12
- Canonical owner: indexing delivery/lease/attempt state machine, BullMQ retry·repair, embedding publication fence

## Context

PostgreSQL commit과 Redis enqueue는 원자적이지 않다. enqueue 전 장애, enqueue 성공 뒤 응답 유실, Redis restore, worker crash와 늦게 끝난 provider 호출이 모두 가능하다. save는 이 경로를 기다릴 수 없고 BullMQ의 completed 상태도 vector가 현재 revision에 게시되었다는 증거가 아니다. 전달은 at-least-once로 받아들이고 PostgreSQL transition과 fence로 effect를 증명해야 한다.

## Decision

Redis와 BullMQ는 committed embedding intent를 worker에 전달하는 수단으로만 사용한다. `materials`가 save transaction에서 만든 immutable intent가 source다. `indexing`은 intent의 config fingerprint·consent epoch·work generation별 delivery work와 attempt chain을 소유한다. 동일 intent에도 새 config, 재동의 epoch 또는 명시적 terminal 재시도 generation마다 새 work가 생길 수 있으므로 `intent_id` 단독 unique 제약을 두지 않는다. Redis/BullMQ의 호환 가능한 stable exact versions는 scaffold에서 pin하고 floating tag/range를 사용하지 않는다.

### PostgreSQL state machine

indexing-owned work는 최소 다음 상태를 갖는다.

```text
PENDING -> LEASED -> CALLING -> PUBLISHED
                    |    |
                    |    +-> RETRY_WAIT -> PENDING
                    +------> FINAL_FAILED
PENDING | LEASED | CALLING | RETRY_WAIT -> OBSOLETE
```

각 row는 immutable intent ID, owner/material/revision/content fingerprint, config fingerprint, consent epoch, work generation, activation identity, attempt count, DB-clock `next_attempt_at`, nullable lease expiry와 무작위 lease token, last sanitized failure class, publication identity를 가진다. `PUBLISHED`, `FINAL_FAILED`, `OBSOLETE`는 terminal이다. `OBSOLETE`는 삭제·비현재 revision·철회된 consent 또는 config fence 불일치로 실행 가치가 사라진 정상 종료 상태이며 failure/retry 횟수로 집계하지 않는다. Terminal work는 수정하거나 되살리지 않는다.

work 생성은 아래 activation command만 소유한다. `DeliverIntent`는 이미 commit된 work ID만 수락해 BullMQ에 deterministic job ID로 enqueue하고 delivery evidence를 기록한다. API의 post-save activation/delivery call은 best effort이며 실패해도 save 결과를 바꾸지 않는다.

### 최초 활성화, 재동의와 명시적 재시도

AI 설정·동의 전 save가 만든 provider-agnostic intent는 그대로 유지하고 work를 만들지 않는다. 이후 사용자가 기존 `/library` 또는 `/search`에서 의미 검색 활성화나 현재 자료 재시도를 명시적으로 요청하면 `indexing.ActivateCurrentEmbeddings` 또는 `RetryCurrentEmbedding`이 다음을 수행한다.

1. authenticated owner와 activation request ID/fingerprint를 확인한다.
2. `materials.ListCurrentEmbeddingIntents`와 `CheckRevisionFence`로 미삭제 current revision intent만 bounded batch로 읽는다.
3. 승인된 provider/model/version/dimension의 config fingerprint, 현재 embedding consent epoch와 budget admission을 확인한다. 하나라도 없으면 work/provider call은 0건이고 기존 keyword/read는 유지한다.
4. 기존 intent와 terminal work를 수정하지 않고 새 indexing work generation을 만든다. AI 설정 전 intent의 첫 활성화, config 변경, 철회 뒤 재동의된 새 epoch, 명시적 terminal failure 재시도는 각각 새 work identity다.
5. `(owner, activation_request_id)` receipt와 fingerprint는 같은 요청 반복에 같은 결과를 반환하고 다른 입력은 conflict로 만든다. Partial unique constraint는 같은 `(intent_id, config_fingerprint, consent_epoch)`에 active 또는 published work가 둘 이상 생기지 않게 한다. 동일 terminal generation을 재시도할 때만 새 activation request가 다음 generation을 만들 수 있다.

활성화는 새 화면이나 전체 운영용 재색인 시스템이 아니다. 기존 화면의 현재 자료 범위 동작이며, batch cursor와 개수/비용 preview를 제공한다. 자동 repair는 non-terminal work만 복구하고 config 선택·재동의만으로 terminal work를 자동 부활시키지 않는다.

최초 활성화가 성공하면 indexing은 owner의 current semantic activation config/consent epoch를 보존한다. 이후 새 current revision 저장은 이 활성화가 여전히 유효할 때만 같은 검사를 거쳐 새 intent용 work를 만들 수 있다. 동의 철회나 config 폐기는 current activation을 즉시 무효화하며, 재동의·새 config는 사용자 명시 동작으로 새 activation identity를 만든다.

### Claim, provider call, publication

1. worker는 짧은 transaction에서 eligible work를 `FOR UPDATE SKIP LOCKED`로 claim하고 DB clock expiry와 새 lease token을 commit한다.
2. lock과 transaction을 끝낸 뒤 public material fence로 owner/current/deleted 사실과 consent/config eligibility를 확인한다.
3. embedding provider 호출은 모든 DB transaction 밖에서 수행한다. secret, 원문, prompt나 raw provider response를 telemetry에 기록하지 않는다.
4. 결과의 shape, exact dimension과 finite numeric value를 검증한다.
5. `PublishEmbedding` transaction은 work가 같은 intent/attempt/lease token으로 active인지, lease가 만료되지 않았는지, owner와 material이 일치하는지, material이 삭제되지 않고 revision이 current인지, content/config fingerprint가 같은지 다시 확인한다.
6. fence가 통과할 때 vector row와 PostgreSQL `PUBLISHED` receipt를 원자 commit한다. 실패한 late/duplicate worker는 vector를 노출하거나 terminal state를 덮지 않는다.

provider 응답 시점에 lease가 임박했더라도 무조건 연장하지 않는다. 동일 token owner만 bounded heartbeat public transition으로 lease를 연장할 수 있으며 DB clock을 사용한다. process memory와 Redis lock은 publication 권한이 아니다.

### Retry와 final failure

retryable network timeout, 429와 provider 5xx는 최초 실행을 포함해 최대 5회 시도한다. 각 실패 뒤 full-jitter delay 상한은 `min(5초 × 2^(실패횟수-1), 60초)`이며 PostgreSQL `next_attempt_at`이 권위다. malformed response와 dimension mismatch 같은 영구 실행 오류는 `FINAL_FAILED`, revoked consent, deleted/non-current revision과 config fence 불일치는 `OBSOLETE`로 끝낸다. 마지막 retryable 실패는 `FINAL_FAILED`와 sanitized PostgreSQL evidence를 기록한다.

BullMQ의 attempts/backoff는 delivery 효율을 위한 보조 장치다. attempt 번호, eligibility, terminal 결과와 publication은 PostgreSQL만 판정한다. job 성공 ack가 PostgreSQL publication보다 먼저 일어날 수 없게 processor는 DB transition 결과 뒤 반환한다. ack가 유실되어 재실행되어도 terminal receipt가 no-op을 만든다.

### Repair와 장애 복구

repair scanner는 bounded batch와 DB clock cursor로 다음을 찾는다.

- 유효한 current semantic activation receipt가 work 생성을 요구하지만 해당 intent/config/consent epoch work가 없는 항목
- `PENDING`/`RETRY_WAIT`이고 enqueue evidence가 없거나 오래된 항목
- lease가 만료된 non-terminal work
- enqueue/publish 응답이 모호하고 PostgreSQL terminal receipt가 없는 항목

scanner는 row를 claim/commit한 뒤에만 Redis I/O를 하고 deterministic job ID로 재enqueue한다. Redis call 동안 DB transaction이나 lock을 유지하지 않는다. concurrent scanner는 `SKIP LOCKED`, lease token과 CAS로 중복 effect를 막는다. Redis 유실/restore 후에도 committed intent와 non-terminal PostgreSQL state에서 복구한다. `PUBLISHED`, `FINAL_FAILED`, `OBSOLETE`는 자동 repair 대상이 아니다.

Redis가 중단되면 indexing readiness는 degraded로 표시하고 delivery lag를 노출하되 API liveness와 PostgreSQL core readiness, save, keyword search와 reader를 실패시키지 않는다. queue depth와 job status는 운영 신호일 뿐 완료 evidence가 아니다.

## Ownership

[ADR-0002](0002-modular-monolith-domain-ownership.md)가 선언한 대로 `materials`는 provider-agnostic immutable intent까지만 소유하고 `indexing`은 activation receipt, config/consent별 work generation, delivery, lease, attempt, retry/terminal, repair와 vector publication을 단독 소유한다. `apps/api`와 `apps/worker`는 public port만 호출한다. queue infrastructure는 BullMQ mechanics만 구현하며 policy transition을 소유하지 않는다. vector 저장/query predicate는 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)을 따른다.

## Consequences

- enqueue가 최소 한 번일 수 있고 동일 provider 작업이 반복될 수 있지만 visible vector effect는 PostgreSQL에서 한 번만 게시된다.
- PostgreSQL scanner가 필요해 운영 코드가 늘지만 Redis 장애와 모든 commit/enqueue crash window를 복구한다.
- lease가 만료된 느린 결과를 버릴 수 있어 provider 비용이 일부 낭비되지만 stale publication보다 안전하다.
- semantic 검색은 eventual이며 실패 상태를 표시한다. core keyword/search/read 경로는 계속 동작한다.
- 명시적 현재 자료 재시도는 기존 intent와 terminal work를 고치는 대신 새 work generation/activation identity를 만들어 감사 가능성을 유지한다.

## Verification

- real PostgreSQL·Redis·BullMQ integration에서 commit-before-enqueue crash, enqueue-response loss, enqueue 뒤 process crash, worker ack loss, Redis restart/restore를 주입하고 repair 수렴을 확인한다.
- 둘 이상의 worker/scanner로 duplicate delivery, lease expiry/heartbeat, attempt race를 만들고 PostgreSQL publication receipt가 하나인지 확인한다.
- r1 provider 호출 중 r2 save 또는 delete를 수행해 late r1 publication이 0건인지 검증한다. wrong owner/config/dimension/lease token도 같은 방식으로 거부한다.
- timeout/429/5xx/malformed fake provider로 retry schedule, 5회 상한, non-retryable 분류와 `FINAL_FAILED` evidence를 확인한다.
- Redis를 중단해 save/keyword/read는 성공하고 indexing readiness와 lag만 degraded인지 확인한다.
- telemetry 검증은 원문, embedding input, provider response와 secret이 log/span/metric label에 포함되지 않는지 검사한다.

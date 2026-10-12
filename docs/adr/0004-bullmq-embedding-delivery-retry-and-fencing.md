# ADR-0004: BullMQ embedding 전달, 재시도, repair와 publication fence

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-10-01 — Gemini 실행·동일 본문 재사용·무료 429 정책과 bounded lifecycle
- Updated: 2026-09-22 — provider 없는 attempt·retry·lease 복구와 bounded repair
- 문서 정리: 2026-09-30 — 현재 계약·실행 기록 분리; 제품 검증 재실행 없음
- Canonical owner: indexing delivery/lease/attempt state machine, BullMQ retry·repair, embedding publication fence

## Context

PostgreSQL commit과 Redis enqueue는 원자적이지 않다. enqueue 전 장애, enqueue 성공 뒤 응답 유실, Redis restore, worker crash와 늦게 끝난 provider 호출이 모두 가능하다. save는 이 경로를 기다릴 수 없고 BullMQ의 completed 상태도 vector가 현재 revision에 게시되었다는 증거가 아니다. 전달은 at-least-once로 받아들이고 PostgreSQL transition과 fence로 effect를 증명해야 한다.

## Decision

Redis와 BullMQ는 committed embedding intent를 worker에 전달하는 수단으로만 사용한다. `materials`가 save transaction에서 만든 immutable intent가 source다. `indexing`은 intent의 config fingerprint·consent epoch·work generation별 delivery work와 attempt chain을 소유한다. 동일 intent에도 새 config, 재동의 epoch 또는 명시적 terminal 재시도 generation마다 새 work가 생길 수 있으므로 `intent_id` 단독 unique 제약을 두지 않는다. Redis/BullMQ의 호환 가능한 stable exact versions는 scaffold에서 pin하고 floating tag/range를 사용하지 않는다.

### PostgreSQL state machine

0~3단계는 provider 없는 기반을 먼저 구현한 이력이다. 현재 4~6단계에서는 consumer의 실행 processor, Gemini 호출·재사용·게시·정산과 lifecycle 정리를 연결한다. 아래 날짜별 설명은 당시 범위이며 제품 전체 완료 여부는 [plan](../plan.md#현재-상태)의 실제 종료 검사 결과로 판단한다.

**2026-09-21의 0~1단계:** `devfootnote-embedding-claims` 큐의 `claim-embedding-work` 메시지를 도입했다. payload는 `{ workId }`, job ID는 work ID다. 이미 commit된 PENDING work를 조건부 UPDATE로 LEASED로 만들고 DB clock 기준 60초 lease와 무작위 token을 저장한다. 단일 지정 ID의 claim은 UPDATE CAS로 원자화하고 잠금 대기는 Pool의 유한 timeout을 따른다. 당시에는 SKIP LOCKED batch scanner·lease 복구를 포함하지 않았다.

이 큐의 결과 `claimed`/`not-claimable`은 **claim 전달 결과**이며 embedding 성공 증거가 아니다. token·원문·owner를 Redis 결과에 싣지 않는다. 현재 consumer는 claim token을 실행 processor에 직접 전달하고 DB 실행 결과를 기다린 뒤 반환한다. 성공 effect의 증거는 PostgreSQL `PUBLISHED`이며, 큐의 completed만으로 성공·재사용·실패를 구분하지 않는다.

2단계에는 `0011`로 activation·receipt와 usage의 동의·예산·예약 ledger를 추가했다. 명시적 활성화의 work는 owner가 일치하는 reservation을 참조하며 모두 같은 commit으로 저장한다. 기존 0~1단계 work를 보존하기 위해 reservation 참조는 nullable이지만 새 활성화는 예약 없는 work를 만들지 않는다. API와 repair는 fail-fast producer(`enableOfflineQueue: false`, 유한 timeout), consumer는 BullMQ가 요구하는 재연결용 `maxRetriesPerRequest: null` 연결을 각각 소유한다. Redis I/O는 DB transaction 밖에서 수행한다.

활성화 API는 preview에서 받은 current revision과 consent epoch·config fingerprint를 다시 검사하고 최대 20개 자료만 받는다. 같은 owner/request ID의 동일 입력은 receipt를 반환하며 바뀐 입력은 충돌한다. 일반 활성화는 기존 work를 재생성하지 않으며 `retryFailed`를 명시한 새 요청만 실패·폐기된 현재 자료의 새 generation을 만든다. active/published work는 중복 생성하지 않는다. 철회 후 activation 행이 남아도 consent epoch가 달라 유효하지 않다. 승인 설정·동의·예산이 없으면 활성화를 거부한다.

### 3단계 — provider 없는 실행·복구

3단계는 `startAttempt`, `failAttempt`, `heartbeat`, `recover`와 worker 전용 repair를 provider 없이 구현·검증한 범위다. `0012`의 attempt identity·번호·lease token·STARTED 시각을 보존하고 종료 결과·시각만 확정한다. 당시 제품 fingerprint는 비어 있었고 합성 설정으로만 검증했다. 후속 실제 설정·호출은 ADR-0008의 별도 승인 정책을 따른다.

- `LEASED → CALLING`은 동일 owner/current material/intent/config/consent/reservation과 살아 있는 lease token을 확인한 짧은 transaction에서 attempt count 증가·STARTED·예약 노출을 함께 commit한다. commit 뒤에만 외부 호출자가 provider를 실행할 수 있다. 이번 단계에는 실제 호출자가 연결되지 않는다.
- worker의 materials·usage-retention 공개 Service와 indexing Repository가 같은 named CLS transaction에 참여한다. 잠금 순서는 ADR-0002를 따르고, 만료·lease 판정은 잠금 대기 뒤 DB 현재 시각을 사용한다. 애플리케이션·Redis 시계나 process memory를 권위로 삼지 않는다.
- `failAttempt`는 해당 work/attempt/token과 유효 lease에만 적용한다. 만료·다른 token·완료 attempt의 늦은 결과는 무시하고 새 attempt나 terminal 결과를 덮지 않는다. heartbeat도 같은 살아 있는 token만 60초 lease를 갱신한다.
- 다른 fence가 유효한 만료 LEASED는 호출 시도가 없으므로 attempt를 늘리지 않고 PENDING으로 돌린다. 같은 조건의 만료 CALLING은 STARTED attempt를 `UNKNOWN`으로 종료하고 아래 재시도 상한에 따라 RETRY_WAIT 또는 FINAL_FAILED로 옮긴다. 예약의 노출 기록은 지우지 않는다.
- 수정·삭제, 동의 철회/epoch 변경, 설정 불일치는 OBSOLETE로 끝낸다. 예약 부재·만료는 새 호출을 막고 FINAL_FAILED로 끝낸다. terminal work를 복구하거나 새 generation을 자동 생성하지 않는다. 예약 정산·공유 batch 해제는 ADR-0008의 별도 책임이다.

consumer 종료는 새 claim을 중단하고 진행 중 provider 호출을 AbortSignal로 취소한다. claim/실행/Redis ack에 최대 5초를 기다린 뒤 큐 연결을 닫는다. 이는 consumer 대기 상한이며 앱 전체 DB transaction·Pool 종료가 항상 5초 안에 끝난다는 보장이 아니다. 남은 PostgreSQL lease와 attempt는 다음 실행에서 복구한다.

Redis 최초 연결에 실패한 상태에서도 종료할 수 있어야 한다. 종료 신호 이후에는 consumer와 BullMQ blocking 연결의 재연결 정책이 다음 실패를 `end`로 끝내도록 한다. 소켓이 없는 재연결 대기 중 `disconnect()`만 호출하면 준비 완료를 기다리는 promise가 풀리지 않을 수 있으므로, 평상시 기본 재연결 정책은 보존하되 종료 시 재연결을 계속하지 않는다.

아래 상태도와 publication·명시적 재시도는 최종 계약을 포함한다. 3단계의 실제 검증 결과와 미구현 범위는 [작업 기록](../plans/2026-09-22-phase2-recovery.md)을 따르며 Phase 2 전체 완료와 구분한다.

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

2026-10-01의 4-a는 `completeAttempt`와 성공 게시 transaction을 구현했다. 같은 work/attempt/token·유효 lease·config와 current/consent/reservation 조건을 확인하고, 모든 chunk vector·`PUBLISHED`·`SUCCEEDED`·비용 receipt 및 공유 예약 정산을 한 commit으로 확정한다. 이미 terminal인 work의 중복 성공 응답은 무시한다. 게시 조건이 깨져도 받은 usage는 기록하며, 사용량 없는 실패·만료 시도가 포함된 예약은 마지막 work 종료 시 전체 상한으로 정산한다. 현재 consumer는 이 경로에 transaction 밖 Gemini 호출을 연결한다.

retryable network timeout과 provider 5xx는 최초 실행을 포함해 최대 5회 시도한다. Gemini 무료 429는 자동 재시도하지 않고 `FINAL_FAILED`로 종료해 사용자의 명시적 재시도를 기다린다. 각 일시 실패 뒤 full-jitter delay 상한은 `min(5초 × 2^(실패횟수-1), 60초)`이며 PostgreSQL `next_attempt_at`이 권위다. malformed response와 dimension mismatch 같은 영구 오류도 `FINAL_FAILED`, revoked consent, deleted/non-current revision과 config fence 불일치는 `OBSOLETE`다. 마지막 retryable 실패는 `FINAL_FAILED`와 정제된 실패 분류를 기록한다.

BullMQ의 attempts/backoff는 delivery 효율을 위한 보조 장치다. attempt 번호, eligibility, terminal 결과와 publication은 PostgreSQL만 판정한다. job 성공 ack가 PostgreSQL publication보다 먼저 일어날 수 없게 processor는 DB transition 결과 뒤 반환한다. ack가 유실되어 재실행되어도 terminal receipt가 no-op을 만든다.

2026-10-06에는 lease 소유 확인·fence 실패·재시도 결정을 순수 policy로 분리하고, 영구 키 권한 오류를 `access_denied`로 기록한다. HTTP 401/403을 `invalid_response`로 위장하지 않으며 자동 재시도하지 않는다. timeout/취소는 provider 수신 여부를 확정할 수 없는 경우 `unknown_outcome`으로 보수 처리한다. `timeout`이라는 DB 분류가 존재한다는 이유만으로 모든 취소를 호출 전 실패로 판정하지 않는다.

### Repair와 장애 복구

repair scanner는 bounded batch와 DB clock cursor로 다음을 찾는다.

- 유효한 current semantic activation receipt가 work 생성을 요구하지만 해당 intent/config/consent epoch work가 없는 항목
- `PENDING`/`RETRY_WAIT`이고 enqueue evidence가 없거나 오래된 항목
- lease가 만료된 non-terminal work
- enqueue/publish 응답이 모호하고 PostgreSQL terminal receipt가 없는 항목

scanner는 row를 claim/commit한 뒤에만 Redis I/O를 하고 deterministic job ID로 재enqueue한다. Redis call 동안 DB transaction이나 lock을 유지하지 않는다. concurrent scanner는 `SKIP LOCKED`, lease token과 CAS로 중복 effect를 막는다. Redis 유실/restore 후에도 committed intent와 non-terminal PostgreSQL state에서 복구한다. `PUBLISHED`, `FINAL_FAILED`, `OBSOLETE`는 자동 repair 대상이 아니다.

3단계의 구현은 **이미 commit된 non-terminal work의 전달·lease 복구**까지다. scanner는 한 회차에 최대 20개를 `FOR UPDATE SKIP LOCKED`로 선점하고 `delivery_after`를 DB 시각 기준 15초 뒤로 옮겨 commit한다. 같은 프로세스의 회차는 겹치지 않으며 15초마다 다음 batch를 확인한다. 그 뒤 개별 work의 owner/fence와 DB `next_attempt_at`을 검사하고 PENDING만 전달한다. 개별 work의 DB 오류는 정제한 뒤 다음 항목을 처리한다. Redis가 끊기면 해당 회차의 나머지 전송을 중단하고 다음 선점 시각에 재개해 항목마다 같은 timeout을 반복하지 않는다.

같은 job ID의 완료/실패 메시지가 Redis에 남아 있으면 단순 `add`만으로는 다시 대기열에 들어가지 않는다. API와 repair producer는 이 경우 BullMQ의 `job.retry(terminalState)`를 사용해 terminal 상태를 원자적으로 재대기열화한다. `remove` 후 `add` 사이의 경쟁 창을 만들거나 waiting/active 메시지를 제거하지 않는다. 여러 scanner의 중복 전달은 PostgreSQL claim CAS가 판정한다. PostgreSQL의 terminal work를 Redis 재전달만으로 되살리지 않는다.

### 제품 연결·재사용·lifecycle

`EmbeddingProcessorService`는 claim에서 받은 token으로 재사용을 먼저 확인한다. 같은 owner·material·config·consent의 현재 chunk 전부에 동일한 입력의 이전 vector가 있을 때만 새 chunk identity로 한 번에 게시하고 provider/attempt/노출은 0건이다. 일부만 재사용 가능하면 현재 본문 전체를 호출한다. 계정 간 cache나 질의 vector cache는 만들지 않는다.

재사용할 수 없으면 STARTED·예약 노출을 commit하고 호출 직전 fence를 다시 확인한 뒤 Gemini HTTP를 transaction 밖에서 실행한다. 호출 timeout은 20초로 60초 lease보다 짧으며 provider 내부 자동 retry는 없다. 실제 응답은 `completeAttempt`, 분류된 호출 실패는 `failAttempt`에 전달한다. 게시 DB 오류를 provider 실패로 오인해 즉시 다시 호출하지 않는다.

활성화의 `enabled_at`은 같은 config/epoch에서 보존한다. lifecycle scanner는 유효 활성화 owner를 최대 20개 선점하고 owner마다 현재 intent를 최대 20개 처리한다. 기본 범위는 **활성화 이후 저장·수정한 자료**이며 이전 미선택 자료를 자동 전송하지 않는다. 2026-10-13 승인에 따라 화면에서 기존 자료까지 자동 준비를 켜면 `includeExisting: true`를 activation에 저장하고 기존 current intent도 같은 동의·자료·예산 검사로 처리한다. 빈 자료함에서도 켤 수 있고 이후 첫 저장부터 처리한다. `0021` migration은 기존 activation에 `false`를 부여해 이미 승인받은 전송 범위를 넓히지 않는다. 전체 범위로 전환할 때 cursor를 초기화하되 같은 identity의 terminal work는 자동 부활시키지 않는다. DB cursor로 앞쪽 자료·예산 부족 항목이 전체 검사를 막지 않게 한다. Redis 전달은 commit 뒤 repair가 맡는다.

vector 정리는 한 회차 최대 100개를 선점해 삭제·동의·config·현재 본문 재사용 조건을 확인한다. 상세 attempt/usage 보존 정리도 bounded 처리하며 90일 이후 최소 work identity를 남기는 기준은 ADR-0008을 따른다. scanner가 가동되지 않은 시간을 물리 삭제 완료로 계산하지 않는다.

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

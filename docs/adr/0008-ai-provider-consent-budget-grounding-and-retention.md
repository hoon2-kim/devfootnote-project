# ADR-0008: AI provider 동의, 예산, grounding과 보존

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-13 — answer admission의 인증 입력을 검증된 access JWT owner로 정렬; AI 동의·게시·정산 계약은 유지
- Canonical owner: 외부 AI 호출 admission, 답변 choreography, 비용 정산, citation과 AI 데이터 보존

## Context

devfootnote의 embedding과 근거 답변은 선택 기능이다. 사용자의 원문과 메모를 외부 provider에 전송할 수 있으므로 명시적 동의와 비용 상한이 선행되어야 한다. network call을 DB transaction 안에서 수행하면 lock과 재시도 위험이 커지고, 반대로 호출 전후의 durable 상태가 없으면 consent 철회, revision 변경, 삭제, timeout과 중복 delivery 사이에서 stale 답변 게시 또는 이중 과금이 생긴다.

자료 저장, 현재 keyword 검색과 원문 읽기는 provider, consent, Redis와 무관하게 동작한다. embedding은 indexing owner의 비동기 기능이며, 이 ADR은 `answers`가 `usage-retention`과 협력하는 답변 workflow 및 두 AI 기능에 공통인 provider/privacy gate를 정한다. provider, model, model version, embedding dimension과 가격은 도입 직전 평가까지 선택하지 않는다.

## Decision Drivers

1. 동의하지 않았거나 예산이 없는 경우 외부 호출을 0건으로 만든다.
2. provider latency 중 DB transaction을 열어 두지 않는다.
3. 현재 owner/revision/evidence에 grounded된 답변만 citation과 함께 게시한다.
4. duplicate, late result, crash와 철회 경쟁에서 게시·정산을 exactly-once 효과로 만든다.
5. content와 provider payload를 telemetry에서 배제하고 보존·삭제를 실행 가능하게 한다.

## Decision

### 기능과 provider 경계

AI는 두 가지 좁은 port만 가진다.

- embedding port: 현재 revision의 승인된 chunk 또는 사용자가 방금 입력한 검색 질의를 벡터로 변환한다. chunk vector publication과 fence는 indexing module이 소유한다. query embedding은 `search`가 owner-scoped query command 안에서 요청하지만 consent·budget admission과 settlement는 `usage-retention` public port를 통과하며 질의 원문은 durable usage나 telemetry에 저장하지 않는다.
- grounded generation port: committed evidence snapshot과 제한된 instruction으로 answer candidate를 반환한다.

provider adapter는 domain entity, repository 또는 transaction handle을 받지 않는다. 호출 입력은 최소한의 normalized content, request/model configuration, timeout/cancellation 정보뿐이다. provider가 반환한 자유형 citation이나 URL을 권위로 사용하지 않는다. exact provider/model/version/dimension은 문서 단계에서는 선택하지 않지만 **첫 실제 chunk/query embedding 또는 answer 호출 전에** 품질·privacy·단위 가격 evidence와 별도 승인을 거쳐 고정한다. 승인된 fingerprint, purpose consent와 budget reservation이 없으면 호출은 0건이며 기본 fallback provider를 두지 않는다.

### 동의

외부 전송은 기본 off다. `usage-retention`은 owner별, purpose(`embedding` 또는 `grounded-answer`), policy version, consent epoch, granted/revoked timestamp를 소유한다. UI는 전송되는 데이터 범주, 목적, provider가 정해진 뒤 provider, 보존 정책, 철회 영향과 비용 한도를 설명하고 affirmative action을 받아야 한다. bundle consent, pre-checked control과 저장만으로 묵시적 동의를 얻지 않는다.

모든 pre-call admission은 현재 consent와 동일한 `consentEpoch`를 durable request/reservation에 기록한다. 철회는 epoch를 증가시키고 새 예약·호출을 막으며 queued-but-not-started work를 취소 대상으로 만든다. 이미 network로 전송된 데이터를 회수할 수 없다는 사실은 UI에 설명하되, 늦은 결과의 publication은 fence로 차단한다. 재동의는 새 epoch이며 과거 work를 되살리지 않는다.

### 예산

`usage-retention`은 configuration별 월/기간 비용 한도와 reservation ledger를 소유한다. budget 계산은 settled usage와 아직 만료되지 않은 reservation의 보수적 최대 비용을 포함한다. 단순 client counter나 provider dashboard는 admission authority가 아니다.

예약은 `reservationId`, owner, purpose, request fingerprint, consent epoch, pricing snapshot/version, reserved maximum, currency/base unit, `expiresAt`, 상태(`reserved|settled|released|expired`)를 갖는다. 동일 request fingerprint/idempotency key의 반복은 기존 예약을 반환하거나 하나만 만들며, unique constraint와 transaction으로 `spent + active reservations + requestedMax <= configuredBudget`를 보장한다. 예산 부족, 미동의, 가격 정보 없음은 provider 호출 전에 종료하므로 provider call count는 0이다.

정산은 provider의 검증 가능한 usage를 pricing snapshot에 적용하되 reservation 상한 초과 정책을 사전에 고정한다. 신뢰 가능한 usage가 없으면 예약 상한을 정산하는 보수적 정책 또는 실패 처리 중 하나를 provider 도입 ADR에서 선택해야 한다. credit/free tier는 budget 여유로 간주하지 않는다. duplicate settlement는 reservation identity의 unique terminal transition으로 비용을 한 번만 반영한다.

### 답변 transaction choreography

`answers` application workflow 하나가 public port만 호출하며 다른 module의 private repository에 접근하지 않는다.

answer request의 authoritative state machine은 다음 하나다.

```text
REQUESTED -> RESERVED -> RUNNING -> PUBLISHED | NO_ANSWER | FAILED | EXPIRED | INVALIDATED
```

`REQUESTED → RESERVED`는 snapshot+reservation commit, `RESERVED → RUNNING`은 call-attempt `STARTED` commit이다. Provider 호출과 게시 시도는 `RUNNING`에서만 가능하고 `PUBLISHED`/`NO_ANSWER`는 `RUNNING`에서만 전이한다. 모든 terminal state는 CAS 이후 되돌리지 않으며 retry는 같은 logical request 안에 새 call-attempt만 추가한다.

#### 1. Pre-call committed phase

짧은 application-owned transaction에서 다음을 모두 성공시키거나 모두 실패시킨다.

1. access JWT로 검증한 owner와 명시적 answer command/idempotency를 검증한다. 다른 feature의 identity 저장소에 접근하거나 provider 호출 중 refresh 상태를 재검사하지 않는다.
2. 현재 material/revision, 삭제 여부, indexing readiness와 search filter를 통해 evidence chunk를 선택한다.
3. evidence ID, material ID, revision ID, immutable content hash와 인용 가능한 locator의 snapshot을 answer request에 저장한다.
4. current consent epoch를 확인한다.
5. 같은 request identity와 epoch로 budget reservation을 만든다.
6. request를 `RESERVED`로 표시하고 expiry/fingerprint를 기록한다.

여러 module의 상태는 `answers`에 노출된 snapshot port와 `usage-retention` reservation port를 통해 협력한다. repository handle 공유나 storage trigger가 workflow를 소유하지 않는다. 분산 transaction으로 가장하지 않으며, application transaction manager가 참여 port의 PostgreSQL transaction을 명시적으로 조합한다. 어느 단계든 실패하면 request와 reservation의 부분 상태를 남기지 않는다.

#### 2. Provider claim과 call phase

pre-call commit 뒤 worker는 짧은 claim transaction에서 `RESERVED → RUNNING`을 CAS하고 `callAttemptId`, attempt number, provider request fingerprint, pricing snapshot, DB-clock `startedAt`, 상태 `STARTED`를 immutable하게 기록한다. 이 commit 전 장애는 호출 전 실패로 확정할 수 있다. commit 뒤 provider를 호출하며 이 동안 PostgreSQL transaction이나 row lock을 열어 두지 않는다. DB commit과 외부 network 수신은 원자화할 수 없으므로 `RUNNING/STARTED` 뒤 crash·timeout은 실제 호출 또는 비용 발생 가능성이 있는 불명 상태로 취급한다.

input은 committed snapshot의 필요한 evidence만 포함하고 request ID와 secret은 provider prompt에 넣지 않는다. timeout, cancellation, 429와 malformed response는 bounded retry 정책을 따르되 각 실제 시도는 별도 call-attempt와 비용 exposure로 기록한다. retry가 새 reservation이나 새 logical request를 만들지 않는다.

#### 3. Fenced publish phase

provider candidate를 받은 뒤 새 짧은 transaction에서 다음 fence를 모두 다시 검증한다.

- owner와 answer request/reservation identity 일치
- request가 아직 publish 가능한 `RUNNING` 상태이고 만료되지 않음
- reservation이 active이고 같은 consent epoch이며 미정산
- 현재 consent가 철회/epoch 변경되지 않음
- 모든 evidence material이 삭제되지 않았고 snapshot revision이 여전히 current
- content hash와 locator가 snapshot과 일치
- candidate citation이 snapshot evidence allowlist에만 매핑되고 answer의 사실 claim이 citation 없는 임의 근거를 만들지 않음

publication과 settlement는 서로 다른 판정이다.

1. publication fence가 모두 통과하면 answer와 server-generated citation mapping을 게시하고 request를 `PUBLISHED` 또는 `NO_ANSWER`로 전이한다. 실패하면 answer를 게시하지 않고 `INVALIDATED`, `EXPIRED` 또는 `FAILED`로 전이한다.
2. `usage-retention`은 publication 결과와 무관하게 call-attempt exposure를 판정한다. provider가 수신하지 않았음이 확정된 호출 전 실패만 reservation을 release한다. 검증 가능한 usage는 실제 금액으로, `RUNNING/STARTED` 뒤 결과 불명은 사전 승인된 provider별 보수 정책으로 정산한다.
3. request terminal CAS와 reservation terminal CAS는 각각 exactly-once이며 동일 result 재전달은 저장된 결과를 반환하고 answer/citation/usage를 중복 생성하지 않는다.

PostgreSQL commit만 publication 및 settlement effect의 증거다. provider 성공이나 BullMQ completion은 증거가 아니다.

### Abandonment, crash와 compensation

- pre-call commit 전 crash: durable request/reservation 없음, provider 호출 없음.
- pre-call commit 뒤 `RESERVED`이고 call-attempt가 없는 상태의 crash: expiry sweeper가 reservation을 release하고 request를 `EXPIRED`로 만든다.
- claim commit으로 `RUNNING/STARTED`가 된 뒤 network 호출 전·중 crash 또는 timeout/결과 불명: 호출 가능성을 부정할 수 없으므로 attempt evidence를 유지하고 provider별 보수 정산 정책을 적용한다. 무조건 무료로 release하지 않는다.
- provider 성공 후 publish 전 crash: 동일 request/reservation으로 재개하거나 만료 compensation한다. 새 logical 호출은 fence와 정책 없이 만들지 않는다.
- consent 철회, material edit/delete, evidence expiry와 late result: publication은 거부하되, 이미 발생했거나 `RUNNING/STARTED` 때문에 발생 가능성을 배제할 수 없는 비용은 provider별 exposure 정책으로 exactly-once 정산한다.
- duplicate worker/result: terminal compare-and-set에서 no-op; 추가 charge 없음.

sweeper는 `expiresAt`과 DB server time을 기준으로 barrier 이후 claim하고 `SKIP LOCKED`/lease와 terminal CAS를 사용한다. sleep 순서에 기대지 않는다. cleanup 자체도 idempotent하다.

### Grounding과 citation

answer는 snapshot의 evidence만 사용하며 citation 없는 일반 지식 답변을 허용하지 않는다. 최소 근거가 없거나 서로 충돌해 안전하게 답할 수 없으면 `insufficient-evidence` 결과를 게시하고 생성형 답변을 꾸미지 않는다. citation은 answer span/claim에서 `evidenceId`로 연결되며 material/revision/chunk/locator와 content hash를 server가 매핑한다. UI에서 citation은 [자료 읽기](0006-frontend-information-architecture-and-design.md)의 현재 근거로 이동한다.

provider 출력은 untrusted input이다. schema, 최대 길이, citation allowlist, unsafe Markdown을 검증하고 sanitize한다. provider가 제안한 hidden instruction, URL, script, raw HTML 또는 snapshot 밖 source는 폐기한다. 품질 평가 계약은 [ADR-0009](0009-verification-observability-and-search-evaluation.md)이 소유한다.

### Idempotent 결과 재조회

answer request의 logical identity는 authenticated owner, client request ID와 canonical input fingerprint의 조합이다. 같은 owner·request ID·fingerprint가 재전송되면 새 reservation이나 provider call을 만들지 않는다. 저장된 `PUBLISHED`/`NO_ANSWER` 결과가 아직 접근 가능하고 snapshot revision이 current이며 material이 미삭제이고 consent epoch와 answer expiry가 유효하면 그 결과를 그대로 반환한다. 같은 request ID의 다른 fingerprint는 conflict다. 저장 결과가 stale, deleted, revoked 또는 expired면 본문을 노출하지 않고 해당 terminal 사유를 반환하며 같은 ID로 새 호출하지 않는다.

### 보존과 삭제

`usage-retention`은 consent/budget/usage의 최소 audit row를, `answers`는 request/evidence snapshot/answer/citation lifecycle을 소유한다. 구체적인 day 수는 각 AI purpose의 provider 조건과 운영 필요를 확인해 **그 purpose의 첫 실제 provider 통합·호출 전에** configuration으로 고정한다. 이 결정은 provider를 사용하지 않는 Phase 1 저장·keyword 검색·읽기 scaffold를 막지 않는다. 다음 원칙은 즉시 적용한다.

- raw provider request/response를 durable debug evidence로 보존하지 않는다.
- answer body와 citation은 사용자가 보는 제품 data이며 설정된 짧은 product retention 또는 material 삭제까지 보존한다.
- request fingerprint, terminal outcome, provider-call/settlement identity로 구성된 content-free dedupe receipt는 answer body보다 긴 별도 기간 유지해 응답 유실·만료 뒤 중복 호출과 이중 정산을 막는다. `dedupeExpiresAt`은 항상 `answerExpiresAt`보다 늦어야 하며, receipt가 남아 있는 동안 같은 ID의 같은 입력은 새 호출 없이 만료 결과를, 다른 입력은 conflict를 반환한다.
- evidence snapshot content는 publication/recovery에 필요한 최소 기간만 보존하고 가능하면 ID/hash/locator로 최소화한다.
- usage ledger는 원문·prompt 없이 purpose, model/pricing version, token/단위 count, 금액, timestamp와 outcome만 보존한다.
- material 삭제 또는 owner cleanup은 새 호출을 즉시 차단하고 queued work를 취소하며 answer/citation/snapshot을 dependency 순서로 삭제 또는 접근 불가 처리한다. 보존 의무가 있는 비용 row는 content linkage를 제거한다.
- provider-side retention/deletion capability와 private-data training 조건은 provider 선택 gate의 필수 evidence다.

### Telemetry exclusion

log, trace, metric, error reporting과 durable debug artifact에는 사용자 원문/메모/chunk, search query, prompt, answer text, citation excerpt, raw provider request/response, provider nested error body, cookie, token, OIDC claim, API key와 secret을 기록하지 않는다. metric label에는 owner/material/request/provider request ID를 넣지 않는다. bounded 값인 component, purpose, outcome, error class, model/pricing config version, retry count와 금액 bucket만 허용한다. correlation이 필요하면 별도 telemetry key로 만든 environment-scoped pseudonym을 structured log/trace에만 사용한다.

## Considered Options

1. **durable pre-call reservation/snapshot, transaction 밖 provider, fenced publish/settlement** — 선택.
2. provider 호출을 하나의 DB transaction 안에서 수행 — lock·timeout 때문에 기각.
3. 호출 뒤 비용을 best-effort 기록 — crash/중복에서 예산을 초과하므로 기각.
4. provider citation과 URL을 그대로 게시 — grounding 권위를 provider에 넘겨 기각.
5. AI를 저장·검색의 필수 경로로 둠 — graceful degradation을 깨므로 기각.

## Consequences

- 답변 경로는 pre-call, call-claim, post-call의 세 짧은 transaction과 그 사이의 transaction 밖 provider call 및 compensation 상태로 복잡해지지만 stale publication과 double charge를 막는다.
- 동의나 예산이 없을 때 core 제품은 계속 동작한다.
- provider/model을 지금 고르지 않아도 adapter, privacy와 evidence gate는 고정된다.
- exact retention 기간과 가격 정책은 provider 도입 전에 반드시 결정되어야 하며 조용한 기본값은 없다.

## Verification contract

실제 PostgreSQL integration에서 snapshot+reservation all-or-none, unique reservation, concurrent budget race, consent epoch race, edit/delete race, expiry/settlement CAS와 duplicate result를 deterministic barrier로 검증한다. fake provider는 timeout, 429, malformed schema, unknown outcome, citation escape와 crash window의 제어에만 사용하며 semantic 품질 증거로 쓰지 않는다. 미동의·budget exhausted·가격 없음에서는 provider spy가 0 call임을 검증한다. redaction fixture는 nested error를 포함해 금지 content가 log/trace/metric/debug artifact에 0건임을 검사한다.

## Revisit triggers

provider/model 도입, 법적 보존 조건 변경, multi-owner 또는 billing 도입, 혹은 PostgreSQL 단일 transaction으로 public ports를 조합할 수 없는 topology가 승인될 때 재검토한다.

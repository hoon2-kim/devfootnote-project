# ADR-0002: 모듈러 모놀리스 도메인 소유권과 public port

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-15 — Drizzle ORM/Kit과 feature-private schema·DB provider로 정렬; 공개 Module/Service·상태 소유권·DAG·transaction/fence 계약은 유지
- Canonical owner: 여섯 feature의 상태·전이 소유권, 내부 의존 DAG, public choreography

## Context

devfootnote의 저장은 revision, chunk, keyword projection, idempotency와 embedding intent를 동시에 만든다. 비동기 indexing과 선택적 답변 생성은 여러 도메인의 사실을 참조한다. 단순히 “PostgreSQL transaction이 소유한다”고 하면 application owner가 사라지고, coordinator가 여러 private repository를 직접 쓰게 된다. 모든 상태와 전이는 정확히 한 feature가 소유해야 하며 협력은 public port로만 수행해야 한다.

## Decision

backend는 **기능별 모듈러 모놀리스와 간단한 계층형 구조**를 사용한다. Nest Module은 주입과 공개 범위를 조립하고, Service는 업무 흐름·transaction 경계·상태 전이를 소유하며, Repository는 해당 feature 소유 table의 저장 처리를 맡는다. 작은 기능에 Repository가 이름만 바꾼 전달 계층이 되면 내부 DB token으로 Drizzle 인스턴스를 주입받아 Service 안에서 자기 table을 직접 조회·저장할 수 있다. revision 판정·상태 전이처럼 순수하게 검증할 규칙만 필요에 따라 함수나 policy 파일로 분리한다. 모든 기능에 `domain/application/infrastructure`, CRUD별 UseCase 또는 interface/implementation 쌍을 만들지 않는다.

Drizzle table·relation은 각 feature의 private `*.schema.ts`가 정의하고 상태 전이의 소유권은 아래 여섯 feature로 유지한다. Drizzle Kit가 여러 schema를 수집해 하나의 SQL migration stream을 만든다는 이유로 다른 feature의 table/relation을 조회·수정하지 않는다. 그런 사실이 필요하면 상대 feature의 공개 업무 메서드로 요청한다. schema 수집은 DDL metadata 조합일 뿐이며 table·추론한 row type을 HTTP DTO나 frontend와 공유하지 않는다.

**public port는 공개 업무 API라는 의미다.** 다음 표의 이름은 행동 계약이며 각각의 추상 interface나 독립 class를 요구하지 않는다. 예를 들어 `SaveMaterial`은 공개 `MaterialsService.saveMaterial()`로 구현할 수 있고 Nest Module이 그 Service를 export할 수 있다. 앱과 다른 feature는 root public entry를 통해 그 메서드를 호출한다. 공개 Service는 승인된 업무 메서드와 필요한 값·결과·error 계약만 노출하고 내부 helper·Repository·schema/row type·DB token·Pool/query-builder handle은 노출하지 않는다. 범용 `execute(command)` dispatcher나 상속 기반 CRUD 틀은 추가하지 않는다.

다음 표는 `packages/backend`의 **최종 허용 feature owner registry**다. 각 feature는 해당 vertical slice가 처음 필요로 할 때만 추가하며, 단계별 구현은 이 여섯 owner와 허용 edge의 부분집합이다. 사용되지 않는 빈 module을 처음부터 만들지 않는다.

| Feature owner | 단독 소유 상태와 전이 | Public port |
|---|---|---|
| `identity` | OIDC admission, owner account, pre-auth transaction, access JWT 발급·검증, 현재 refresh JWT 해시·고정 만료·회전·철회 | `BeginLogin`, `CompleteOidcCallback`, `RequireAccessToken`, `RefreshTokens`, `RevokeRefreshToken` |
| `materials` | material create/update/delete, current revision, revision/chunk/keyword projection, idempotency receipt, immutable embedding intent | `SaveMaterial`, `UpdateMaterial`, `DeleteMaterial`, `ReadCurrentMaterial`, `CheckRevisionFence`, `ListCurrentEmbeddingIntents` |
| `indexing` | activation receipt, config/consent별 work 생성, delivery, lease/attempt/retry/terminal/repair, embedding 실행과 vector publication | `ActivateCurrentEmbeddings`, `RetryCurrentEmbedding`, `DeliverIntent`, `ClaimEmbeddingWork`, `RecordAttempt`, `PublishEmbedding`, `RepairEmbeddingDelivery` |
| `search` | keyword/vector/hybrid query 계획, filter와 dedupe 결과 | `SearchMaterials`, `SnapshotAnswerEvidence` |
| `answers` | answer request, immutable evidence snapshot, validation/citations, answer lifecycle | `GenerateAnswer`, `PublishFencedAnswer`, `ExpireAnswerRequest` |
| `usage-retention` | AI consent epoch, budget reservation/settlement/release, usage ledger, retention schedule | `CheckConsentEpoch`, `ReserveBudget`, `SettleOrReleaseReservation`, `RunRetention` |

내부 static dependency의 **완전한 허용 DAG**는 다음과 같다. 각 edge는 상대 feature의 root public export만 사용할 수 있다.

```text
answers  ──> search
answers  ──> materials
answers  ──> usage-retention
search   ──> materials
search   ──> indexing
indexing ──> materials
identity (no feature dependency)
usage-retention (no feature dependency)
materials (no feature dependency)
```

composition root가 여러 Module/Service를 조립할 수 있지만 위에 없는 feature import를 만들지 않는다. 각 feature Module은 backend 내부 DatabaseModule과 token 기반 provider를 통해 프로세스당 하나인 bounded `pg.Pool`과 Drizzle 인스턴스를 공유한다. 같은 feature의 Service는 자기 Repository 또는 자기 소유 table에 대한 Drizzle query를 사용할 수 있다. 원자 작업은 동일한 명시적 `db.transaction(async (tx) => ...)`의 `tx`로 수행하며 callback 안에서 기본 `db`, `pool.query`나 별도 transaction으로 빠져나가지 않는다. 이 허용은 다른 feature의 table 접근이나 transaction 우회 허용이 아니다. API controller·worker processor가 Pool/Drizzle DB를 직접 주입받거나 생성하지 않는다.

pgvector·keyword 랭킹·잠금/CAS 등은 Drizzle의 typed API를 우선 사용하고, 정확히 표현하기 어려운 구간만 해당 table owner의 Repository 안에서 목적별 parameterized `sql` template·`tx.execute`로 보완한다. SQL을 feature 경계 우회나 범용 실행 port로 공개하지 않는다. 원자 작업이면 ORM과 SQL 모두 동일 `tx`를 사용하고 parameterization·반환 타입 변환·실제 DB 검증은 ADR-0003을 따른다.

외부 AI처럼 장애·timeout·응답 검증을 fake provider로 통제해야 하는 구간은 좁은 호출 계약과 adapter를 사용한다. 그 필요가 없는 모든 DB·함수 호출에 outbound interface를 강제하지 않는다. infrastructure는 feature의 업무 정책을 runtime import하거나 호출하지 않는다. feature가 소유한 outbound 계약의 구현에 필요한 순수 `import type`은 허용하되, 실행 코드·Nest provider·private table schema를 끌어오는 우회로 사용하지 않는다. 검증에서는 이 type-only 계약 edge와 금지된 runtime 정책 의존을 구분한다.

BullMQ processor와 scheduler는 `apps/worker`만 등록한다. 공유 backend Module은 공개 처리 메서드와 필요한 저장·provider 연결을 제공할 뿐 import 시 consumer·주기 작업을 시작하지 않는다. API가 indexing Service를 사용해 활성화나 전달을 요청하는 것은 허용하지만 API 프로세스에서 consumer를 실행시키지 않는다. worker와 Redis 없이 API가 시작하고 PostgreSQL 기반 core 여정을 제공할 수 있어야 한다.

### 저장과 indexing choreography

1. `SaveMaterial` 또는 `UpdateMaterial`은 `materials` transaction 하나를 연다.
2. 인증 owner, request idempotency와 update의 expected-current-revision CAS를 확인한다.
3. material/new revision, 모든 chunk, keyword projection, current revision pointer, request receipt와 immutable durable embedding intent를 all-or-none으로 기록한다.
4. PostgreSQL commit이 save 성공의 유일한 동기 effect evidence다. Redis enqueue 또는 embedding을 기다리지 않는다.
5. owner에게 승인된 current semantic activation config/consent epoch가 있을 때만 commit 뒤 API가 `indexing.ActivateCurrentEmbeddings`에 새 intent ID를 best-effort로 알린다. 활성화가 없으면 immutable intent만 남고 work·enqueue·provider call은 0건이다.
6. activation transaction이 work를 commit한 뒤 `indexing.DeliverIntent` 또는 repair scanner가 그 work ID를 전달한다. `indexing`은 delivery/lease/attempt를 소유하고 provider network call을 transaction 밖에서 수행한다. publication은 owner, current revision, deletion, intent/config/consent epoch, lease token과 attempt fence를 다시 확인하는 PostgreSQL CAS로만 성공한다.

`materials`가 indexing 모양의 chunk와 intent row까지 소유하는 것은 원자 save와 AI/Redis 독립 keyword 경로를 보존하기 위한 의도적 선택이다. `indexing`은 이 row를 직접 변경하지 않는다. 필요한 사실은 immutable intent payload 또는 `CheckRevisionFence`로 받는다.

### 답변과 usage choreography

`answers.GenerateAnswer`가 유일한 answer workflow owner다. pre-call 단계는 공개 transactional port를 사용해 동일 owner와 consent epoch 아래 budget reservation identity, answer request와 immutable evidence snapshot을 일관되게 commit한다. `RESERVED` 상태에 call-attempt가 없이 남은 호출 전 실패만 `usage-retention`이 DB-clock expiry로 결정론적으로 release한다.

provider 호출 전 `answers`의 짧은 claim transaction은 request를 `RESERVED → RUNNING`으로 바꾸고 immutable call-attempt `STARTED`를 기록한다. commit 뒤 모든 DB transaction 밖에서만 provider를 호출하며 결과는 저장된 evidence 범위와 citation에 대해 검증한다. `RESERVED`에서 호출 시작 기록 없이 끝난 작업만 비용 노출 0으로 release할 수 있다.

post-call `PublishFencedAnswer`는 request 상태/만료, authenticated owner, reservation identity, consent epoch, evidence material의 current revision/deletion을 재검사한다. `answers`의 publication 결정과 `usage-retention`의 settlement 결정은 같은 짧은 transaction에 참여할 수 있지만 별도 결과다. stale/delete/revoke 때문에 publish하지 않아도 `RUNNING` 이후 실제 또는 불명확한 호출 비용은 provider별 exposure 정책으로 exactly-once 정산한다. late/duplicate 결과는 게시·정산 terminal CAS를 덮지 않는다.

### 금지된 경계

- 다른 feature의 Repository, table/relation schema, transaction implementation, 내부 provider 또는 비공개 Service 메서드 접근; 공개된 업무 Service 메서드는 위 DAG에 따라 호출할 수 있다
- public port가 Repository·DB/Pool/query-builder handle 또는 범용 SQL 실행기를 반환하는 것
- 별도 일곱 번째 save/workflow module 또는 generic coordinator가 private store를 조정하는 것
- owner가 아닌 module이 상태를 직접 수정하는 것
- provider/Redis network I/O 중 PostgreSQL transaction이나 row lock 유지
- owner/current/deleted/consent/revision fence를 adapter 또는 composition app에서 우회
- 공유 backend Module import를 통해 API 프로세스에서 worker consumer/scheduler 시작

## Ownership

이 ADR의 표가 feature와 전이 소유권의 유일한 선언이다. [ADR-0001](0001-monorepo-and-package-boundaries.md)은 workspace package 경계와 로컬 실행 구성을, [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)은 저장 표현과 transaction을, [ADR-0004](0004-bullmq-embedding-delivery-retry-and-fencing.md)은 indexing state machine을, [ADR-0005](0005-google-oidc-single-owner-and-sessions.md)은 identity protocol과 access/refresh JWT 불변식을 소유한다. 그 문서들은 owner를 재정의하지 않는다.

## Consequences

- save가 queue 장애에서도 keyword-search 가능한 current revision을 남긴다.
- indexing-shaped synchronous row를 materials가 소유하는 다소 넓은 책임을 받아들이는 대신 split transaction과 shared repository를 피한다.
- answer와 usage의 협력에는 명시적인 transaction-capable public port와 compensation이 필요하다.
- public read/fence 호출이 내부 join보다 장황하지만 소유권과 stale-result 거부를 관찰 가능하게 만든다.
- 여섯 feature graph는 acyclic이며 독립 서비스로 분리할 근거가 생기기 전까지 단일 배포 데이터 경계를 유지한다.
- Nest Module/Service와 필요한 저장 코드로 시작해 의례적인 추상 계층을 줄인다. 공개 메서드·private 저장소·transaction 소유권은 파일 수와 별개로 유지한다.

## Verification

- phase-aware architecture test가 현재 존재하는 feature와 edge가 위 registry/DAG의 부분집합이고 cycle/private deep import/repository export가 0건인지 확인한다. 모든 기능이 도입된 최종 phase에서만 정확히 여섯 feature와 완전한 허용 edge를 요구한다.
- 같은 feature 소유 table의 직접 Drizzle 사용과 공개 Service 메서드 호출은 허용하고, cross-feature private schema/relation 접근·transaction 우회·infrastructure의 runtime 정책 의존은 거부한다. migration용 schema 수집과 runtime table 접근을 구분하며 type-only outbound 계약 edge는 별도로 분류한다.
- API와 worker의 Nest composition 검증에서 consumer/scheduler는 worker에만 등록되고, API의 Redis-down bootstrap과 core HTTP 여정은 계속 동작해야 한다.
- real PostgreSQL integration은 save의 all-or-none, duplicate request receipt, expected revision race, old revision 보존과 Redis-down 성공을 검증한다.
- real PostgreSQL·Redis integration은 commit-before-delivery, duplicate/crash/late worker, deletion/new revision publication fence를 검증한다.
- answer integration은 pre-call snapshot/reservation coherence, transaction 밖 provider call, abandoned compensation, stale/duplicate post-call과 exactly-once settlement를 검증한다.
- owner A/B test identity로 모든 command/query의 owner predicate와 cross-owner denial을 확인한다. A/B identity는 production admission 경로에는 존재하지 않는다.

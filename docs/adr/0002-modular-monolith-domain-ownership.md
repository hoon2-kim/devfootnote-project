# ADR-0002: 모듈러 모놀리스 도메인 소유권과 public port

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-19 — 승인된 모듈 구조 유지, Repository 페이지·원자 저장 계약 정리
- Canonical owner: 여섯 feature의 상태·전이 소유권, 내부 의존 DAG, public choreography

## Context

devfootnote의 저장은 revision, chunk, keyword projection, idempotency와 embedding intent를 동시에 만든다. 비동기 indexing과 선택적 답변 생성은 여러 도메인의 사실을 참조한다. 단순히 “PostgreSQL transaction이 소유한다”고 하면 application owner가 사라지고, coordinator가 여러 private repository를 직접 쓰게 된다. 모든 상태와 전이는 정확히 한 feature가 소유해야 하며 협력은 public port로만 수행해야 한다.

## Decision

백엔드는 `apps/api/src/modules`의 기능별 모듈러 모놀리스다. 구조를 섞는 단위는 모듈이다. auth/search/health는 기본 레이어드, materials는 presentation → application → domain 방향의 라이트 헥사고날로 구성한다. materials infrastructure는 application 저장 포트를 구현하며 SQL·CAS·원자 저장을 소유한다. Domain은 Nest/ORM에 의존하지 않고 application은 DI를 위한 Nest 사용만 허용한다.

Controller는 HTTP, Service는 업무 규칙과 흐름, Repository는 저장 책임을 맡는다. auth의 기존 Repository와 materials의 원자 저장 구현을 유지하고 단순 조회용 search에는 별도 Repository를 만들지 않는다. search는 materials의 `findKeywordCandidates` 공개 조회로 필요한 projection을 요청한다. JOIN 최적화는 materials 저장소 안에서 수행하며 다른 모듈 schema를 가져오지 않는다.

2026-09-19 계약 정리: materials Service는 원문 준비·업무 fingerprint를 계산하고 작업별 입력 객체를 저장 포트에 전달한다. receipt UNIQUE 경쟁 판정·전체 rollback·확정 receipt 재조회는 Repository 내부 절차이며 application 포트에 `ReceiptRace`나 `readReceipt`를 노출하지 않는다. 목록·검색 후보는 공통 `PageResult<T> { items, hasNext }`를 반환한다. 다음 페이지 판정을 위한 추가 한 행은 Repository만 알고 소비자에게 넘기지 않는다. HTTP의 `page`와 기존 응답 envelope는 유지한다. 승인된 레이어드/라이트 헥사고날 선택을 변경하거나 전달용 계층을 추가하는 작업은 아니다.

외부 연동 장애 격리·복잡한 독립 규칙·복수 저장 구현이 실제로 필요해질 때 해당 모듈만 라이트 헥사고날로 승격한다. 기능마다 interface/UseCase/mapper를 의무화하지 않는다.

Drizzle table·relation은 각 feature의 private `*.schema.ts`가 정의하고 상태 전이의 소유권은 아래 여섯 feature로 유지한다. Drizzle Kit가 여러 schema를 수집해 하나의 SQL migration stream을 만든다는 이유로 다른 feature의 table/relation을 조회·수정하지 않는다. 그런 사실이 필요하면 상대 feature의 공개 업무 메서드로 요청한다. schema 수집은 DDL metadata 조합일 뿐이며 table·추론한 row type을 HTTP DTO나 frontend와 공유하지 않는다.

**public port는 공개 업무 API라는 의미다.** 다음 표의 이름은 행동 계약이며 각각의 추상 interface나 독립 class를 요구하지 않는다. 예를 들어 `SaveMaterial`은 공개 `MaterialsService.saveMaterial()`로 구현할 수 있고 Nest Module이 그 Service를 export할 수 있다. composition root와 다른 feature는 해당 모듈의 index.ts를 통해 그 메서드를 호출한다. 공개 Service는 승인된 업무 메서드와 필요한 값·결과·error 계약만 노출하고 내부 helper·Repository·schema/row type·DB token·Pool/query-builder handle은 노출하지 않는다. 범용 `execute(command)` dispatcher나 상속 기반 CRUD 틀은 추가하지 않는다.

다음 표는 업무 모듈의 **최종 허용 feature owner registry**다. 각 feature는 해당 vertical slice가 처음 필요로 할 때만 추가하며, 단계별 구현은 이 여섯 owner와 허용 edge의 부분집합이다. 사용되지 않는 빈 module을 처음부터 만들지 않는다.

| Feature owner | 단독 소유 상태와 전이 | Public port |
|---|---|---|
| `auth` | Google 계정 등록·로그인, account, OAuth state, access JWT 발급·검증, 계정별 현재 refresh JWT 해시·고정 만료·회전·철회 | `BeginLogin`, `CompleteGoogleLogin`, `RequireAccessToken`, `RefreshTokens`, `RevokeRefreshToken` |
| `materials` | material create/update/delete, current revision, revision/chunk/keyword projection, idempotency receipt, immutable embedding intent | `SaveMaterial`, `UpdateMaterial`, `DeleteMaterial`, `ReadCurrentMaterial`, `CheckRevisionFence`, `ListCurrentEmbeddingIntents` |
| `indexing` | activation receipt, config/consent별 work 생성, delivery, lease/attempt/retry/terminal/repair, embedding 실행과 vector publication | `ActivateCurrentEmbeddings`, `RetryCurrentEmbedding`, `DeliverIntent`, `ClaimEmbeddingWork`, `RecordAttempt`, `PublishEmbedding`, `RepairEmbeddingDelivery` |
| `search` | keyword/vector/hybrid query 계획, filter와 dedupe 결과 | `SearchMaterials`, `SnapshotAnswerEvidence` |
| `answers` | answer request, immutable evidence snapshot, validation/citations, answer lifecycle | `GenerateAnswer`, `PublishFencedAnswer`, `ExpireAnswerRequest` |
| `usage-retention` | AI consent epoch, budget reservation/settlement/release, usage ledger, retention schedule | `CheckConsentEpoch`, `ReserveBudget`, `SettleOrReleaseReservation`, `RunRetention` |

내부 static dependency의 **완전한 허용 DAG**는 다음과 같다. 각 edge는 상대 feature의 index.ts 공개 export만 사용할 수 있다.

```text
answers  ──> search
answers  ──> materials
answers  ──> usage-retention
search   ──> materials
search   ──> indexing
indexing ──> materials
auth (no feature dependency)
usage-retention (no feature dependency)
materials (no feature dependency)
```

위 graph는 업무 의존이다. presentation의 인증 요청 타입·Public decorator와 공통 오류 filter는 auth/materials의 공개 index를 사용할 수 있다. health는 여섯 업무 owner에 포함되지 않는 기술 모듈이다. 각 feature Module은 내부 DatabaseModule을 통해 프로세스당 하나인 bounded `pg.Pool`과 Drizzle 인스턴스를 공유한다. Service가 규칙·실행 순서·원자 작업 범위를 소유하고, 자기 table의 query는 Service 또는 필요에 따라 분리한 Repository가 구현한다. 원자 작업은 동일한 `db.transaction(async (tx) => ...)`의 `tx`로 수행하며 기본 `db`, `pool.query`나 별도 transaction으로 빠져나가지 않는다. 현재 auth/materials 원자 쓰기는 각각의 Repository 메서드 안에서 완결한다. materials application에는 DB/tx 객체를 전달하지 않는다. Repository를 반드시 거치기 위해 token 발급 등의 업무 callback을 전달하는 구조를 새로 만들지는 않는다. 어느 방식이든 외부 network I/O와 DB handle 공개는 금지한다. 여러 public port가 참여하는 원자 작업은 같은 scoped transaction을 내부에서 사용하며 메서드별로 따로 commit하지 않는다. API controller·worker processor는 Pool/Drizzle DB를 직접 주입받거나 생성하지 않는다.

### 트랜잭션 전파 도입 기준

현재 저장이 Repository 메서드 하나에서 끝나므로 CLS는 도입하지 않는다. 여러 Repository/공개 업무 메서드의 쓰기를 한 commit으로 묶어야 하는 첫 기능에서 scoped transaction 또는 CLS를 결정한다. 읽기·멱등 receipt 재조회가 여러 번이라는 이유만으로 위반으로 판정하지 않는다. import 검사는 application의 DB/adapter 접근을 막고, 원자성 자체는 중간 실패 rollback·동시 CAS 통합 테스트로 확인한다. auth의 로그인 transaction 안 토큰 발급 callback은 기존 원자성을 보존하기 위해 유지하며 일반적인 Repository 확장 패턴으로 복제하지 않는다.

### 계층별 책임과 적용 수준

모듈별로 선택한 구조 안에서 HTTP·업무·저장 책임을 구분한다. materials의 순수 domain은 프레임워크에 독립적이며 다른 모듈에 동일한 폴더 수를 강요하지 않는다. 아래 표는 책임 배치 기준이지 기능마다 만들 클래스 목록이 아니다. 라이브러리 호출·단순 판정·결과 변환을 각각 adapter·policy·mapper로 분리하지 않는다.

| 계층 | 소유 책임 | 금지 책임 |
|---|---|---|
| API Controller·DTO | 입력 검증, Guard 연결, 업무 호출, 결과의 공개 DTO 선택, cookie·redirect·HTTP 상태 | SQL, transaction, 계정 등록·토큰 회전 규칙, 암호학 검증 알고리즘 |
| 업무 Service | 계정 등록·권한·상태 전이·실행 순서·원자 작업 요청 | Request/Response, HttpException, Swagger, 성공 envelope, 다른 feature private table |
| feature Repository (필요 시) | 복잡하거나 재사용되는 Drizzle/SQL·CAS·저장 단위 | HTTP 응답, cookie, 외부 provider 호출, 다른 feature private table |
| protocol adapter (필요 시) | 표준 client 연결과 실제 외부 실패 격리 | 라이브러리 검증 재구현, 이름만 전달하는 추상 계층 |
| Module | 실제 dependency·provider 조립 | 업무 흐름 실행이나 import 시 background 작업 시작 |

### 참고 사례의 채택 범위

[AlmondYoung 계층 규칙](https://github.com/LCNINE/almondyoung-server/blob/develop/.cursor/rules/nestjs-msa.mdc)의 Controller/Service 분리와 [공개 CLAUDE.md](https://github.com/LCNINE/almondyoung-server/blob/9def17e0ee06fe4312793b2e6f1156ecbd22c8da/CLAUDE.md)를 선택적으로 참고한다. 관련 문서·현행 명령 확인, 영향받는 검사 우선과 실제 반복 작업의 지침화는 적용한다. 반면 그 저장소의 Service 2~3줄 제한·Reader/Manager/Creator 의무 분리는 개인 규모에 맞지 않는다는 판단으로 채택하지 않는다. MSA 구성과 Error.message의 `includes` 기반 HTTP 상태 추정도 가져오지 않는다. 업무 오류는 code/kind로 구분하고 HTTP 매핑·정제는 ADR-0007을 따른다. 공개 저장소 지침을 개인 skill·전역 설정까지 확인한 근거로 사용하지 않는다.

### 데이터와 외부 호출 경계

pgvector·keyword 랭킹·잠금/CAS 등은 Drizzle의 typed API를 우선 사용하고, 정확히 표현하기 어려운 구간만 해당 table owner 내부에서 목적별 parameterized `sql` template·`tx.execute`로 보완한다. 복잡한 검색 SQL은 Repository로 분리할 이유가 되지만 단순 query까지 전달 계층을 만들 근거는 아니다. SQL을 feature 경계 우회나 범용 실행 port로 공개하지 않는다. 원자 작업이면 ORM과 SQL 모두 동일 `tx`를 사용하고 parameterization·반환 타입 변환·실제 DB 검증은 ADR-0003을 따른다.

외부 AI처럼 장애·timeout·응답 검증을 fake provider로 통제해야 하는 구간은 좁은 호출 계약과 adapter를 사용한다. 그 필요가 없는 모든 DB·함수 호출에 outbound interface를 강제하지 않는다. 공통 infrastructure는 feature의 업무 정책을 runtime import하거나 호출하지 않는다. materials 내부 infrastructure가 application 포트·domain 값/오류를 사용하는 것은 구현체의 정상 의존이다. feature가 소유한 outbound 계약의 구현에 필요한 순수 `import type`은 허용하되, 실행 코드·Nest provider·private table schema를 끌어오는 우회로 사용하지 않는다. 검증에서는 이 type-only 계약 edge와 금지된 runtime 정책 의존을 구분한다.

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

- `common`에서 feature·HTTP composition으로의 의존, feature에서 `http/` composition으로의 역방향 의존. `http/filters/GlobalExceptionFilter`만 앱 조립 책임으로 공개 feature 오류를 알고 HTTP 정책을 적용한다. 이는 결합 제거가 아닌 의도적인 중앙 조립이며, 도메인에 HTTP 상태를 넣거나 범용 오류 registry를 도입하지 않는다. indexing·answers 도입 시 매핑 소유권을 다시 검토한다.
- 다른 feature의 Repository, table/relation schema, transaction implementation, 내부 provider 또는 비공개 Service 메서드 접근; 공개된 업무 Service 메서드는 위 DAG에 따라 호출할 수 있다
- public port가 Repository·DB/Pool/query-builder handle 또는 범용 SQL 실행기를 반환하는 것
- 별도 일곱 번째 save/workflow module 또는 generic coordinator가 private store를 조정하는 것
- owner가 아닌 module이 상태를 직접 수정하는 것
- provider/Redis network I/O 중 PostgreSQL transaction이나 row lock 유지
- owner/current/deleted/consent/revision fence를 adapter 또는 composition app에서 우회
- 공유 backend Module import를 통해 API 프로세스에서 worker consumer/scheduler 시작

## Ownership

이 ADR의 표가 feature와 전이 소유권의 유일한 선언이다. [ADR-0001](0001-monorepo-and-package-boundaries.md)은 workspace package 경계와 로컬 실행 구성을, [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)은 저장 표현과 transaction을, [ADR-0004](0004-bullmq-embedding-delivery-retry-and-fencing.md)은 indexing state machine을, [ADR-0005](0005-google-login-and-sessions.md)은 Google 로그인과 access/refresh JWT 불변식을 소유한다. 그 문서들은 owner를 재정의하지 않는다.

## Consequences

- save가 queue 장애에서도 keyword-search 가능한 current revision을 남긴다.
- indexing-shaped synchronous row를 materials가 소유하는 다소 넓은 책임을 받아들이는 대신 split transaction과 shared repository를 피한다.
- answer와 usage의 협력에는 명시적인 transaction-capable public port와 compensation이 필요하다.
- public read/fence 호출이 내부 join보다 장황하지만 소유권과 stale-result 거부를 관찰 가능하게 만든다.
- 여섯 feature graph는 acyclic이며 독립 서비스로 분리할 근거가 생기기 전까지 단일 배포 데이터 경계를 유지한다.
- Nest Module/Service와 필요한 저장 코드로 시작해 의례적인 추상 계층을 줄인다. 공개 메서드·private 저장소·transaction 소유권은 파일 수와 별개로 유지한다.

## Verification

- dependency-cruiser가 현재 모듈의 공개 index·private 저장소·허용 업무 의존·순환을 검사한다. 미래 feature는 실제 slice에서 규칙과 함께 추가하며 기술 health 모듈을 업무 owner 수에 포함하지 않는다.
- auth/materials 저장소의 Drizzle 사용과 다른 모듈 공개 Service 메서드 호출은 허용한다. materials application의 DB/adapter import는 금지한다. 업무 Service의 HTTP 의존, cross-feature private schema/relation 접근·transaction 우회·infrastructure의 runtime 정책 의존은 거부한다. migration용 schema 수집과 runtime table 접근을 구분하며 type-only outbound 계약 edge는 별도로 분류한다. 파일명·클래스 개수로 계층 적용을 강제하지 않는다.
- API와 worker의 Nest composition 검증에서 consumer/scheduler는 worker에만 등록되고, API의 Redis-down bootstrap과 core HTTP 여정은 계속 동작해야 한다.
- real PostgreSQL integration은 save의 all-or-none, duplicate request receipt, expected revision race, old revision 보존과 Redis-down 성공을 검증한다.
- real PostgreSQL·Redis integration은 commit-before-delivery, duplicate/crash/late worker, deletion/new revision publication fence를 검증한다.
- answer integration은 pre-call snapshot/reservation coherence, transaction 밖 provider call, abandoned compensation, stale/duplicate post-call과 exactly-once settlement를 검증한다.
- owner A/B test identity로 모든 command/query의 owner predicate와 cross-owner denial을 확인한다. 테스트 전용 identity/bypass는 production에 존재하지 않으며 실제 Google 계정은 서로 다른 owner로 격리한다.

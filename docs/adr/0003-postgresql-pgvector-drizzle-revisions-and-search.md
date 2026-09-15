# ADR-0003: PostgreSQL·pgvector·Drizzle revision 저장과 검색

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-15 — Drizzle ORM/Kit 선택을 확정하고 Nest 연결 수명주기·명시적 transaction·migration 실행 및 DB 오류 처리 기준을 보강; refresh JWT·revision 계약 유지
- Canonical owner: 관계형 저장 표현, Drizzle schema/transaction과 SQL migration, revision과 keyword/vector 검색 불변식

## Context

devfootnote의 핵심 경로는 자료 저장, current revision keyword 검색과 원문 읽기다. 이 경로는 Redis, worker, AI provider, AI 동의와 예산 상태에 의존하면 안 된다. 동시에 비동기 embedding은 오래된 revision이나 삭제된 material을 검색 결과로 되살리지 않아야 한다. PostgreSQL을 성공과 publication의 effect evidence로 두고 Drizzle로 명시적인 transaction과 schema를, Drizzle Kit로 검토 가능한 SQL migration을 관리한다.

이 제품은 복잡한 SQL이 전반적으로 많은 서비스라기보다 동시성·transaction 경계가 중요한 서비스다. 일반 조회·저장의 구현과 schema 관리 부담을 줄이기 위해 ORM을 기본으로 사용하고, 검색·잠금처럼 실제 필요가 있는 구간만 SQL로 보완한다. 도구 선택 자체를 검색 성능이나 정합성의 증거로 주장하지 않는다.

Drizzle 선택 근거는 기존 ORM 경험이나 이력서상의 희소성이 아니라, immutable revision/chunk 일괄 저장·조건부 상태 갱신·keyword/vector 순위 조합을 SQL에 가까운 같은 API로 표현할 수 있다는 점이다. TypeORM·MikroORM·Prisma로 구현할 수 없다는 판단이 아니며, 이 제품에서는 객체 변경 추적·관계 그래프 저장보다 명시적 SQL과 transaction 제어를 우선한다. 프론트와 DB schema를 공유하기 위한 선택도 아니다. 프론트 계약은 ADR-0007의 OpenAPI 생성 client로 유지한다.

## Decision

PostgreSQL과 `pg` connection pool, `drizzle-orm`의 `drizzle-orm/node-postgres` adapter, `drizzle-kit`을 사용한다. semantic retrieval에는 PostgreSQL의 `pgvector` extension을 사용한다. PostgreSQL major, extension, Node driver, Drizzle ORM과 Drizzle Kit의 호환 가능한 stable exact version은 승인된 scaffold에서 pin한다. 문서 예제의 floating tag나 prerelease를 그대로 채택하지 않는다. 별도 ORM/query builder를 함께 도입하거나 schema를 DB에 직접 동기화하는 `drizzle-kit push`를 사용하지 않는다.

### Nest 연결과 수명주기

backend 내부 `DatabaseModule`의 provider가 API와 worker process마다 각각 하나의 bounded `pg.Pool`과 Drizzle DB 인스턴스를 만들고 명시적인 주입 token으로 공유한다. 앱 composition root는 필요한 feature Module을 조립하되 Controller·processor에 DB handle을 노출하지 않는다. 요청·job·Repository마다 pool을 만들거나 request-scoped DB provider를 두지 않으며, Drizzle CRUD 메서드를 그대로 전달하는 별도 wrapper Service를 만들지 않는다.

pool 최대 연결 수·연결 획득 timeout과 쿼리/잠금 timeout을 유한한 값으로 설정하고 실제 부하·장애 테스트로 조정한다. 배포 시 API/worker의 모든 process·replica와 migration·관리 연결을 합산해 PostgreSQL connection budget 안에 둔다. pool의 idle-client error는 정제된 오류 분류와 health 관측으로 처리하고 원본 error를 출력하지 않는다. 불필요한 수동 client checkout을 피하며 꼭 필요하면 실패 경로까지 `finally`에서 반환한다.

SIGTERM 또는 Nest app close 시 새 요청·claim을 중단하고 진행 중 처리를 제한된 시간 안에서 drain한 뒤 lifecycle hook에서 `pool.end()`를 기다린다. 종료 유예 시간 초과는 강제 종료·lease 복구 경로로 검증하고 DB 처리가 성공한 것처럼 보고하지 않는다. API/worker bootstrap에서 Nest 종료 hook 연결을 확인하며 테스트도 app과 pool을 닫아 열린 연결을 남기지 않는다. 상세 종료·복구 검증은 ADR-0009를 따른다.

### 명시적 transaction과 조건부 갱신

transaction은 application owner가 `db.transaction(async (tx) => ...)`로 경계를 소유한다. 원자 작업에 참여하는 persistence adapter와 transactional public port는 같은 scoped `tx`/connection으로 실행되게 명시적으로 연결한다. 이 경계 안에서 전역 `db`, `pool.query` 또는 별도 transaction으로 빠져나가지 않는다. DB·transaction 타입은 선택한 driver와 schema에서 추론하며 repository/query-builder handle을 public 결과로 노출하지 않는다. AsyncLocalStorage 기반 암묵 transaction, broad untyped cast, 시작 시 자동 migration과 network call을 포함한 transaction은 금지한다.

입력 검증·결정적 chunking처럼 DB가 필요 없는 계산은 transaction 전에 수행하고, 최신 revision/권한·제약 확인은 transaction 안에서 다시 판정한다. 조건부 상태 전이는 predicate를 포함한 update와 `returning` 결과 또는 영향 행 수로 성공을 판정한다. 0건은 해당 업무 계약에 따라 stale/conflict/already-terminal 등으로 구분하며 무조건 성공으로 바꾸지 않는다. 원자 작업을 취소해야 하는 실패는 throw 또는 명시적 rollback으로 전파하고 callback 안에서 정상 return하여 앞선 쓰기가 부분 commit되지 않게 한다. pool timeout이나 deadlock을 숨기는 전역 자동 retry를 넣지 않고, retry가 필요하면 원자 작업 전체의 재실행 안전성과 한도를 해당 owner에서 검증한다.

### Schema와 쿼리 작성 범위

- 일반 CRUD, join, 조건부 update와 batch insert는 Drizzle의 typed API를 기본으로 사용한다. ORM 사용이 owner predicate, expected revision CAS, unique/FK 또는 잠금 조건을 대신하지 않는다.
- table·relation 정의와 추론한 row type은 backend persistence 내부로 제한하고 앱·프론트·feature public export에 노출하지 않는다. 각 table의 write owner는 ADR-0002 그대로다. Drizzle Kit가 schema 파일을 함께 읽는 것은 DDL 생성용 metadata 수집이며 다른 feature의 private table/repository 접근 권한이 아니다. ORM relation 편의 기능으로 public port 경계를 우회하지 않는다. 조회용 relation 선언은 DB의 FK·unique 제약을 생성하거나 대체하지 않으므로 실제 제약은 schema/migration에 명시한다.
- full-text/trigram, hybrid ranking, pgvector 또는 잠금 구문은 선택 버전의 typed API로 정확히 표현되면 그것을 사용한다. 필요한 구간에만 parameterized `sql` template이나 `tx.execute`를 사용하며, 전체 query를 raw SQL로 만들기 위한 범용 wrapper는 추가하지 않는다.
- 사용자 값은 parameter로 바인딩한다. 문자열 연결이나 `sql.raw`로 사용자 입력을 삽입하지 않고 동적 식별자는 고정 schema object 또는 서버 allowlist로 제한한다. `sql<T>`의 타입 표기는 runtime 검증·변환이 아니므로 실제 driver 반환값과 raw query 결과를 integration test로 확인한다.
- HTTP/public 결과는 필요한 column만 선택해 업무 결과 계약으로 반환하고 DB row 전체를 그대로 노출하지 않는다. timestamp·numeric·vector 등 변환이 필요한 반환값은 목적별로 명시적으로 처리하며 타입 단언만으로 맞추지 않는다.
- DB 오류는 해당 persistence 경계에서 안정적인 PostgreSQL 오류 code와 알려진 constraint를 기준으로 필요한 업무 오류로 변환한다. 모든 unique 위반을 같은 충돌로 취급하거나 원본 message 문자열을 파싱하지 않는다. Drizzle가 감싼 `cause`·SQL·parameter, PostgreSQL `detail`에는 원문·토큰 해시 등이 들어갈 수 있으므로 API 오류·운영 telemetry로 전달하지 않는다. 범용 ORM 오류 framework 대신 필요한 오류만 작은 함수로 분류한다.

### 저장 관계와 불변식

최소 관계는 다음 의미를 보존한다. 실제 이름 변경은 가능하지만 owner와 unique/FK 의미는 바꿀 수 없다.

- `accounts`: `identity` owner와 canonical `(issuer, subject)` identity
- `auth_refresh_tokens`: `identity` 소유, `owner_id` unique, 현재 refresh JWT의 SHA-256 `token_hash`, 로그인부터 고정된 `expires_at`, `created_at`. 원문 JWT, idle/last-seen과 과거 token family를 저장하지 않는다.
- `materials`: owner, metadata, nullable deletion, `current_revision_id`
- `material_revisions`: immutable revision number/content/context/source metadata와 content fingerprint
- `material_chunks`: revision에 속한 안정적 ordinal, text와 source offsets
- `material_keywords`: current 여부를 추측하지 않는 revision-scoped normalized/search projection
- `material_request_receipts`: `(owner_id, idempotency_key)` unique, request fingerprint, terminal response identity
- `embedding_intents`: immutable intent ID, owner/material/revision과 content fingerprint. AI 설정 전에도 생성할 수 있도록 provider config, consent epoch와 실행 상태를 넣지 않는다.
- indexing-owned delivery/attempt/vector publication rows는 [ADR-0004](0004-bullmq-embedding-delivery-retry-and-fencing.md)의 상태를 표현한다.

모든 material/revision/chunk/receipt/intent 관계는 owner가 일치해야 한다. composite FK 또는 transaction 검사가 cross-owner association을 거부한다. material의 `current_revision_id`는 동일 material의 revision만 가리킨다. revision과 chunk는 감사·비교를 위해 update 때 보존하지만 current pointer에 도달하지 않는 과거 revision은 기본 읽기·검색 결과에 노출하지 않는다. delete는 material을 tombstone 처리하고 current 검색/읽기와 새 publication을 즉시 차단하며, 물리 삭제와 retention은 `usage-retention` 정책이 수행한다.

`auth_refresh_tokens.owner_id`는 `accounts`를 참조하며 owner당 현재 refresh 한 개만 허용한다. refresh JWT 검증 뒤 기존 해시와 유효 만료를 조건으로 한 원자적 CAS가 정확히 한 요청에만 새 해시 교체를 허용한다. 회전은 `expires_at`과 최초 로그인 `created_at`을 연장하지 않고, 새 로그인은 두 시각과 해시를 새 로그인 기준으로 교체한다. logout은 검증된 owner의 현재 refresh row를 삭제한다. JWT 검증·cookie·logout 경쟁의 상세 계약은 [ADR-0005](0005-google-oidc-single-owner-and-sessions.md)를 따르며 다른 feature는 이 row를 직접 접근하지 않는다.

### 원자 save/update

[ADR-0002](0002-modular-monolith-domain-ownership.md)의 `materials` command가 한 Drizzle transaction의 동일한 `tx` 안에서 다음 순서를 소유한다.

1. authenticated owner와 normalized request fingerprint를 만든다.
2. 같은 `(owner_id, idempotency_key)` receipt가 있으면 fingerprint가 같을 때 기존 성공을 반환하고, 다르면 conflict로 거부한다.
3. update는 material row를 잠그고 `expectedRevisionId`가 current와 같은지 CAS한다. create도 owner 범위에서 입력 불변식을 확인한다.
4. immutable revision을 만들고 결정적 chunking 결과 전체와 revision-scoped keyword projection을 기록한다.
5. material current pointer를 새 revision으로 바꾸고 request receipt 및 provider-agnostic immutable embedding intent를 기록한다.
6. transaction commit 뒤에만 성공을 반환한다.

어느 단계든 실패하면 모든 쓰기가 rollback된다. concurrent update 중 정확히 하나만 기대 revision CAS를 통과하며 loser는 새 current나 orphan visible projection을 만들지 않는다. save 성공은 PostgreSQL receipt/current pointer로 증명하며 enqueue 상태를 응답 조건으로 사용하지 않는다.

keyword projection은 한영 혼합 원문을 보존한 normalized text와 PostgreSQL full-text/trigram 연산을 사용한다. 정확한 tokenizer 확장은 frozen evaluation과 운영 가능성 근거 없이 추가하지 않는다. keyword 결과는 embedding 준비 여부와 무관하다.

### pgvector publication과 검색

provider/model/dimension은 semantic 기능 도입 직전 평가로 선택한다. 선택 전 vector column이나 임의 차원을 고정하지 않으며, 선택 후 exact config와 dimension을 migration 및 publication fingerprint에 기록한다. 차원이 다른 vector를 암묵 변환하지 않는다. 초기 index는 정확 검색 또는 측정된 corpus에 맞는 단순 pgvector index로 시작하며 HNSW, reranker와 고급 tuning은 1k/10k corpus query-plan 근거 전에는 도입하지 않는다.

vector는 indexing-owned publication row에 revision/chunk/config fingerprint와 함께 저장되고, PostgreSQL fenced commit만 `PUBLISHED`로 만든다. BullMQ completed 상태는 vector visibility 증거가 아니다.

`search.SearchMaterials`는 모든 keyword/vector/hybrid branch에 다음 predicate를 적용한다.

```text
material.owner_id = authenticatedOwner
material.deleted_at IS NULL
material.current_revision_id = result.revision_id
vector publication is PUBLISHED for the exact chunk/revision/config (vector branch only)
```

hybrid 검색은 keyword와 vector 후보를 안정적 chunk identity로 dedupe하고 deterministic tie-break를 사용한다. vector가 미준비/실패/비동의/예산 차단이면 keyword 결과와 이유가 있는 semantic-degraded 상태를 반환한다. vector branch 장애 때문에 keyword query 전체를 실패시키지 않는다. reader도 같은 owner/current/deleted predicate로 원문과 저장 메모를 분리해 반환한다.

### Migration

migration은 `packages/backend/src/infrastructure/database/migrations`의 단일 ordered SQL stream으로 관리한다. `packages/backend/drizzle.config.ts`가 현재 feature-private `*.schema.ts`를 DDL 입력으로 수집하고 같은 output 경로를 사용한다. schema 파일은 table metadata만 정의하고 Nest bootstrap·pool 생성·환경 secret 검증을 실행하지 않는다. 타입 검사·앱 build와 migration 생성은 DB 연결 없이 가능해야 하며, migration 생성은 앱 build의 부수 효과가 아닌 명시적인 변경 작업이다. 제품 구현 승인 뒤 다음 도구 흐름을 실제 package script로 연결한다. 현재 문서 전환에서는 schema/config/migration 파일을 생성하거나 명령을 실행하지 않는다.

1. backend 내부 Drizzle schema에서 현재 phase에 필요한 table, column, FK/unique/index를 정의한다.
2. `drizzle-kit generate`로 SQL migration과 관련 metadata를 생성한다. pgvector extension 설치, 지원되지 않는 DDL과 data backfill은 필요할 때 `generate --custom`으로 같은 stream의 명시적인 SQL migration에 추가한다.
3. 생성·작성된 SQL의 rename/drop, nullable/default, FK, partial unique predicate, index와 잠금 영향을 검토한다. schema로 표현 가능한 객체는 schema와 일치시키고 custom SQL 객체는 별도로 검증한다. SQL과 Kit가 관리하는 snapshot 등 관련 metadata를 한 변경 단위로 보존하고 임의로 일부만 재생성·삭제하지 않는다. SQL diff와 실제 PostgreSQL 적용 결과가 migration evidence다.
4. 검토된 파일만 명시적 migration 단계에서 적용한다. 실행 수단은 `drizzle-orm`의 programmatic migrator(`drizzle-orm/node-postgres/migrator`)이며 같은 journal·hash 형식을 사용한다. `drizzle-kit`은 SQL/metadata 생성 전용 devDependency로 두어 배포 산출물이 CLI에 의존하지 않게 한다. 실행기는 대상 DB URL을 명시적으로 요구하고 advisory lock으로 동시 실행을 거부한다. 실행 전 대상 환경·DB와 미적용 파일을 확인하고 동일 DB에는 한 실행 주체만 migration을 적용하게 한다. API/worker startup 자동 적용, `push`와 운영 DB 직접 schema 수정으로 이 경로를 우회하지 않는다. 이미 적용한 migration 파일을 고치지 않고 후속 migration으로 변경한다.

Drizzle Kit가 자동 down/rollback을 제공한다고 가정하지 않는다. 변경별로 검토한 rollback SQL 또는 후속 compensating migration과 필요한 backup/restore를 준비하고, extension availability, mixed-version compatibility와 data backfill 검증을 배포 전에 기록한다. destructive migration은 backup/restore rehearsal와 retention/owner/current 불변식 증거 없이는 진행하지 않는다.

확장을 포함하는 PostgreSQL 이미지와 `CREATE EXTENSION` 실행은 구분한다. extension은 의존하는 column/index보다 먼저 같은 migration stream에서 설치·검증하고, 아직 선택하지 않은 embedding 차원을 위해 빈 vector schema를 미리 만들지 않는다. HNSW 등 특수 DDL을 추가할 때는 선택한 migration runner의 transaction 경계와 호환되는지 확인하며, 지원하지 않는 실행 모드를 임의 수동 SQL로 우회하지 않는다. 앱 runtime은 `pg`·Drizzle을 사용하고 migration 단계에만 Kit·검토된 SQL/metadata·DDL 권한을 제공한다. 모든 앱 이미지에 migration 도구나 권한을 일괄 부여하지 않는다.

## Ownership

도메인 상태의 write owner는 ADR-0002가 선언한다. 이 ADR은 PostgreSQL/Drizzle schema composition, transaction API, Drizzle Kit SQL migration stream, FK/unique/index와 query predicate의 저장 계약을 소유한다. `materials`는 synchronous revision/chunk/keyword/receipt/intent row를 쓰고, `indexing`만 delivery/attempt/vector publication row를 쓰며, `search`는 read-only query port만 제공한다.

## Consequences

- core save/keyword/read가 Redis와 AI 없이 완결된다.
- PostgreSQL row와 commit이 effect evidence여서 duplicate delivery와 queue 복구를 안전하게 판단할 수 있다.
- 과거 revision 보존은 저장 공간을 사용하지만 stale result와 edit history를 명확히 구분한다.
- Drizzle의 schema와 migration 생성으로 일반 데이터 접근의 수작업을 줄이되, generated SQL 검토와 명시적인 transaction 전달 책임은 유지한다.
- ORM 타입 검사만으로 migration 안전성이나 경쟁 조건이 증명되지는 않는다. 검색·잠금 등 국소적인 SQL과 실제 PostgreSQL 테스트는 여전히 필요하다.
- pgvector가 관계형 owner/current/deleted predicate와 같은 query에 있어 별도 vector store의 동기화 문제가 없다.

## Verification

- 실제 PostgreSQL에서 owner당 현재 refresh 한 개, 새 로그인의 교체, 동시 refresh CAS의 단일 성공, 고정 만료 보존과 logout 삭제를 검증한다. 검증한 JWT 원문은 DB와 telemetry에 남기지 않는다.
- 실제 Drizzle adapter와 PostgreSQL integration으로 save 각 단계 fault injection의 all-or-none, idempotency same/different fingerprint, concurrent expected-revision CAS와 old revision 비노출을 확인한다. 여러 참여 port가 같은 `tx`를 사용하고 중간 실패가 모든 쓰기를 rollback하는지 검증한다.
- 연결 획득/잠금 timeout과 SQL 실패 뒤 다음 정상 요청이 연결을 획득할 수 있고, Nest app close 뒤 pool이 닫히는지 확인한다. 작업 drain·강제 종료·복구는 API/worker의 도입 phase에 맞춰 검증한다.
- pgvector integration으로 wrong owner, old revision, deleted material, unpublished/wrong-config vector가 keyword/vector/hybrid 결과에 0건인지 확인한다.
- Redis와 provider를 중단한 상태에서도 save receipt, current keyword search와 reader가 성공하는지 확인한다.
- migration test는 검토된 generated/custom SQL로 빈 DB forward와 이전 schema upgrade를 실행하고, 별도 rollback/compensation, `pgvector` extension과 backup/restore 뒤 FK·unique·partial index·current pointer를 검증한다. schema metadata만 보고 성공으로 판단하지 않는다.
- 합성 fixture로 parameterized SQL의 생성 문장·bound values·실제 반환 타입과 owner/revision filter를 검증한다. 알려진 constraint 위반과 감싼 DB error의 분류·redaction도 확인한다. 사용자 원문이나 parameter를 운영 telemetry에 기록하지 않는다.
- 1k/10k corpus에서 query plan, p50/p95, memory, dimension과 dedupe determinism을 기록하고 한 번에 한 변수만 변경한다.

## References

- [Drizzle와 node-postgres 연결](https://orm.drizzle.team/docs/get-started-postgresql)
- [node-postgres pool 반환·error·종료](https://node-postgres.com/features/pooling)
- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Drizzle 조건부 update와 returning](https://orm.drizzle.team/docs/update), [relation과 FK 구분](https://orm.drizzle.team/docs/relations#foreign-keys)
- [Drizzle SQL template과 runtime type 주의사항](https://orm.drizzle.team/docs/sql)
- [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate), [migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate)
- [Drizzle pgvector 검색](https://orm.drizzle.team/docs/guides/vector-similarity-search)

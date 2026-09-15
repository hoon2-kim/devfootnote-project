# devfootnote 구현·검증 계획

## 1. 목적과 실행 경계

[`spec.md`](spec.md)가 제품 요구사항(`F-*`), 수용 기준(`AC-*`)과 non-goal(`NG-*`)의 유일한 선언 소유자다. 이 문서는 의존 순서와 검증 시나리오(`V-*`)만 선언한다. 기술 결정은 [ADR 기준선](#2-adr-기준선)이 소유한다.

현재는 사용자가 진행 중이라고 확인한 Phase 0 scaffold 구현 단계다. 파일·script의 존재는 해당 gate 통과를 뜻하지 않으며 구현·검증 상태는 작업별 결과로 확인한다. 문서 전환 당시의 제품·Git 작업 금지(`ref:NG-06`, `ref:NG-07`)는 문서 승인만으로 제품 작업을 시작하지 않는 경계다. 문서 수정·리뷰 요청에서 진행 중인 제품 코드, dependency, DB나 인프라를 임의로 변경하지 않는다. Git 작업도 별도 명시적 승인 없이 수행하지 않고, AI 호출과 Phase 6 배포는 각자의 gate·승인을 유지한다.

역사적 인증 교체는 spec의 단일 trace인 `integration:github-oauth` → `integration:google-oauth`만 참조한다. 그 밖의 이전 제품 의미, ADR 또는 부록은 이 계획의 입력이나 구현 단계가 아니다.

## 2. ADR 기준선

각 링크는 최종 canonical 파일명을 정확히 사용한다.

1. [ADR-0001: Monorepo and package boundaries](adr/0001-monorepo-and-package-boundaries.md)
2. [ADR-0002: Modular monolith domain ownership](adr/0002-modular-monolith-domain-ownership.md)
3. [ADR-0003: PostgreSQL, pgvector, Drizzle, revisions and search](adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md)
4. [ADR-0004: BullMQ embedding delivery, retry and fencing](adr/0004-bullmq-embedding-delivery-retry-and-fencing.md)
5. [ADR-0005: Google OIDC single owner and access/refresh JWT](adr/0005-google-oidc-single-owner-and-sessions.md)
6. [ADR-0006: Frontend information architecture and design](adr/0006-frontend-information-architecture-and-design.md)
7. [ADR-0007: OpenAPI client and frontend state boundaries](adr/0007-openapi-client-and-frontend-state-boundaries.md)
8. [ADR-0008: AI provider consent, budget, grounding and retention](adr/0008-ai-provider-consent-budget-grounding-and-retention.md)
9. [ADR-0009: Verification, observability and search evaluation](adr/0009-verification-observability-and-search-evaluation.md)
10. [ADR-0010: AWS Terraform decision gate](adr/0010-aws-terraform-decision-gate.md)

ADR-0001 defines the package DAG; ADR-0002 owns entity/transition boundaries and public ports; ADR-0003 owns atomic save, revisions and search data; ADR-0004 owns async delivery and fencing; ADR-0005 owns OIDC/access/refresh JWT; ADR-0006 owns screens/design/accessibility; ADR-0007 owns API/client/frontend state; ADR-0008 owns AI/privacy/usage; ADR-0009 owns evidence and observability; ADR-0010 owns the Phase-6 decision gate. This plan sequences those owners without redefining them.

## 3. 의존 순서와 단계

원칙은 **작게 동작하는 제품 → 신뢰 가능한 비동기 확장 → 선택적 AI → 운영 증거 → 배포 결정**이다. 각 phase는 이전 phase의 usable behavior를 보존하며, optional subsystem을 추가하려고 핵심 저장·keyword·읽기 경로를 깨지 않는다.

### Phase 0 — 별도 제품 승인과 최소 scaffold

시작 조건은 제품 scaffold에 대한 명시적 별도 승인이다. 승인 뒤 Node.js LTS와 호환 가능한 stable package exact version을 고정하고, 첫 slice에 필요한 `apps/web`, `apps/api`, `packages/backend`, `packages/api-client`만 만든다. `pg`, `drizzle-orm`의 node-postgres adapter와 `drizzle-kit`도 호환 가능한 exact version으로 고정한다. ADR-0007의 공통 성공·오류 JSON/OpenAPI 계약, test discovery, PostgreSQL migration baseline과 `AC → V → evidence path` manifest 형식을 먼저 고정한다. 첫 실제 endpoint와 함께 작은 ResponseInterceptor·GlobalExceptionFilter 및 응답 schema를 검증하며 빈 공통 framework부터 만들지 않는다. Migration은 ADR-0003의 schema → SQL generate → 생성 SQL 검토 → 명시적 migrate 흐름으로 준비하고, `push`와 API/worker startup 자동 migration은 사용하지 않는다. 이 흐름의 파일 생성·실행도 현재 문서 승인이 아닌 별도 scaffold/구현 승인 뒤에만 수행한다. `apps/worker`, Redis/BullMQ와 AI dependency는 사용하는 phase보다 먼저 만들지 않는다.

pnpm workspace와 함께 **Turborepo를 Phase 0부터** 도입한다. 실제 존재하는 package script만 root task에 연결하고 build 의존 순서·산출물·입력 환경을 명시한다. dev task는 persistent·cache off로 두고 migration, 외부 AI 호출, 실제 DB·큐 통합 검증 같은 상태 의존 작업을 cache hit로 건너뛰지 않는다. 원격 cache와 공용 config package는 초기 범위에 넣지 않는다.

로컬 실행은 ADR-0001에 따라 루트 `docker-compose.yml`에 PostgreSQL+pgvector만 구성하고 web/API는 호스트에서 pnpm·Turbo 개발 script로 실행한다. Docker 실행 환경, 고정 이미지 버전, loopback 연결과 healthcheck, 개발 데이터 named volume을 준비하고 검토된 migration을 명시적으로 적용한다. 실제 시작·중지·검증 명령은 생성한 파일과 package script를 확인한 뒤 기록한다. 테스트는 개발 DB와 분리된 Testcontainers 및 같은 migration을 사용한다. 이 설정 생성·Docker 실행도 현재 문서 승인이 아닌 제품 scaffold 승인 후 작업이다.

폴더는 ADR-0001의 목표 구조 중 현재 기능만 만든다. API의 기능별 Controller·DTO, 작은 `common`·`health`와 backend의 Module·Service·Repository를 연결하며 공개 Service 메서드를 업무 port로 사용할 수 있다. 모든 기능에 interface·UseCase 계층을 추가하거나 기능이 없는 폴더를 미리 채우지 않는다.

DB 연결은 backend 내부 `DatabaseModule`의 singleton `pg.Pool`·Drizzle 주입 provider와 종료 hook으로 구성한다. 요청별 pool이나 CRUD wrapper는 만들지 않는다. ADR-0003의 유한 연결/쿼리/잠금 timeout, idle-client error 정제와 app close 뒤 연결 반환을 실제 PostgreSQL로 확인한다. schema와 Kit config는 Nest 기동·DB 연결 없이 로드할 수 있어야 하며 build에 schema 생성·migration 적용을 숨기지 않는다.

health는 [ADR-0009의 최소 HTTP/DB 확인 범위](adr/0009-verification-observability-and-search-evaluation.md#health와-slo-gate)로 구현한다. `/health/live`는 DB와 무관한 200, `/health/ready`는 기존 연결의 `SELECT 1` 성공 200·DB 실패 503이며 둘 다 ADR-0007의 일반 성공·오류 JSON을 따른다. `live`는 단순 응답을 반환하고 `ready`에서만 Terminus 기본 API와 backend의 기존 DB 확인 메서드를 연결한다. Swagger는 상태 코드·설명만 명시하며 health 본문 타입을 위해 별도 DTO·inline 모델을 늘리지 않는다. probe 전용 예외 필터·RawResponse·별도 종료 JSON, 임시 `/api/v1/health/status`와 로그인 화면의 API ping은 제거한다. `ref:V-01`의 공통 응답·SDK 계약과 `ref:V-09`의 실제 DB 장애·복구·Pool 종료 검증은 유지한다.

기동은 Nest 기본 로그와 작은 공통 설정·종료 hook·listen으로 구성한다. `configureApp`은 실제 서버·HTTP 테스트·OpenAPI 생성이 공유할 수 있다. 애플리케이션 오류는 backend에서 한 번 설정한 Pino logger를 직접 사용하고 안전한 고정 메시지로 비밀정보를 차단한다. 단순화는 라이브러리 제거가 아니라 직접 만든 주변 계층을 줄이는 것이다. 자체 `logEvent` 래퍼·허용 필드 registry·AsyncLocalStorage 요청 문맥·trace header는 선행 구현하지 않으며 OpenTelemetry·추적은 실제 비동기 처리·관측 요구가 생기는 Phase 2 이후에 필요한 범위만 도입한다.

Gate: `ref:AC-09`, `ref:AC-11`의 현재 구현 subset DAG/API 경계를 `ref:V-09`로 증명한다. 다음 phase의 acceptance를 미리 작성·실패시키는 것은 Phase 0 완료 조건이 아니다. 최종 허용 graph에 아직 없는 worker·feature를 빈 placeholder로 만들지 않는다. [2026-09-15 보존 evidence](evidence/phase0/README.md)는 단순화 이전의 probe·로그·API 연결 화면 계약을 검증한 기록으로 현재 gate의 통과 근거가 아니며, 새 실행 결과로 판단한다. 과거의 다음 phase red-test 기록도 당시 증거로 보존하되 현재 필수 검사나 기능 구현 증거로 사용하지 않는다.

### Phase 1 — 로그인부터 저장·keyword 검색·읽기까지

인증·저장 등 각 기능을 실제로 시작할 때 해당 acceptance의 재현 테스트를 작성하고 구현 후 통과시킨다. 미구현 기능의 404를 미리 401과 비교하는 실패 테스트나 전용 실행 script를 Phase 0에 남겨 두지 않는다. 인증의 실패·성공·권한·재발급 검증 범위 자체는 `ref:AC-02`와 ADR-0005/0009를 유지한다.

Google OIDC callback과 access/refresh JWT를 연결하고 `/login`, `/library`, `/search`, `/documents/[materialId]`를 만든다. 인증은 `@nestjs/jwt`와 Passport Strategy/Guard, HttpOnly cookie, PostgreSQL의 현재 refresh hash 한 건으로 구현한다. ADR-0005의 15분 access·고정 7일 refresh, 원자 rotation과 logout을 먼저 검증하고 ADR-0007의 401 뒤 1회 재발급·bounded 재전송을 연결한다. opaque session, idle touch, 인증용 Redis나 장치 관리는 만들지 않는다.

`identity`와 `materials`의 최소 public ports, 실제 PostgreSQL save transaction, owner/current/deleted predicate, keyword query와 safe Markdown reader를 end-to-end로 완성한다. 일반 조회·저장은 Drizzle을 사용하고 검색·잠금 등 필요한 구간만 parameterized `sql` 템플릿으로 보완한다. 원자 save의 모든 ORM·SQL 연산은 같은 Drizzle transaction handle을 사용하며 callback 안에서 전역 DB handle로 빠져나가지 않는다. 같은 자료의 재전송, concurrent/stale update와 삭제를 이 slice에서 닫는다. Redis와 외부 AI provider는 이 phase의 runtime dependency가 아니다. Google 로그인만 외부 인증 통합이며 로컬 검증에는 standards OIDC test server를 사용한다.

조건부 갱신의 0건 결과와 원자 작업 중 실패가 부분 commit·성공 응답으로 이어지지 않는지 검증한다. 필요한 DB 오류만 code/알려진 constraint로 분류하고 Drizzle의 SQL·parameter·nested cause가 API나 telemetry에 노출되지 않게 한다. 빈 DB 적용과 이전 schema에서의 upgrade는 같은 검토된 SQL/metadata로 검증하며, migration 실행은 대상 DB를 확인한 단일 실행 주체로 제한한다.

실제 제품 API와 생성 SDK를 연결한 사용자 여정을 검증한다. 일반 성공·오류 envelope contract test는 계속 유지하고, 인증 전 화면에서 보호된 API의 정상 401을 서버 장애로 오인하지 않는다. 별도의 API ping UI는 만들지 않으며 `live`·`ready`는 최소 운영 확인용으로 유지한다.

web/API의 앱별 Dockerfile과 루트 `.dockerignore`를 도입하고 `docker-compose.yml`의 선택 `app` profile로 빌드된 runtime image의 기동·핵심 HTTP smoke를 검증한다. build context는 공유 package와 lockfile을 포함하는 모노레포 루트이며 multi-stage·non-root·secret 제외 기준을 지킨다. 호스트 개발과 컨테이너 모드 모두 브라우저 기준 same-origin `/api/v1`·HTTPS cookie/CSRF 경계를 유지하고 컨테이너 DNS 주소를 브라우저 URL로 쓰지 않는다. 프록시 구현은 이 경계를 만족하는 최소 구성으로 해당 slice에서 검증하며 별도 인프라 제품을 지금 고정하지 않는다. CI도 같은 이미지 빌드·최소 runtime smoke를 수행하되 테스트는 격리된 임시 자원과 OIDC test server를 사용하고 registry push나 cloud credential을 요구하지 않는다.

Gate: `ref:AC-01`–`ref:AC-04`, `ref:AC-08`의 core path가 `ref:V-01`–`ref:V-05`로 통과하고, `ref:V-09`의 현재 구조·이미지 실행 검증을 통과해야 한다.

### Phase 2 — AI 도입 gate, embedding과 hybrid 검색

외부 호출 없는 immutable intent와 queue·state-machine slice를 먼저 만든다. Phase 0·1에서 AI 설정 없이 저장한 현재 revision intent도 보존하되 indexing work를 만들거나 Phase 1을 막지 않는다. 첫 실제 chunk 또는 검색 질의 embedding 호출 전에 provider/model/version/dimension, 단위 가격과 호출별 최대 비용, provider retention/private-data 조건을 품질·privacy·비용 evidence로 비교해 별도 승인하고 exact configuration fingerprint를 고정한다. 같은 gate에서 `embedding` purpose의 명시적 consent, budget reservation/settlement, 철회와 provider 0-call negative를 먼저 검증한다.

그 뒤 기존 `/library` 또는 `/search` 안에 의미 검색 활성화·현재 자료 재시도 동작을 추가하고 `apps/worker`, Redis/BullMQ, lease/retry/final state, repair와 fenced PostgreSQL publication을 연결한다. 활성화는 current revision·config·consent epoch·budget을 확인하고, AI 설정 전에 저장한 intent 또는 재동의된 intent에 새 indexing work를 bounded batch로 만든다. terminal work는 변경하지 않으며 activation idempotency와 active-work unique constraint로 반복 요청의 중복을 막는다. 새 settings/운영 화면이나 범용 재색인 시스템은 만들지 않는다.

이 단계에서 로컬 `docker-compose.yml`에 Redis를 추가한다. 평소 API와 worker는 호스트의 별도 pnpm·Turbo 개발 프로세스로 실행하고, worker Dockerfile과 `app` profile의 worker 서비스도 추가해 빌드된 이미지 기동을 확인한다. consumer·processor·scheduler는 worker에서만 등록하고 공유 backend Module을 사용하는 API에서는 시작하지 않는다. Redis가 시작부터 없거나 실행 중 중단되어도 API 기동과 core 경로는 유지되어야 한다. 자동화된 큐·경쟁 테스트는 개발 Redis나 PostgreSQL을 재사용하지 않고 Testcontainers로 격리한다.

문서 chunk embedding과 검색 질의 embedding 모두 같은 consent/budget/provider gate를 통과한다. 질의 원문은 필요한 호출에만 transient하게 전송하고 durable usage/telemetry에는 저장하지 않는다. vector/hybrid는 준비된 현재 revision만 사용하며 query embedding 실패·미동의·예산 차단은 설명 가능한 keyword fallback으로 끝난다.

이 단계부터 비동기 attempt·재시도·fence 실패를 실제로 조사하는 데 필요한 structured log와 correlation을 추가한다. ADR-0009의 개인정보 차단을 유지하고 전체 분산 추적·자동 계측은 관측 필요가 확인되는 구간부터 도입한다.

Gate: `ref:AC-05`, `ref:AC-07`, `ref:AC-08`을 `ref:V-06`, `ref:V-08`로 통과하고 Phase 1 journey가 Redis-down 또는 provider-blocked 조건에서도 계속 통과해야 한다. `ref:V-09`의 worker 전용 등록·이미지 기동과 optional dependency 분리도 확인한다.

### Phase 3 — 명시적 근거 답변

`answers`가 공개 port를 통해 `usage-retention`의 consent/budget reservation과 표시 가능한 evidence snapshot을 pre-call transaction에서 결합해 `RESERVED`를 commit한다. 별도 claim transaction이 `RUNNING`과 call-attempt `STARTED`를 기록한 뒤 provider를 모든 DB transaction 밖에서 호출한다. post-call은 owner/request/reservation/consent/current revision/deletion/expiry를 다시 확인하고, answer/citation 게시 가능 여부와 실제·불명확 비용의 settlement를 독립적으로 exactly-once 결정한다.

timeout, 429, malformed output, invalid citation, 호출 전 crash, 호출 시작 후 결과 불명 crash, late/duplicate result와 compensation/expiry를 구현한다. 응답 저장 뒤 HTTP 응답이 유실되어도 같은 owner·request ID·fingerprint 재요청은 유효한 저장 결과를 추가 호출 없이 반환하고, 다른 fingerprint는 충돌한다. 재조회 시에도 revision·삭제·동의·만료를 검사하며 answer body TTL과 더 긴 dedupe receipt TTL을 분리한다.

Gate: `ref:AC-06`, `ref:AC-07`, `ref:AC-08`을 `ref:V-07`, `ref:V-08`로 통과하고 provider 0-call negative를 evidence로 남긴다.

### Phase 4 — 화면 완결과 접근성·보안 hardening

세 화면의 empty/loading/error/conflict/degraded/recovery와 답변 lifecycle을 완결한다. [`../DESIGN.md`](../DESIGN.md)의 hierarchy를 Inter와 devfootnote semantic token으로 적용하되 금지 brand asset을 포함하지 않는다. keyboard/focus return, label/error association, ARIA announcement, reduced motion, 44×44 touch, tablet navigation collapse와 mobile single-column을 실기기 크기에서 닫는다. JWT expiry·refresh/logout 복구, CSRF, A/B owner isolation과 retention cleanup을 함께 harden한다.

Gate: `ref:AC-01`, `ref:AC-02`, `ref:AC-07`, `ref:AC-10`을 `ref:V-02`, `ref:V-03`, `ref:V-08`, `ref:V-10`, `ref:V-12`로 통과한다.

### Phase 5 — 평가, 관측성과 운영 복구

20-case development corpus로 failure taxonomy를 찾은 뒤 32 grounded+8 ungrounded의 frozen 40-case final corpus를 평가한다. keyword/vector/hybrid의 Hit@1/5와 multi-evidence recall, 답변 grounded/valid/false-answer ratio를 기록한다. 1k/10k chunk 성능은 hardware, memory, dimension, cache, query plan, p50/p95와 provider 구간을 분리하고 한 번에 한 변수만 바꾼다.

Pino/OpenTelemetry는 request→intent→delivery→publication/answer를 content 없이 연결한다. PostgreSQL은 readiness 필수, Redis/AI는 degraded로 분리한다. 저장·검색·queue·answer의 baseline을 얻기 전 SLO를 선언하지 않는다. restore, cleanup, repair와 redaction rehearsal을 수행한다.

`app` profile의 전체 앱 이미지에서 중지·재시작과 worker SIGTERM을 검증한다. 새 claim 중단, 진행 중 작업의 제한된 종료 대기, DB/Redis 연결 정리와 강제 종료 뒤 lease·repair·revision fence 복구를 확인한다. PostgreSQL named volume은 일반 재시작으로 지우지 않으며 destructive reset과 복구 실험은 검증 소유의 별도 자원에서만 수행한다. 이미지 빌드·smoke 결과를 transaction·queue 경쟁 테스트의 대체 증거로 사용하지 않는다.

Gate: `ref:AC-09`, `ref:AC-12`를 `ref:V-09`, `ref:V-11`, `ref:V-12`로 통과하고 모든 앞선 regression을 닫는다.

### Phase 6 — AWS 비용·Terraform 결정 gate

제품 구현과 Phase 5 evidence가 모두 끝난 뒤에만 후보 A(단일 저비용 Graviton EC2+storage/backup), B(EC2 app/worker/Redis+managed PostgreSQL), C(Fargate+managed PostgreSQL+managed cache)를 같은 workload로 비교한다. 이 phase를 여는 별도 승인 전에는 region, SKU, topology 또는 IaC를 선택·생성하지 않는다.

각 후보는 official price URL과 조회 timestamp/timezone, region, peak/steady workload, 730시간을 고정하고 compute, DB, cache, storage/IO, backup, IPv4, ECR/registry, logs, DNS, load balancer, NAT와 transfer를 수량×단가로 기록한다. Credit/free tier는 지속 비용에서 차감하지 않는다. FX source/lookback의 최고 환율, 적용 세금과 보수적 올림을 기록한다.

```text
usdSubtotal     = Σ(USD line-item quantity × unit price)
preCreditKRW    = ceil((ceil(usdSubtotal × fxRate) + krwItems) × taxMultiplier)
finalTotalKRW   = ceil(preCreditKRW × 1.20)
costGate        = finalTotalKRW > 30000 ? BLOCK : PASS_COST_ONLY
```

`taxMultiplier`는 `1.10`, 또는 적용되지 않는 법적 근거를 기록한 `1.00`이다. 두 검토자가 같은 입력으로 같은 결과를 얻어야 한다. 비용 equality는 비용 조건만 통과하며 peak-memory margin, restore rehearsal와 별도 배포 승인은 여전히 필요하다. 비용·복구 gate를 통과해도 Terraform apply, cloud resource 생성 또는 deployment를 자동 승인하지 않는다.

Gate: `ref:AC-13`을 `ref:V-13`으로 통과한 뒤 별도 승인에서만 ADR-0010의 deferred decision을 갱신한다.

## 4. 검증 선언

각 `V-*`는 이 절에서만 선언한다. 다른 위치는 `ref:V-*`로만 참조한다. Infrastructure behavior는 실제 PostgreSQL 또는 Redis/BullMQ evidence가 필요하며 mock은 provider/browser 경계 격리에만 사용한다.

| ID | 선언 | Evidence |
|---|---|---|
| `V-01` | route inventory와 component/browser 시나리오가 `/login` entry 및 정확히 세 제품 route의 모든 적용 가능한 normal/empty/loading/error/conflict/degraded/recovery 상태와 OpenAPI client 경계를 검증한다. API contract는 공통 성공 envelope 1회 적용, 오류 status/error/message·검증 errors, redirect/204 등 본문 없는 응답과 제품 API의 generated schema 일치를 확인한다. 최소 health는 ADR-0007에 따라 실제 일반 JSON·상태 코드·SDK 호출을 확인하며 unknown 본문 타입을 허용한다. | route inventory, Supertest, RTL/MSW, Playwright |
| `V-02` | standards OIDC test server+PostgreSQL+browser가 PKCE/state/nonce/signature/issuer/audience/time/callback/method, exact `(iss, sub)`, account/refresh pre-write zero-row negatives와 server exchange를 검증한다. Google provider token의 browser/DB 보존 0건 및 서비스 JWT의 HttpOnly cookie 외 노출 0건을 구분해 검사한다. | integration DB rows, 정제된 browser storage/network 검사 결과; token 원문을 evidence로 보존하지 않음 |
| `V-03` | access/refresh JWT의 별도 key·용도·issuer/audience/subject·만료, access 만료 후 refresh 성공, 15분/고정 7일 expiry equality, 실제 DB에서 회전 CAS 성공 1건·재사용 거절·logout/refresh 경쟁을 검증한다. logout 후 refresh 거절과 기존 access의 만료 전 유효/만료 후 거절, rotation 응답 유실 시 재로그인, 실패 refresh의 cookie 비변경, cookie flags/Path/Domain/SameSite, exact Origin+custom header CSRF, unsafe GET·production bypass 부재와 프론트 bounded 재전송도 확인한다. | 실제 PostgreSQL+Supertest, controllable clock/barrier, MSW와 browser E2E |
| `V-04` | 검토된 Drizzle Kit SQL migrations를 적용한 실제 PostgreSQL에서 Drizzle로 atomic save, idempotent replay, same-key/different-input conflict, expected-revision CAS, concurrent update/delete와 immutable old revision을 검증한다. ORM·parameterized SQL 연산이 같은 transaction handle을 사용하고 단계별 실패·CAS 충돌 시 all-or-none rollback되는지 확인한다. 빈 DB forward·이전 schema upgrade, 실제 FK/unique와 필요한 raw 결과 변환·DB 오류 분류도 ADR-0003에 따라 검증한다. | Testcontainers PostgreSQL+Drizzle transaction/constraint evidence, reviewed SQL migration/metadata artifact |
| `V-05` | owner A가 Redis/AI 없이 저장 직후 한영 keyword로 current material을 찾아 메모·원문·source를 읽고 owner B·deleted·old revision 결과는 0건임을 검증한다. | PostgreSQL integration+E2E; A/B test identities |
| `V-06` | 승인된 provider/model/version/dimension fingerprint와 embedding consent/budget이 없으면 AI 설정 전 저장한 intent를 보존하면서 chunk·query provider call과 indexing work가 0건인지 검증한다. 최초 설정·동의, 재동의와 현재 자료 재시도는 current revision만 대상으로 terminal work를 변경하지 않고 새 work를 만들며, 같은 activation request와 active config/epoch 반복은 중복 work 0건이어야 한다. 실제 Redis/BullMQ+PostgreSQL에서는 enqueue/claim/call/publish/ack crash, queue loss, restart, bounded retry/final failure, repair, lease expiry와 late-worker race를 검증하고 PostgreSQL publication만 effect evidence로 인정한다. query 원문은 durable usage/telemetry에 0건이어야 한다. | configuration/consent receipt, activation idempotency rows, provider call ledger, Testcontainers crash matrix and durable publication receipts |
| `V-07` | fake provider와 실제 DB가 `REQUESTED → RESERVED → RUNNING → terminal` 전이, call-attempt 시작 기록, provider-outside-transaction, 호출 전 crash의 무비용 release와 호출 시작 후 결과 불명의 보수 정산을 구분해 검증한다. 응답 저장 뒤 HTTP 유실 재요청은 같은 owner/request/fingerprint에 저장 결과를 반환하고 추가 호출·charge가 0건이며 다른 fingerprint는 충돌한다. 재조회 revision/delete/consent/expiry fence, exact citation, no-answer, timeout/429/malformed output과 분리된 answer/dedupe TTL도 검증한다. | PostgreSQL integration, controllable crash barriers, connection observation, provider call ledger |
| `V-08` | consent default-off, budget/policy negative, revoke/delete/revision/expiry races와 duplicate result에서 금지된 새 provider call·answer publish·double settlement가 0건인지 검증한다. publication 차단과 비용 exposure 정산은 독립 decision table대로 exactly-once 처리되고 AI 파생 자료는 즉시 inaccessible·24시간 내 deleted여야 한다. | call/settlement ledger, DB-clock race matrix, retention evidence |
| `V-09` | ADR의 package/feature graph를 최종 허용 상한으로 사용하고 각 phase의 node·edge가 그 부분집합인지 검사한다. 공개 Nest Module·명명된 업무 Service 메서드는 허용하되 cycle, frontend→backend runtime, feature deep import, cross-private repository/schema, app-owned rule/schema와 generic bypass coordinator는 거부한다. API에서 consumer·scheduler가 기동되지 않고 PostgreSQL-down readiness 실패와 Redis/AI 없이 API 기동·core 지속이 구별되어야 한다. 최소 Turbo task·cache 정책, `docker-compose.yml`의 단계별 서비스·healthcheck·loopback 연결, 호스트 개발 및 `app` profile의 image build/runtime smoke, same-origin HTTPS 인증, 재시작 후 데이터 보존과 worker 종료·복구를 현재 phase 범위에서 확인한다. 최종 phase에서는 완전한 graph와 정확히 일치해야 한다. | phase-aware dependency graph test, API/worker integration probes, task graph 확인, 로컬·CI image build/smoke와 데이터 보존·종료 기록; 세부 검증은 ADR-0001/0009 |
| `V-10` | token/contrast automation과 세 화면 browser matrix가 Inter, semantic/non-color cue, `ink-faint` 제한, AA contrast, labels/names/errors/announcements, keyboard/focus return, reduced motion, 44×44, tablet/mobile reflow 및 금지 identity/asset 0건을 검증한다. | static token report, accessibility assertions, Playwright screenshots/interaction |
| `V-11` | versioned 20-case development와 frozen 40-case final corpus가 Hit@1/5, multi-evidence recall, grounded/valid/false-answer ratio를 재현하고, 별도 1k/10k run이 latency/cost/resource 조건과 한 변수 비교를 기록한다. | corpus hash, raw result artifact, evaluation report |
| `V-12` | redaction fixtures와 cleanup/restore rehearsal이 content·prompt·answer·provider response·secret·token·source query의 telemetry 0건, bounded pseudonym label, retention deadlines와 recovery를 검증한다. | log/trace/metric scan, DB retention receipts, restore report |
| `V-13` | 두 검토자가 동일 official-price worksheet를 독립 재계산해 동일 `finalTotalKRW`/gate를 얻으며 누락 line, stale/unknown source, 30,000 KRW 초과, memory margin 부족 또는 restore 실패를 각각 BLOCK한다. | signed input snapshot, two recomputation outputs, ADR-0010 gate receipt |
| `V-14` | canonical inventory/parser가 devfootnote-only content, exact ten ADR links, 단일 F/AC/V/NG declaration, typed forward/reverse references, owner consistency와 dangling link 0건을 확인하고 docs cutover의 Git/product/test/IaC/cloud action 0건을 증명한다. | document graph report and scoped file-action receipt |

## 5. Acceptance 추적 매트릭스

아래는 선언이 아니라 typed reference 연결이다. Evidence는 해당 `V-*` 선언의 evidence class를 따른다.

| Acceptance 참조 | Verification 참조 | Phase |
|---|---|---:|
| `ref:AC-01` | `ref:V-01`, `ref:V-10` | 1, 4 |
| `ref:AC-02` | `ref:V-02`, `ref:V-03` | 1, 4 |
| `ref:AC-03` | `ref:V-04` | 1 |
| `ref:AC-04` | `ref:V-05`, `ref:V-11` | 1, 5 |
| `ref:AC-05` | `ref:V-06` | 2 |
| `ref:AC-06` | `ref:V-07`, `ref:V-08` | 3 |
| `ref:AC-07` | `ref:V-08`, `ref:V-12` | 2–5; Phase 2는 embedding consent·budget·query privacy subset만 적용 |
| `ref:AC-08` | `ref:V-05`, `ref:V-06`, `ref:V-09` | 1–5 |
| `ref:AC-09` | `ref:V-09` | 0–5 |
| `ref:AC-10` | `ref:V-10` | 4 |
| `ref:AC-11` | `ref:V-01`, `ref:V-09`, `ref:V-13` | 0–6 |
| `ref:AC-12` | `ref:V-11` | 5 |
| `ref:AC-13` | `ref:V-13` | 6 |
| `ref:AC-14` | `ref:V-14` | docs cutover |

## 6. 구현 규칙과 승인 gate

### 6.1 기능 단위 작업 절차

전체 제품을 구현 전에 끝까지 상세 설계하지 않는다. 새 기능, 여러 파일에 걸친 변경 또는 인증·DB·비동기 경계 변경은 관련 spec/ADR을 읽고 **지금 구현할 한 slice**의 계획을 먼저 정한다. 단순 문구 수정이나 원인·범위가 명확한 작은 버그 수정은 짧은 작업 설명과 재현 검사로 충분하다.

기능 계획은 다음 내용을 짧게 담는다.

- **목표와 제외 범위:** 이번 변경의 사용자 동작과 이번에 하지 않을 일.
- **기준 문서:** 관련 요구사항·수용 기준·검증 참조와 owning ADR. 기존 계약을 복제하거나 새 요구사항의 선언 장소로 사용하지 않는다.
- **관찰할 결과:** 정상·실패·경계 사례와 필요한 경쟁 시나리오. 기대 결과는 구현 코드가 아니라 위 계약에서 정한다.
- **구현 순서:** 변경할 파일·모듈, transaction·외부 호출 경계와 작은 작업 순서. 완성 코드를 미리 길게 작성하지 않는다.
- **검증:** 가장 좁은 재현 검사, 실제 DB/큐가 필요한 검사, 필요한 HTTP·브라우저 여정과 실행 환경. 아직 없는 script는 도입 예정으로 구분한다.
- **완료 보고:** 실제 명령·결과·미실행 항목, 남은 실패·위험과 문서 영향. 기존 phase evidence와 연결한다.

한 세션에서 끝나는 작업은 대화의 계획으로 충분하다. 여러 세션에서 이어갈 기능만 필요할 때 `docs/plans/<날짜>-<기능>.md`에 계획과 결과를 보존한다. 이 파일들은 실행 기록이며 제품 요구사항은 spec, 기술 결정은 ADR, phase 순서·검증 선언은 이 문서가 계속 소유한다. 새 문서 체계·플러그인·skill을 이 절차만을 위해 도입하지 않는다.

실행 순서는 관련 계약 확인 → 계획·수용 기준 확인 → 실패하는 검사 → 구현 → 관련 검사·리뷰 → 필요한 문서 갱신이다. 승인된 구현 범위 안에서 합리적인 세부 작업마다 재승인을 요구하지 않되, 계약 충돌·새 권한·범위 확대는 구현 전에 확인한다. 문서의 잘못된 전제를 발견하면 코드나 테스트를 억지로 맞추지 않고 근거와 계약 영향을 검토한다.

### 6.2 실행과 검증 규칙

- 모든 phase는 제품·AI 구성·브랜드의 제외 범위(`ref:NG-01`–`ref:NG-05`, `ref:NG-08`)를 유지한다. 모노레포 구조나 Docker 실행 모드를 추가하는 것을 기능·권한·제품 범위 확대의 근거로 사용하지 않는다.
- 현재 승인된 vertical slice에 착수할 때 acceptance scenario를 먼저 실패시키고 구현 후 통과시킨다. 아직 시작하지 않은 phase의 실패 테스트를 미리 만들거나 기본 검사에서 제외해 보관하지 않는다. 순수 policy/state transition은 Vitest unit, DB/queue contract는 Testcontainers integration, HTTP는 Supertest, frontend state는 RTL/MSW, 핵심 journey와 접근성은 Playwright로 닫는다.
- 실제 DB constraint, transaction, lease, queue delivery, crash recovery 또는 fencing을 mock-only test로 통과시키지 않는다. Sleep 대신 barrier와 controllable clock으로 경쟁을 재현한다.
- 폴더와 port는 현재 phase의 호출자·실패 경계·transaction 소유권이 요구할 때만 추가한다. 공개 Nest Module·업무 Service를 기본으로 하고 외부 AI의 장애 격리처럼 필요한 곳만 interface를 둔다. 빈 layer, Service와 일대일로 중복된 UseCase, generic repository/controller/workflow와 예상 재사용용 shared package를 미리 만들지 않는다.
- Provider call은 DB transaction 밖에 있어야 하고, publication/charge는 post-call fenced transaction의 commit만 effect 증거다. BullMQ 완료나 in-memory state를 성공 근거로 사용하지 않는다.
- 일반 JSON 성공은 ADR-0007의 success/data envelope를 한 번만 적용하고 API error는 실제 HTTP status와 success/error/message 계약으로 sanitize한다. 제품 mutation은 server-derived owner와 access JWT·CSRF 검사를 거친다. refresh/logout은 access 만료와 독립적인 ADR-0005의 refresh/CSRF 경계를 따른다. 사용자 입력으로 owner를 선택하지 않는다.
- 각 phase 종료 때 `AC → V → evidence path` manifest, OpenAPI/client diff, migration state, regression과 unresolved failure를 검토한다. 실패 scenario나 수용 기준을 삭제·완화해 gate를 통과시키지 않는다.
- Phase 0에서는 실제 앱 조립·DB 연결·HTTP 계약의 좁은 검사부터 연결한다. 이후 해당 기능을 구현할 때 관련 테스트와 CI gate를 추가하며 테스트 폴더·비율·coverage 수치를 채우기 위한 placeholder를 만들지 않는다. 임시 scaffold 검사와 지속할 회귀 검사의 구분, CI 환경 누락 처리와 AI 검토 기준은 [ADR-0009](adr/0009-verification-observability-and-search-evaluation.md#scaffold-검사의-수명)를 따른다.
- AI가 테스트를 작성하거나 별도 에이전트가 리뷰했어도 실행 증거를 대신하지 않는다. 핵심 불변식과 기대 결과는 담당자가 원문 요구사항에 대조하고, 구현된 behavior·실제 검사·문서 계약이 일치해야 완료다.

## 7. 중단 조건과 handoff

다음이면 BLOCK한다: 승인 부재, ownership 중복/순환, private repository 접근, split save, owner/current/deleted predicate 누락, provider-in-transaction, unfenced publication/settlement, OIDC 검증 전 write, browser provider token, JWT 검증·refresh 원자 교체·CSRF 결함, optional subsystem이 core path를 막음, content/secret telemetry, mock-only infrastructure proof, declaration/link graph 오류, 비용 worksheet 입력 누락, `finalTotalKRW > 30000`, memory/restore failure 또는 배포 승인 부재.

문서 작업 완료는 변경한 문서·링크·계약의 일관성을 뜻하며 제품 검증 완료가 아니다. 현재 진행 중인 Phase 0의 완료는 위 gate와 실제 검사 결과로 별도 판단한다. 다음 phase나 source control로 자동 확장하지 않으며, deployment handoff는 별도 Phase-6 승인과 비용·복구 gate 뒤다.

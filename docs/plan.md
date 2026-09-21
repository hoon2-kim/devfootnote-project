# devfootnote 구현·검증 계획

## 1. 목적과 실행 경계

[`spec.md`](spec.md)가 제품 요구사항(`F-*`), 수용 기준(`AC-*`)과 non-goal(`NG-*`)의 유일한 선언 소유자다. 이 문서는 의존 순서와 검증 시나리오(`V-*`)만 선언한다. 기술 결정은 [ADR 기준선](#2-adr-기준선)이 소유한다.

현재 Phase 1 인증·자료 CRUD·keyword 검색까지 구현했으며 단계별 검증 결과는 아래 완료 기록을 따른다. 파일·script의 존재는 해당 gate 통과를 뜻하지 않는다. 문서 전환 당시의 제품·Git 작업 금지(`ref:NG-06`, `ref:NG-07`)는 문서 승인만으로 제품 작업을 시작하지 않는 경계다. 문서 수정·리뷰 요청에서 진행 중인 제품 코드, dependency, DB나 인프라를 임의로 변경하지 않는다. Git 작업도 별도 명시적 승인 없이 수행하지 않고, AI 호출과 Phase 6 배포는 각자의 gate·승인을 유지한다.

역사적 인증 교체는 spec의 단일 trace인 `integration:github-oauth` → `integration:google-oauth`만 참조한다. 그 밖의 이전 제품 의미, ADR 또는 부록은 이 계획의 입력이나 구현 단계가 아니다.

## 2. ADR 기준선

각 링크는 최종 canonical 파일명을 정확히 사용한다.

1. [ADR-0001: Monorepo and package boundaries](adr/0001-monorepo-and-package-boundaries.md)
2. [ADR-0002: Modular monolith domain ownership](adr/0002-modular-monolith-domain-ownership.md)
3. [ADR-0003: PostgreSQL, pgvector, Drizzle, revisions and search](adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md)
4. [ADR-0004: BullMQ embedding delivery, retry and fencing](adr/0004-bullmq-embedding-delivery-retry-and-fencing.md)
5. [ADR-0005: Passport Google login and access/refresh JWT](adr/0005-google-login-and-sessions.md)
6. [ADR-0006: Frontend information architecture and design](adr/0006-frontend-information-architecture-and-design.md)
7. [ADR-0007: OpenAPI client and frontend state boundaries](adr/0007-openapi-client-and-frontend-state-boundaries.md)
8. [ADR-0008: AI provider consent, budget, grounding and retention](adr/0008-ai-provider-consent-budget-grounding-and-retention.md)
9. [ADR-0009: Verification, observability and search evaluation](adr/0009-verification-observability-and-search-evaluation.md)
10. [ADR-0010: AWS Terraform decision gate](adr/0010-aws-terraform-decision-gate.md)

ADR-0001 defines the package DAG; ADR-0002 owns entity/transition boundaries and public ports; ADR-0003 owns atomic save, revisions and search data; ADR-0004 owns async delivery and fencing; ADR-0005 owns Google OAuth/access/refresh JWT; ADR-0006 owns screens/design/accessibility; ADR-0007 owns API/client/frontend state; ADR-0008 owns AI/privacy/usage; ADR-0009 owns evidence and observability; ADR-0010 owns the Phase-6 decision gate. This plan sequences those owners without redefining them.

## 3. 의존 순서와 단계

원칙은 **작게 동작하는 제품 → 신뢰 가능한 비동기 확장 → 선택적 AI → 운영 증거 → 배포 결정**이다. 각 phase는 이전 phase의 usable behavior를 보존하며, optional subsystem을 추가하려고 핵심 저장·keyword·읽기 경로를 깨지 않는다.

### Phase 0 — 별도 제품 승인과 최소 scaffold

시작 조건은 제품 scaffold에 대한 명시적 별도 승인이다. 승인 뒤 Node.js LTS와 호환 가능한 stable package exact version을 고정하고, 첫 slice에 필요한 `apps/web`, `apps/api`, `packages/api-client`만 만든다. `pg`, `drizzle-orm`의 node-postgres adapter와 `drizzle-kit`도 호환 가능한 exact version으로 고정한다. ADR-0007의 공통 성공·오류 JSON/OpenAPI 계약, test discovery와 PostgreSQL migration baseline을 준비한다. 검증 증거는 기존 테스트·CI 결과와 짧은 실행 보고로 시작하며 별도 manifest 형식을 선행 구축하지 않는다. 첫 실제 endpoint와 함께 작은 ResponseInterceptor·GlobalExceptionFilter 및 응답 schema를 검증하며 빈 공통 framework부터 만들지 않는다. Migration은 ADR-0003의 schema → SQL generate → 생성 SQL 검토 → 명시적 migrate 흐름으로 준비하고, `push`와 API/worker startup 자동 migration은 사용하지 않는다. 이 흐름의 파일 생성·실행도 현재 문서 승인이 아닌 별도 scaffold/구현 승인 뒤에만 수행한다. `apps/worker`, Redis/BullMQ와 AI dependency는 사용하는 phase보다 먼저 만들지 않는다.

pnpm workspace와 함께 **Turborepo를 Phase 0부터** 도입한다. 실제 존재하는 package script만 root task에 연결하고 build 의존 순서·산출물·입력 환경을 명시한다. dev task는 persistent·cache off로 두고 migration, 외부 AI 호출, 실제 DB·큐 통합 검증 같은 상태 의존 작업을 cache hit로 건너뛰지 않는다. 원격 cache와 공용 config package는 초기 범위에 넣지 않는다.

로컬 실행은 ADR-0001에 따라 루트 `docker-compose.yml`에 PostgreSQL+pgvector만 구성하고 web/API는 호스트에서 pnpm·Turbo 개발 script로 실행한다. Docker 실행 환경, 고정 이미지 버전, loopback 연결과 healthcheck, 개발 데이터 named volume을 준비하고 검토된 migration을 명시적으로 적용한다. 실제 시작·중지·검증 명령은 생성한 파일과 package script를 확인한 뒤 기록한다. 테스트는 개발 DB와 분리된 Testcontainers 및 같은 migration을 사용한다. 이 설정 생성·Docker 실행도 현재 문서 승인이 아닌 제품 scaffold 승인 후 작업이다.

폴더는 ADR-0001의 목표 구조 중 현재 기능만 만든다. API의 `modules` 안에서 기능별 Controller·DTO·Service·Repository를 연결하고 작은 common·infrastructure를 둔다. auth/search/health는 레이어드, materials는 라이트 헥사고날을 따른다. 공개 Service 메서드를 업무 port로 사용할 수 있으며 모든 기능에 interface·UseCase 계층을 추가하거나 기능이 없는 폴더를 미리 채우지 않는다.

DB 연결은 backend 내부 `DatabaseModule`의 singleton `pg.Pool`·Drizzle 주입 provider와 종료 hook으로 구성한다. 요청별 pool이나 CRUD wrapper는 만들지 않는다. ADR-0003의 유한 연결/쿼리/잠금 timeout, idle-client error 정제와 app close 뒤 연결 반환을 실제 PostgreSQL로 확인한다. schema와 Kit config는 Nest 기동·DB 연결 없이 로드할 수 있어야 하며 build에 schema 생성·migration 적용을 숨기지 않는다.

health는 [ADR-0009의 최소 HTTP/DB 확인 범위](adr/0009-verification-observability-and-search-evaluation.md#health와-slo-gate)로 구현한다. `/health/live`는 DB와 무관한 200, `/health/ready`는 기존 연결의 `SELECT 1` 성공 200·DB 실패 503이며 둘 다 ADR-0007의 일반 성공·오류 JSON을 따른다. `live`는 단순 응답을 반환하고 `ready`에서만 Terminus 기본 API와 backend의 기존 DB 확인 메서드를 연결한다. Swagger는 상태 코드·설명만 명시하며 health 본문 타입을 위해 별도 DTO·inline 모델을 늘리지 않는다. probe 전용 예외 필터·RawResponse·별도 종료 JSON, 임시 `/api/v1/health/status`와 로그인 화면의 API ping은 제거한다. `ref:V-01`의 공통 응답·SDK 계약과 `ref:V-09`의 실제 DB 장애·복구·Pool 종료 검증은 유지한다.

기동은 Nest 기본 로그와 작은 공통 설정·종료 hook·listen으로 구성한다. `configureApp`은 실제 서버·HTTP 테스트·OpenAPI 생성이 공유할 수 있다. 애플리케이션 오류는 backend에서 한 번 설정한 Pino logger를 직접 사용하고 안전한 고정 메시지로 비밀정보를 차단한다. 단순화는 라이브러리 제거가 아니라 직접 만든 주변 계층을 줄이는 것이다. 자체 `logEvent` 래퍼·허용 필드 registry·AsyncLocalStorage 요청 문맥·trace header는 선행 구현하지 않으며 OpenTelemetry·추적은 실제 비동기 처리·관측 요구가 생기는 Phase 2 이후에 필요한 범위만 도입한다.

Gate: `ref:AC-09`, `ref:AC-11`의 현재 구현 subset DAG/API 경계를 `ref:V-09`로 증명한다. 다음 phase의 acceptance를 미리 작성·실패시키는 것은 Phase 0 완료 조건이 아니다. 최종 허용 graph에 아직 없는 worker·feature를 빈 placeholder로 만들지 않는다. 로컬 전용 `docs/evidence/phase0/`의 2026-09-15 보존 기록은 단순화 이전의 probe·로그·API 연결 화면 계약을 검증한 기록으로 현재 gate의 통과 근거가 아니며, 새 실행 결과로 판단한다. 과거의 다음 phase red-test 기록도 당시 증거로 보존하되 현재 필수 검사나 기능 구현 증거로 사용하지 않는다.

### Phase 1 — 로그인부터 저장·keyword 검색·읽기까지

첫 slice인 **환경 설정 + 인증**은 앱별 `.env.dev`·`.env.prod` 로딩, Nest Config·Zod 설정 검증, Google OAuth·서비스 JWT·인증 migration, 로그인 UI·인증 복구와 최소 `/library` 진입을 구현했다. `passport-google-oauth20`과 backend `auth`를 사용하며 실제 API·격리 PostgreSQL·Google 외부 응답 fixture 기반 브라우저 검증까지 완료했다. 실제 Google 계정의 로그인·새로고침 유지·로그아웃·보호 화면 접근은 사용자가 로컬에서 확인했다. 실제 비밀값 파일은 사용자가 관리한다. 이후 자료 CRUD·검색·읽기와 격리된 production 이미지의 HTTPS 검증을 추가했다. 실제 배포 도메인·공인 인증서 확인은 Phase 6 범위다. 책임 분리는 ADR-0001/0002, 응답 조립은 ADR-0007을 따른다.

후속 승인 범위인 **로그인 화면·공통 디자인 정리**도 구현했다. `DESIGN.md`와 ADR-0006 기준으로 로그인, 헤더·자료함 진입 안내, 인증 대기·오류·로그아웃 화면을 정리하고 shadcn/Radix Button과 Lucide를 필요한 곳에만 사용했다. 당시 모바일·태블릿·데스크톱, focus·skip link·동작 줄이기·axe를 포함한 브라우저 16개를 통과했다. 이후 목록·등록 폼·검색을 실제 API와 연결했다.

2026-09-17 후속 승인 범위인 **자료 등록·목록·현재 원문 읽기**를 구현했다. backend `materials` Service는 입력 준비·멱등 경쟁의 업무 흐름을, Repository는 동일 tx의 revision/chunk/keyword/receipt/intent 저장과 owner/current/deleted 조회를, API Controller·DTO는 HTTP와 공개 응답을 소유한다. `/library`의 실제 등록 폼·목록과 `/documents/[materialId]`의 메모/원문 읽기를 생성 SDK로 연결했다. 당시 관련 Vitest 91개와 브라우저 21개를 통과했으며, 개발 DB 적용은 사용자 작업으로 남겼다. `0004` 생성 DDL과 `0005` 관계 제약은 격리 DB의 빈 DB 적용·이전 인증 schema upgrade로 검증했다. 이후 수정·삭제·키워드 검색 API와 화면, 앱 이미지를 구현했다.

인증·저장 등 각 기능을 실제로 시작할 때 해당 acceptance에 필요한 검사를 선택하고 기존 fixture부터 재사용한다. 버그 수정은 좁은 재현 테스트를 우선하되 모든 변경에 의도적인 실패 테스트·전용 script를 요구하지 않는다. 미구현 기능의 404를 미리 401과 비교하는 검사를 Phase 0에 남겨 두지 않으며, 인증의 실패·성공·권한·재발급 검증 범위는 `ref:AC-02`와 ADR-0005/0009를 유지한다.

GoogleStrategy는 서버 code 교환·profile 조회 뒤 `{ googleId }`만 반환하고 Controller가 AuthService의 계정 재사용·첫 로그인 생성 업무를 호출해 JWT cookie를 설정한다. 검증된 Google 사용자 누구나 자신의 계정을 사용하며 새 `0003_allow_multiple_accounts.sql`은 기존 account·refresh를 보존하고 단일 계정 제약만 제거한다. OAuth state는 5분 DB binding·원자 소모로 보호한다. 서비스 JWT의 15분 access·고정 7일 refresh·계정별 CAS·logout은 유지하고 CSRF는 `csrf-csrf`·cookie-parser·별도 `CSRF_SECRET`으로 연결한다. 프론트는 생성 SDK의 CSRF bootstrap·한 번의 read 요청 refresh 복구·로그아웃과 인증 경계를 연결했다. 자료 등록 요청도 서버 멱등성을 갖춘 뒤 같은 body/key의 1회 복구를 추가했다. 연결 장애는 강제 로그아웃하지 않고 명시적인 재시도를 제공한다. 서버 session·인증 Redis·추가 계층은 만들지 않는다.

`auth`와 `materials`의 최소 public ports, 실제 PostgreSQL save transaction, owner/current/deleted predicate, keyword query와 safe Markdown reader를 end-to-end로 완성한다. 일반 조회·저장은 Drizzle을 사용하고 검색·잠금 등 필요한 구간만 parameterized `sql` 템플릿으로 보완한다. 원자 save의 모든 ORM·SQL 연산은 같은 Drizzle transaction handle을 사용하며 callback 안에서 전역 DB handle로 빠져나가지 않는다. 같은 자료의 재전송, concurrent/stale update와 삭제를 이 slice에서 닫는다. Redis와 외부 AI provider는 이 phase의 runtime dependency가 아니다. Google 로그인 검증은 외부 token/profile 요청만 fixture로 제어하고 실제 Passport Strategy/Guard·앱 설정·DB 효과를 확인한다. 별도 인증 provider 서버나 규격 전수 검증 플랫폼은 만들지 않는다.

조건부 갱신의 0건 결과와 원자 작업 중 실패가 부분 commit·성공 응답으로 이어지지 않는지 검증한다. 필요한 DB 오류만 code/알려진 constraint로 분류하고 Drizzle의 SQL·parameter·nested cause가 API나 telemetry에 노출되지 않게 한다. 빈 DB 적용과 이전 schema에서의 upgrade는 같은 검토된 SQL/metadata로 검증하며, migration 실행은 대상 DB를 확인한 단일 실행 주체로 제한한다.

실제 제품 API와 생성 SDK를 연결한 사용자 여정을 검증한다. 일반 성공·오류 envelope contract test는 계속 유지하고, 인증 전 화면에서 보호된 API의 정상 401을 서버 장애로 오인하지 않는다. 별도의 API ping UI는 만들지 않으며 `live`·`ready`는 최소 운영 확인용으로 유지한다.

web/API의 앱별 Dockerfile과 루트 `.dockerignore`를 도입하고 `docker-compose.yml`의 선택 `app` profile로 빌드된 runtime image의 기동·핵심 HTTP smoke를 검증한다. build context는 공유 package와 lockfile을 포함하는 모노레포 루트이며 multi-stage·non-root·secret 제외 기준을 지킨다. 호스트 개발과 컨테이너 모드 모두 브라우저 기준 same-origin `/api/v1`·HTTPS cookie/CSRF 경계를 유지하고 컨테이너 DNS 주소를 브라우저 URL로 쓰지 않는다. 프록시 구현은 이 경계를 만족하는 최소 구성으로 해당 slice에서 검증하며 별도 인프라 제품을 지금 고정하지 않는다. CI도 같은 이미지 빌드·최소 runtime smoke를 수행하되 격리된 임시 자원과 Google 외부 요청 fixture를 사용하고 registry push나 cloud credential을 요구하지 않는다.

Gate: `ref:AC-01`–`ref:AC-04`, `ref:AC-08`의 core path가 `ref:V-01`–`ref:V-05`로 통과하고, `ref:V-09`의 현재 구조·이미지 실행 검증을 통과해야 한다.

2026-09-18 **API 모듈·테스트 구조 개편**: API 전용 backend 패키지를 modules로 통합하고 materials 저장 포트·공개 index·dependency-cruiser·공통 응답 선언을 적용한다. migration은 전체를 `apps/api/drizzle`로 이동하며 SQL/metadata를 변경하지 않는다. 중복 helper/scaffold 테스트를 줄이고 실제 DB/HTTP·브라우저 회귀와 순수 본문 규칙을 유지한다. env 모드는 실행 명령이 소유하며 실제 비밀 파일은 사용자가 관리한다. 범위·결과는 [개편 기록](plans/2026-09-18-api-module-reorganization.md), 검증 정책은 ADR-0009를 따른다.

2026-09-18 **Phase 1 로컬 gate 완료**:

- `ref:V-01`–`ref:V-05`: 단위·HTTP 42개, 실제 PostgreSQL 통합 63개, 브라우저 27개 통과. 등록·목록·검색·읽기·수정·삭제, 두 탭의 revision 충돌과 최신 내용 복구, 응답 유실 재시도의 중복 방지, 계정 전환 뒤 자료·검색 격리, 페이지네이션을 검증했다. 검색·삭제 확인창의 320/1280px axe·스크린샷과 Escape 취소·포커스 복귀를 추가했다. 기존 인증·등록·읽기의 320/768/1280px 검사는 유지했다.
- `ref:V-09`: 실제 Compose app profile의 API·web·migration 이미지와 테스트 전용 PostgreSQL을 사용한 HTTPS 여정 1개 통과. production 설정의 Secure/HttpOnly/host-only cookie, CSRF 누락·다른 Origin 거부, refresh, Redis/AI 없는 저장·검색, 전체 앱/DB 재시작 후 보존, DB 장애 시 live 200/ready 503과 복구를 확인했다. web healthcheck를 추가해 `--wait`가 웹 응답 준비도 기다리게 했다.
- 검증 명령: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm openapi:check`, `pnpm test:browser`, `pnpm test:images`. CI에도 동일한 이미지 여정을 연결했다. 로컬 통과와 원격 GitHub Actions 실행은 구분한다.
- 코드 가독성 요청에 따라 Prettier·EditorConfig 및 ESLint 중괄호/빈 줄 규칙을 추가하고 소스·테스트 형식을 통일했다. 생성 SDK·OpenAPI·migration 이력과 문서는 일괄 포맷에서 제외한다. `pnpm format`으로 수정하고 `pnpm lint`에서 형식을 강제한다.
- 실제 사용자 env·개발 DB·migration 이력은 변경하지 않았다. Google 응답과 인증서는 격리 fixture이며 실제 Google 계정의 로컬 로그인은 앞선 사용자 확인을 근거로 한다. 공인 인증서·운영 도메인·클라우드 배포는 Phase 6, worker·AI 호출은 Phase 2 이후의 별도 승인 범위다. 이번 작업에서 commit/push는 하지 않았다.

#### Phase 1 리뷰 후속 수정 — 2026-09-19

- snippet의 전각/NFKC 일치 위치, 여러 필드에 분산된 토큰, surrogate 경계 오류를 기존 로직에서 3개 실패로 재현한 뒤 수정했다. 정규화 길이 변화·시작 경계·plain text·미리보기까지 좁은 단위 9개로 검증하고 실제 검색 HTTP 회귀를 추가했다.
- materials Service의 원문 준비·fingerprint는 유지하고, 기존 멱등 경쟁 처리는 Repository 안으로 옮겼다. 2026-09-17 기록의 Service 책임에서 이 부분만 변경했다. 저장 포트는 작업별 입력 객체와 `PageResult<T>`를 사용하며 `ReceiptRace`·추가 한 행 규약을 소비자에게 노출하지 않는다. SQL transaction·CAS·HTTP JSON·OFFSET·migration은 그대로다.
- `pnpm bench:search`로 1k/10k/20k 합성 자료의 실제 Repository SQL 27조건·총 360표본을 측정했다. 짧은 한글뿐 아니라 흔한 단어·과거 revision 비용을 확인했다. [ADR-0009의 측정 요약](adr/0009-verification-observability-and-search-evaluation.md#phase-1-keyword-측정-2026-09-19)을 기준으로 후속 최적화를 판단하며 이번에 검색 의미나 index를 바꾸지 않았다.
- API·web Dockerfile에서 manifest/lockfile 설치 레이어를 소스 빌드와 분리했다. 첫 빌드 성공 뒤 소스 변경 재빌드에서 양쪽 install `CACHED`를 확인했다. API·web 사이의 공통 빌드 레이어도 재사용되므로 web의 `COPY . .`까지 `CACHED`일 수 있다.
- 재검증: 단위·HTTP 51개, 실제 PostgreSQL 통합 65개, 브라우저 27개, production 이미지 HTTPS 여정 1개 통과. workspace 타입 검사, ESLint·Prettier·dependency-cruiser, OpenAPI/SDK drift 검사 통과. sandbox의 HTTP listen 제한은 권한 승인 후 재실행해 통과했다. 이미지 검사는 기존 fixture Google을 사용했으며 실제 Google 재로그인·원격 CI·배포는 실행하지 않았다.
- 개발 DB·사용자 env·migration 이력·KST 로그·아키텍처 선택은 유지했다. commit/push는 하지 않았다. AGENTS에는 새 수동 측정 명령만 추가했으며 새 Codex/Claude 세션의 지침 로딩은 별도 확인하지 않았다.

#### Phase 1 인증·검증 후속 보완 — 2026-09-20

- `ref:V-01`: 제품 요청의 refresh 401/재전송 401을 typed terminal auth로 전달하고 한 번의 private 요청 중단·cache 정리·로그인 복귀로 연결했다. 503·network 실패는 편집 입력을 유지한다. 허용된 returnTo는 OAuth state에 저장해 검색 query·문서 revision/앵커를 복원하며 임의 URL과 callback query의 덮어쓰기를 거부한다.
- state+binding+DB TTL을 단일 DELETE로 검사·소모한다. pre-auth/refresh 생성의 만료 정리는 expiry index와 `SKIP LOCKED`를 사용해 한 호출당 최대 100건으로 제한한다. 정리와 생성은 같은 transaction에서 실패·rollback한다. 새 `0007_auth_expiry_and_return_to.sql`은 격리 DB에서만 적용했으며 개발 DB에는 사용자의 명시적 `pnpm db:migrate`가 필요하다.
- SDK 결과·공개 오류 정규화와 feature별 query key를 좁게 공용화했다. 검색 SQL·OFFSET·materials 아키텍처·원자 저장 구조는 변경하지 않았다. 검색 projection 최적화, route group·삭제 UI 분리는 이번 범위에서 보류했다.
- Next typegen을 typecheck에 연결하고 next-env 생성물을 Git/Docker 입력에서 제외했다. root typecheck는 compiled API도 준비한다. API/Next 생성물이 없는 임시 소스 사본에서 설치된 의존성만 재사용해 `pnpm typecheck` 단독 통과를 확인했다. 새 clone의 의존성 재설치까지 검증했다는 뜻은 아니다. Turbo의 루트 입력과 CI SHA·읽기 권한·중복 job/실행 취소 정책도 갱신했다.
- 인증 경쟁은 실제 DB lock barrier, 자료 CAS는 승자 effect·패자 잔여 행·read/search까지 검증한다. DB lifecycle case를 독립 fixture로 바꾸고 migration lock case의 `-t` 단독 실행도 통과했다. terminal auth 두 경우와 잘못된 binding의 state 소모는 수정 전 실패를 확인했다.
- 재검증: 단위·HTTP 57개, PostgreSQL 통합 79개, 브라우저 전체 33개, production HTTPS 이미지 여정 1개 통과. build·typecheck·ESLint·Prettier·dependency-cruiser·OpenAPI/SDK drift 검사를 통과했다. 브라우저 전후 web tsconfig 해시는 같고 next-env는 추적되지 않는 로컬 파일로 남았다. 문서의 로컬 링크 대상 71개와 `git diff --check`도 확인했다. 브라우저의 503/network 새 case는 처음 실행에서 빈 Next alert를 잘못 기다린 검사 실패가 있었고, 실제 편집 오류 문구를 기다리도록 수정한 뒤 전체 재실행으로 확인했다.
- 실제 Google 재로그인·원격 CI·개발 DB migration·배포는 실행하지 않았다. 사용자 env와 기존 작업을 보존했으며 commit/push는 하지 않았다. next-env는 승인받아 Git 추적만 제거하고 로컬 파일은 유지했다. AGENTS의 생성 타입 지침은 갱신했으나 새 Codex/Claude 세션의 자동 로딩은 확인하지 않았다.

#### Phase 1 OAuth 임시 상태 명칭 정리 — 2026-09-20

- PostgreSQL 기반 state·refresh, Passport와 JWT 인증 동작은 유지하고 `LoginAttempt`/`loginAttempts`를 `OAuthState`/`oauthStates`로 통일했다. 저장·소모 메서드는 `saveOAuthState`·`consumeOAuthState`로 명명하고 테스트·문서의 현재 테이블 참조도 맞췄다. 로그인 이력·실패 횟수·계정 잠금이나 인증용 Redis는 추가하지 않았다.
- `0008_rename_oauth_state.sql`은 테이블·PK·만료 index를 rename만 한다. Kit의 index drop/create 출력은 검토 후 `ALTER INDEX ... RENAME`으로 바꿔 기존 index를 재사용한다. 이전 SQL/snapshot 16개의 해시가 동일하고 재생성 시 추가 schema diff가 없음을 확인했다.
- 실제 PostgreSQL에서 0007까지 적용한 DB에 임시 상태를 저장한 뒤 0008을 적용해 모든 column 값과 PK·만료 index 보존을 검증했다. 단위·HTTP 57개, 새 검사 1개를 포함한 통합 80개, 브라우저 33개, production HTTPS 이미지 여정 1개와 API build·workspace typecheck·lint·OpenAPI/SDK drift 검사를 통과했다. 문서 로컬 링크 대상 91개에 누락이 없고 `git diff --check`도 통과했다. 실제 Google 재로그인·원격 CI는 실행하지 않았다.
- 개발 DB에는 적용하지 않았다. 구버전 API 중지 → `pnpm db:migrate` → 갱신한 API 시작 순서가 필요하며, 새 인증·화면 정책이나 배포 승인을 뜻하지 않는다. 기존 작업과 staged 상태를 보존하고 commit/push는 하지 않았다. AGENTS에는 OAuth 임시 상태와 로그인 이력의 구분만 추가했으며 새 세션의 지침 자동 로딩은 확인하지 않았다.

#### Phase 1 로그인 디자인 전환 — 2026-09-20

- 사용자 요청에 따라 로그인부터 고운바탕과 종이색·올리브 계열의 편집물 배치로 변경했다. UIBowl의 공개 로그인 패턴만 확인했으며 유료 콘텐츠는 열람하지 않았다. 적용 범위·기존 DESIGN 계약의 예외·출처는 ADR-0006에 기록했다. 폰트는 라이선스와 checksum을 보존한 로컬 WOFF2로 제공하고 의존성은 추가하지 않았다.
- `ref:V-10`: 320/768/1280px의 실제 스크린샷을 확인하고 가로 overflow·44px 이상 버튼·키보드 focus·axe 검사 및 320px 오류 화면을 검증했다. 로그인·로그아웃·만료 복구·returnTo를 포함한 관련 Playwright 19개, web production build·web typecheck와 변경한 TS/TSX/CSS의 ESLint·Prettier 검사를 통과했다.
- 인증/API·DB·자료함/검색/읽기 디자인은 변경하지 않았다. 실제 Google 계정 재로그인, 전체 자료 CRUD 브라우저 검사와 HTTPS 이미지 재빌드는 이번 시각 변경에서 실행하지 않았다. 개발 DB migration·commit·push·배포는 하지 않았다.

#### Phase 1 자료함 디자인·로그인 문구 정리 — 2026-09-20

- 자료함을 제목·최근 수정일 목록과 `새 자료` 진입 중심으로 변경했다. 작성 패널은 필요할 때 펼치며 같은 화면에서 접었다 열어도 입력·오류·멱등 요청 ID를 유지한다. 닫기/Escape 뒤 진입 버튼 focus 복귀, 저장 중 닫기 방지, 기존 저장·페이지 이동을 유지했다.
- 고운바탕 제목·공통 Wordmark와 종이색 인증 헤더를 적용하고 폰트 정의·팔레트를 실제 소비자끼리 공유했다. 로그인에서 사용자가 지정한 소개·안내 네 문구를 제거했다. 인증·API·DB와 검색·원문 읽기 본문은 바꾸지 않았다. 적용 계약은 spec/ADR-0006에 반영했으며 README에 작업 기록을 추가하지 않았다.
- `ref:V-10`: 320/768/1280px의 빈 화면·목록·작성 패널과 로그인 스크린샷을 확인했다. 패널 재진입 후 응답 유실 재시도의 입력·요청 ID 보존, 목록 오류 복구와 기존 로그인·검색·수정·삭제를 포함한 브라우저 35개 및 production HTTPS 이미지 여정 1개를 통과했다. 첫 검사에서 발견한 버튼 disabled 전환 중 대비 문제를 전환 효과 제거로 수정했고, 오류 assertion은 자료 목록 영역으로 한정한 뒤 전체 재검증했다.
- web build·web typecheck·테스트 TypeScript, 변경 파일 ESLint/Prettier와 전체 dependency-cruiser 검사를 통과했다. 별도 단위/DB 통합 suite·실제 Google 계정 수동 재로그인은 재실행하지 않았다. 개발 DB migration·commit/push·배포는 하지 않았다.

#### Phase 1 검색 계산 비용·공통 경계 보완 — 2026-09-20

- 승인된 범위에서 stored `tsvector`와 `0009` migration을 추가했다. Repository의 FTS 조건·rank만 저장 컬럼으로 전환하고 LIKE·similarity·점수 정렬·owner/current/deleted·OFFSET 계약을 유지했다. 과거 migration은 그대로이며 schema와 `0009` snapshot의 차이는 새 컬럼·GIN 하나뿐이다. 기존 데이터 upgrade·생성 컬럼·index 교체는 격리 DB에서 확인했고 Kit 재생성은 추가 변경 없음으로 끝났다.
- 동일 검색 fixture의 변경 전/후 27조건·각 실행 360표본을 비교했다. 모든 조건에서 저장 vector와 기존 표현식 SQL의 반환 행·순서가 같았다. 20k `인증` p50은 238.02→23.54ms, `공통기록`은 376.77→290.47ms였다. 흔한 단어·이력 증가 비용은 남아 있으며 projection·후보 제한·점수 변경은 도입하지 않았다. raw 표본과 계획은 로컬 test-results, 공개 요약·재현 명령과 한계는 ADR-0009에 기록했다.
- snippet은 전체 grapheme 배열을 제거하고 필요한 경계를 이분 탐색한다. 전각·결합 문자·한글 자모·이모지·소문자 길이 확장을 보존했다. 별도 24조건 측정에서 모두 p50이 감소했으며 10k 한글 본문 끝 매칭 50건은 45.00→10.42ms였다. 매 경계마다 prefix를 변환하는 선형 순회나 NFKC만 확인하는 fast path는 넣지 않았다.
- 생성 후 검색 cache 누락을 staleTime=Infinity인 실제 QueryClient로 재현한 뒤 owner별 목록·검색 갱신을 공유했다. 수정의 상세 invalidate와 삭제의 remove는 그대로다. 기존 TanStack Query 버전을 루트 테스트에서도 사용하므로 catalog로 단일화했다. 생성·수정 폼 오류를 좁게 공유하고 pending fieldset 해제 뒤 첫 오류 필드에 focus하도록 수정했다.
- GlobalExceptionFilter를 `http/filters/`로 이동하고 typed mapping과 dependency-cruiser의 common→feature/composition·feature→HTTP composition 금지를 적용했다. 앱 조립 필터의 공개 feature 오류 의존은 의도적으로 유지한다고 ADR-0002/0007에 기록했다. auth 만료 정리는 파일 내부 배치 상수만 공유하며 앵커 복귀·페이지네이션은 바꾸지 않았다.
- 검증: `pnpm build`, `pnpm typecheck`, ESLint·Prettier·dependency-cruiser 통과. Vitest 단위·HTTP 63개, PostgreSQL 통합 81개, 자료 여정 Playwright 18개 통과. 첫 브라우저 실행에서 발견한 누락 import와 disabled 입력 focus 문제를 수정한 뒤 같은 전체 대상 18개를 다시 통과했다. HTTP 검사 최초 sandbox 포트 제한도 승인된 실행에서 재검증했다.
- 이번 변경에서 전체 인증 브라우저 suite·HTTPS 이미지 재빌드·실제 Google 로그인·OpenAPI 재생성은 실행하지 않았다. HTTP/SDK 계약과 이미지 설정은 변경하지 않았고 관련 HTTP·DB·제품 브라우저 여정으로 검증했다. 개발 DB migration·commit·push는 하지 않았다. 적용 시 API 중지→대상 확인 후 `pnpm db:migrate`→새 API 시작이 필요하다. AGENTS의 새 경계 문구는 파일 검사만 했으며 새 Codex/Claude 세션의 지침 로딩은 확인하지 않았다.

#### Phase 1 프론트 복구·검증 정리 — 2026-09-20

- logout의 sign-out gate를 CSRF bootstrap 앞으로 옮겼다. 진행 중 발급은 공유하고 다른 mutation은 발급·전송 전에 거부한다. 실패한 logout은 다시 시도할 수 있으며 기존 refresh 완료 대기와 성공 뒤 차단은 유지한다. transport 회귀 3건의 실패를 확인한 뒤 수정했다.
- 문서 background 재조회의 일시 장애에는 본문·편집 초안을 유지하고 stale 경고·재시도를 표시한다. 400·403·404에는 이전 본문을 숨긴다. 삭제 충돌 복구는 cached data가 아니라 `isSuccess`를 확인하며 실패 시 dialog를 유지한다. 검색 도움말 연결·재시도 진행 안내·화면 순서상 첫 서버 오류 focus도 정리했다.
- 정상 OAuth 거부와 장애 로그를 구분했다. returnTo의 허용 경로·앵커는 바꾸지 않고 encoded 검색 문자 정책을 명시·검증했다. 인증·자료 barrier 실패 시 시작한 요청을 모두 정리하며, refresh cleanup의 locked-row 보존과 DB teardown의 단계별 정리를 보강했다. CI에서 ignored next-env 파일의 무효한 diff 인자를 제거했다.
- 검증: `pnpm build`, `pnpm typecheck` 통과. ESLint·Prettier 검사·dependency-cruiser 통과. Vitest 단위·HTTP 66개, 관련 PostgreSQL 통합 72개(auth 44·material-changes 12·database 16), Playwright 전체 41개, 격리 HTTPS 이미지 1개 통과. 문서 stale 320px 스크린샷과 axe 검사도 확인했다. HTTP 검사의 sandbox 포트 제한은 권한 승인 후 같은 검사로 재실행했다. 검색 재시도 테스트는 data 없는 Query가 pending으로 돌아가는 실제 상태에 맞춰 진행 안내를 검사한다.
- 이번 변경은 API 응답·schema·검색 계약을 바꾸지 않는다. OpenAPI 재생성·검색 benchmark는 재실행하지 않았고 개발 DB migration·실제 Google 계정 로그인·커밋·push는 수행하지 않았다. 실제 Google 교환은 격리 fixture로 검증했다.

#### Phase 1 변경 없는 저장 — 2026-09-21

- 수정 요청은 receipt 재전송 확인·자료 행 잠금·소유자/삭제 상태·기대 revision 검증 뒤 현재 내용 fingerprint를 비교한다. 정규화한 내용이 같으면 기존 ID/revision을 반환하고 새 요청의 receipt만 기록한다. current pointer·updated_at·revision/chunk/keyword/intent는 변경하지 않는다. 실제 오타·공백·메모 변경은 기존처럼 새 revision을 만든다.
- 오래된 기대 버전의 새 요청은 내용이 현재와 같아도 409다. 이미 확정된 변경 없음 요청의 재전송은 이후 자료가 수정되어도 원래 결과를 유지하며 같은 key의 다른 내용은 거부한다. API 응답 형태·schema·migration은 변경하지 않았다.
- 검증: 수정 전 변경 없음·동시 재전송 검사 2건의 실패를 확인했고 실제 변경 검사 1건은 통과했다. 수정 후 실제 PostgreSQL 자료 통합 28개, 자료 브라우저 여정 17개, 본문 규칙 단위 2개 통과. API·테스트 TypeScript 검사, ESLint·Prettier·dependency-cruiser·diff 공백 검사 통과. 변경 문서의 로컬 링크 대상도 확인했다.
- worker·AI 재처리 감소는 아래 Phase 2 계획에만 반영했다. 이번 작업에서는 AI 호출·개발 DB migration·OpenAPI 재생성·전체 인증/HTTPS 이미지 재검증·commit/push를 수행하지 않았다. 응답 형태와 인증·이미지 구성은 변경하지 않았다.

#### Phase 1 커밋 전 정리 — 2026-09-21

- 생성 OpenAPI 명세를 `apps/api/openapi.json`으로 옮기고 생성기·SDK 입력·drift 검사·포맷 제외 경로를 함께 변경했다. API가 명세를 소유하며 `docs/`는 요구사항·설계·작업 문서로 유지한다. 재생성한 명세와 SDK 내용은 이동 전과 동일하다.
- 현재 작업 트리에서 `pnpm openapi:check`, `pnpm typecheck`, `pnpm build`, `pnpm lint` 통과. 단위·HTTP 66개, 격리 PostgreSQL 통합 88개, 브라우저 전체 42개 통과. 공개 Markdown의 로컬 링크 대상 119개와 diff 공백 검사를 확인했다.
- 이번 경로 정리에서 HTTPS 이미지 검증·검색 benchmark·실제 Google 로그인은 재실행하지 않았다. 앞선 검증 기록과 구분하며 개발 DB migration·외부 AI 호출·배포·push는 수행하지 않는다.

### Phase 2 — AI 도입 gate, embedding과 hybrid 검색

**불필요한 임베딩 재처리 감소**는 이 phase의 입력·worker 설계에 포함한다. Phase 1의 변경 없는 저장은 새 intent 자체를 만들지 않는다. 실제 내용이 바뀐 revision은 보존하되, 어떤 필드·전처리·chunk 구성을 provider 입력으로 쓰는지 먼저 확정하고 동일 입력 결과의 재사용을 설계한다. 재사용 식별에는 실제 입력과 provider/model/version/dimension·입력 처리 설정을 포함하며 material 전체 fingerprint나 "사소한 수정" 여부만으로 판단하지 않는다. 같은 owner의 허용된 결과 범위부터 검토하고 새 revision/chunk 연결·현재 revision·삭제·consent/config/lease fence를 유지한다. 입력·설정 불일치와 철회/삭제 결과의 재사용 금지, 재사용 시 provider 0-call을 검증한다. 글로벌 cache·계정 간 공유·query 원문 보존을 선행 추가하지 않는다. 이 항목은 설계·구현 예정이며 이번 Phase 1 보완에서 worker·AI 호출·vector 재사용은 구현하지 않는다.

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

각 후보는 official price URL과 조회 timestamp/timezone, region, 활성 사용자·동시성을 포함한 peak/steady workload, 730시간을 고정하고 compute, DB, cache, storage/IO, backup, IPv4, ECR/registry, logs, DNS, load balancer, NAT와 transfer를 수량×단가로 기록한다. 모든 사용자의 AI 최대 비용을 합산하며 월 30,000원은 서비스 전체 상한이다. Credit/free tier는 지속 비용에서 차감하지 않는다. FX source/lookback의 최고 환율, 적용 세금과 보수적 올림을 기록한다.

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
| `V-02` | Google token/profile 요청만 fixture로 제어하고 실제 Passport Strategy/Guard의 서버 code 교환·profile 조회·callback/method 설정과 대표 실패를 검증한다. OAuth state의 난수·브라우저 binding·TTL·원자 소모·재사용 거부, Google profile 검증 전 account/refresh 쓰기 0건, 첫 로그인 계정 생성·재로그인 재사용·서로 다른 Google 계정 분리를 실제 PostgreSQL·HTTP로 확인한다. 브라우저 여정에서는 Google provider token의 browser/DB 보존 0건 및 서비스 JWT의 HttpOnly cookie 외 노출 0건을 구분한다. | integration DB rows, 정제된 browser storage/network 검사 결과; token 원문을 evidence로 보존하지 않음 |
| `V-03` | JWT의 별도 key·용도·issuer/audience/subject·만료, access 만료 후 refresh, 15분/고정 7일 expiry, 실제 DB의 계정별 회전 CAS 단일 성공·재사용 거절·logout 경쟁과 다른 계정 refresh 비변경을 검증한다. 기존 access의 잔여 유효성·rotation 응답 유실·실패 refresh의 cookie 비변경도 확인한다. CSRF bootstrap·서명된 token과 binding의 일치/거절, exact Origin·cookie flags·로그인 갱신/refresh 유지/logout 삭제와 JWT의 JSON 노출 0건을 확인한다. unsafe GET·production bypass 부재와 프론트 bounded 재전송을 유지한다. | 실제 PostgreSQL+Supertest, controllable clock/barrier, MSW와 browser E2E |
| `V-04` | 검토된 Drizzle Kit SQL migrations를 적용한 실제 PostgreSQL에서 Drizzle로 atomic save, idempotent replay, same-key/different-input conflict, expected-revision CAS, concurrent update/delete와 immutable old revision을 검증한다. ORM·parameterized SQL 연산이 같은 transaction handle을 사용하고 단계별 실패·CAS 충돌 시 all-or-none rollback되는지 확인한다. 빈 DB forward·이전 schema upgrade, 실제 FK/unique와 필요한 raw 결과 변환·DB 오류 분류도 ADR-0003에 따라 검증한다. | Testcontainers PostgreSQL+Drizzle transaction/constraint evidence, reviewed SQL migration/metadata artifact |
| `V-05` | owner A가 Redis/AI 없이 저장 직후 한영 keyword로 current material을 찾아 메모·원문·source를 읽고 owner B·deleted·old revision 결과는 0건임을 검증한다. | PostgreSQL integration+E2E; A/B test identities |
| `V-06` | 승인된 provider/model/version/dimension fingerprint와 embedding consent/budget이 없으면 AI 설정 전 저장한 intent를 보존하면서 chunk·query provider call과 indexing work가 0건인지 검증한다. 최초 설정·동의, 재동의와 현재 자료 재시도는 current revision만 대상으로 terminal work를 변경하지 않고 새 work를 만들며, 같은 activation request와 active config/epoch 반복은 중복 work 0건이어야 한다. 실제 Redis/BullMQ+PostgreSQL에서는 enqueue/claim/call/publish/ack crash, queue loss, restart, bounded retry/final failure, repair, lease expiry와 late-worker race를 검증하고 PostgreSQL publication만 effect evidence로 인정한다. query 원문은 durable usage/telemetry에 0건이어야 한다. | configuration/consent receipt, activation idempotency rows, provider call ledger, Testcontainers crash matrix and durable publication receipts |
| `V-07` | fake provider와 실제 DB가 `REQUESTED → RESERVED → RUNNING → terminal` 전이, call-attempt 시작 기록, provider-outside-transaction, 호출 전 crash의 무비용 release와 호출 시작 후 결과 불명의 보수 정산을 구분해 검증한다. 응답 저장 뒤 HTTP 유실 재요청은 같은 owner/request/fingerprint에 저장 결과를 반환하고 추가 호출·charge가 0건이며 다른 fingerprint는 충돌한다. 재조회 revision/delete/consent/expiry fence, exact citation, no-answer, timeout/429/malformed output과 분리된 answer/dedupe TTL도 검증한다. | PostgreSQL integration, controllable crash barriers, connection observation, provider call ledger |
| `V-08` | consent default-off, budget/policy negative, revoke/delete/revision/expiry races와 duplicate result에서 금지된 새 provider call·answer publish·double settlement가 0건인지 검증한다. publication 차단과 비용 exposure 정산은 독립 decision table대로 exactly-once 처리되고 AI 파생 자료는 즉시 inaccessible·24시간 내 deleted여야 한다. | call/settlement ledger, DB-clock race matrix, retention evidence |
| `V-09` | ADR의 package/feature graph를 최종 허용 상한으로 사용하고 각 phase의 node·edge가 그 부분집합인지 검사한다. 공개 Nest Module·명명된 업무 Service 메서드는 허용하되 cycle, frontend→backend runtime, feature deep import, cross-private repository/schema, 공개 경계를 우회하는 rule/schema 접근과 generic bypass coordinator는 거부한다. API에서 consumer·scheduler가 기동되지 않고 PostgreSQL-down readiness 실패와 Redis/AI 없이 API 기동·core 지속이 구별되어야 한다. 최소 Turbo task·cache 정책, `docker-compose.yml`의 단계별 서비스·healthcheck·loopback 연결, 호스트 개발 및 `app` profile의 image build/runtime smoke, same-origin HTTPS 인증, 재시작 후 데이터 보존과 worker 종료·복구를 현재 phase 범위에서 확인한다. 후속 공유 패키지는 실제 consumer와 owner를 확인하고 허용 graph를 갱신한다. | phase-aware dependency graph test, API/worker integration probes, task graph 확인, 로컬·CI image build/smoke와 데이터 보존·종료 기록; 세부 검증은 ADR-0001/0009 |
| `V-10` | token/contrast automation과 세 화면 browser matrix가 Inter, semantic/non-color cue, `ink-faint` 제한, AA contrast, labels/names/errors/announcements, keyboard/focus return, reduced motion, 44×44, tablet/mobile reflow 및 금지 identity/asset 0건을 검증한다. | static token report, accessibility assertions, Playwright screenshots/interaction |
| `V-11` | versioned 20-case development와 frozen 40-case final corpus가 Hit@1/5, multi-evidence recall, grounded/valid/false-answer ratio를 재현하고, 별도 1k/10k run이 latency/cost/resource 조건과 한 변수 비교를 기록한다. | corpus hash, raw result artifact, evaluation report |
| `V-12` | redaction fixtures와 cleanup/restore rehearsal이 content·prompt·answer·provider response·secret·token·source query의 telemetry 0건, bounded pseudonym label, retention deadlines와 recovery를 검증한다. | log/trace/metric scan, DB retention receipts, restore report |
| `V-13` | 두 검토자가 모든 사용자의 workload·AI 최대 비용을 합산한 동일 official-price worksheet를 독립 재계산해 동일 `finalTotalKRW`/gate를 얻으며 누락 line, stale/unknown source, 월 서비스 전체 30,000 KRW 초과, memory margin 부족 또는 restore 실패를 각각 BLOCK한다. | signed input snapshot, two recomputation outputs, ADR-0010 gate receipt |
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
- **완료 보고:** 실제 명령·결과·미실행 항목, 남은 실패·위험과 문서 영향. 별도 evidence 문서는 보존할 실험·복구 기록이 있을 때만 추가한다.

한 세션에서 끝나는 작업은 대화의 계획으로 충분하다. 여러 세션에서 이어갈 기능만 필요할 때 `docs/plans/<날짜>-<기능>.md`에 계획과 결과를 보존한다. 이 파일들은 실행 기록이며 제품 요구사항은 spec, 기술 결정은 ADR, phase 순서·검증 선언은 이 문서가 계속 소유한다. 새 문서 체계·플러그인·skill을 이 절차만을 위해 도입하지 않는다.

실행 순서는 관련 계약·수용 기준 확인 → 필요한 검사 선택 → 구현 → 관련 검사·리뷰 → 필요한 문서 갱신이다. 버그 수정은 가능한 가장 좁은 재현 실패를 먼저 확인한다. 단순 변경에 RED 증거나 새 테스트 기반을 만들기 위한 작업을 추가하지 않는다. 승인 범위의 세부 작업마다 재승인을 요구하지 않되, 계약 충돌·새 권한·범위 확대는 구현 전에 확인한다. 문서의 잘못된 전제에 코드나 테스트를 억지로 맞추지 않는다.

### 6.2 실행과 검증 규칙

- 모든 phase는 제품·AI 구성·브랜드의 제외 범위(`ref:NG-01`–`ref:NG-05`, `ref:NG-08`)를 유지한다. 모노레포 구조나 Docker 실행 모드를 추가하는 것을 기능·권한·제품 범위 확대의 근거로 사용하지 않는다.
- 검증은 이번 변경이 깨뜨릴 수 있는 계약에 맞춰 기존 검사부터 선택한다. 순수 규칙은 unit, DB/queue 정합성은 integration, HTTP는 Supertest, 화면 상태는 RTL/MSW, 핵심 여정은 Playwright를 사용하되 한 변경에 모든 계층을 의무 적용하지 않는다. 아직 없는 phase의 실패 테스트·전용 harness·placeholder를 만들지 않는다.
- 실제 DB constraint, transaction, lease, queue delivery, crash recovery 또는 fencing을 mock-only test로 통과시키지 않는다. Sleep 대신 barrier와 controllable clock으로 경쟁을 재현한다.
- 폴더와 port는 현재 phase의 호출자·실패 경계·transaction 소유권이 요구할 때만 추가한다. 공개 Nest Module·업무 Service를 기본으로 하고 외부 AI의 장애 격리처럼 필요한 곳만 interface를 둔다. 빈 layer, Service와 일대일로 중복된 UseCase, generic repository/controller/workflow와 예상 재사용용 shared package를 미리 만들지 않는다.
- Provider call은 DB transaction 밖에 있어야 하고, publication/charge는 post-call fenced transaction의 commit만 effect 증거다. BullMQ 완료나 in-memory state를 성공 근거로 사용하지 않는다.
- 일반 JSON 성공은 ADR-0007의 success/data envelope를 한 번만 적용하고 API error는 실제 HTTP status와 success/error/message 계약으로 sanitize한다. 제품 mutation은 server-derived owner와 access JWT·CSRF 검사를 거친다. refresh/logout은 access 만료와 독립적인 ADR-0005의 refresh/CSRF 경계를 따른다. 사용자 입력으로 owner를 선택하지 않는다.
- phase 종료에는 해당 AC·V의 실행 결과, 관련 OpenAPI/client diff·migration state와 남은 실패를 검토한다. 일상 수정은 영향받는 검사로 닫고 전체 regression·이미지 smoke를 매번 반복하지 않는다. CI와 phase gate의 필수 검사는 유지하며 실패를 숨기려고 수용 기준을 완화하지 않는다.
- 명령·결과는 짧은 완료 보고로 충분하다. 실험·복구의 상세 기록이나 `AC → V → evidence path` manifest가 필요할 때만 Git에서 제외한 `docs/evidence/`에 보관한다. 공개 문서에는 로컬 링크 대신 검증 요약·재현 명령·한계를 남기며 테스트 코드와 CI 설정은 버전 관리한다.
- Phase 0에서는 실제 앱 조립·DB 연결·HTTP 계약의 좁은 검사부터 연결한다. 이후 해당 기능을 구현할 때 관련 테스트와 CI gate를 추가하며 테스트 폴더·비율·coverage 수치를 채우기 위한 placeholder를 만들지 않는다. 임시 scaffold 검사와 지속할 회귀 검사의 구분, CI 환경 누락 처리와 AI 검토 기준은 [ADR-0009](adr/0009-verification-observability-and-search-evaluation.md#scaffold-검사의-수명)를 따른다.
- AI가 테스트를 작성하거나 별도 에이전트가 리뷰했어도 실행 증거를 대신하지 않는다. 핵심 불변식과 기대 결과는 담당자가 원문 요구사항에 대조하고, 구현된 behavior·실제 검사·문서 계약이 일치해야 완료다.

## 7. 중단 조건과 handoff

다음이면 BLOCK한다: 승인 부재, ownership 중복/순환, private repository 접근, split save, owner/current/deleted predicate 누락, provider-in-transaction, unfenced publication/settlement, Google 로그인·서버 profile 검증 전 account/refresh write, browser provider token, JWT 검증·계정별 refresh 원자 교체·CSRF 결함, optional subsystem이 core path를 막음, content/secret telemetry, mock-only infrastructure proof, declaration/link graph 오류, 비용 worksheet 입력 누락, `finalTotalKRW > 30000`, memory/restore failure 또는 배포 승인 부재.

문서 작업 완료는 변경한 문서·링크·계약의 일관성을 뜻하며 제품 검증 완료가 아니다. 단계 완료는 각각의 gate와 실제 검사 결과로 판단한다. 다음 phase나 source control로 자동 확장하지 않으며, deployment handoff는 별도 Phase-6 승인과 비용·복구 gate 뒤다.

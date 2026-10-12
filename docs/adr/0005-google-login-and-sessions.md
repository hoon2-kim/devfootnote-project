# ADR-0005: Passport Google 로그인과 access/refresh JWT

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-10-01 — 검색 mode 복귀 allowlist와 복귀 시 자동 AI 호출 금지
- Updated: 2026-09-20 — OAuth 임시 상태 명칭 정리, PostgreSQL 기반 인증 유지
- Canonical owner: Google OAuth 계정 등록·로그인과 서비스 JWT 발급·검증·재발급·로그아웃

## Context

devfootnote는 Google로 로그인한 사용자마다 자신의 자료함을 사용하는 제품이다. 첫 Google 로그인에서 계정을 자동 생성하며 이메일/비밀번호 가입·역할·초대·팀·공유는 지원하지 않는다. 인증은 핵심 기술 과제가 아니므로 Google 로그인과 익숙한 NestJS Strategy/Guard, access JWT와 refresh JWT로 제한한다. 기존 opaque server session의 매 요청 DB 조회, idle expiry와 touch는 사용하지 않는다. JWT를 쓴다는 이유로 refresh 철회나 cookie 보안을 생략하지는 않는다.

계정 식별 근거는 서버가 Google에서 조회한 `profile.id`다. 이메일·domain·표시 이름으로 기존 계정을 연결하거나 최초 방문자에게 전역 소유권을 주지 않는다. GoogleStrategy는 서버 code 교환·profile 조회 뒤 `{ googleId }`만 반환하고 Controller가 `AuthService.completeLogin()`을 호출한다. Service가 해당 Google 계정을 재사용하거나 처음 로그인한 계정을 만든 뒤 token을 발급한다. Google provider token은 browser에 노출하지 않는다. 다계정 로그인 계약에 맞춰 파일명도 변경하며 예전 인증 검증 기록을 새 계약의 통과 근거로 사용하지 않는다.

## Decision

### 인증 흐름과 계층 배치

Google은 소유자 본인 확인에만 사용하고, 제품 API 접근은 devfootnote가 발급한 access/refresh JWT로 처리한다. 구현·검증 상태는 plan과 실제 테스트 결과로 구분하며 이 흐름 자체를 구현 완료 보고로 해석하지 않는다.

```text
브라우저 → Google 시작 Guard → OAuth state 저장 → Google 인증
Google callback → state·browser binding 확인 → GoogleStrategy code 교환·profile 조회
               → { googleId } → Controller → AuthService의 계정 조회·첫 로그인 생성
               → account·현재 refresh hash 원자 저장
               → HttpOnly 서비스 JWT cookie → 검증해 저장한 복귀 경로 (기본 /library)
보호 API → access Strategy/Guard → 인증 owner → 업무 처리
access 만료 → refresh endpoint → JWT 검증 + DB hash CAS → cookie 교체
logout → 유효한 refresh의 owner 행 삭제 → cookie 삭제
```

인증은 `apps/api/src/modules/auth`의 레이어드 모듈 하나로 구성한다. Controller·Guard·Strategy는 HTTP·cookie·Passport를, services의 AuthService·TokenService는 업무·JWT를, repositories의 AuthRepository는 저장을 맡는다. CSRF 연결은 CsrfService, 공개 경로 metadata는 decorators가 소유한다. Module·type·error는 auth 내부에 두고 schema는 `packages/db`에서 관리하되 auth Repository만 접근한다. 다른 모듈은 index.ts의 공개 계약만 사용한다. 별도 Identity 플랫폼·중복 AuthModule·전달 Service·application/domain/port 계층을 만들지 않는다.

로그인은 `AuthService.completeLogin`이 기존 CLS transaction으로 계정 조회·생성, 로컬 JWT 발급, refresh 해시 저장을 조합한다. 저장소는 owner와 해시·시각만 받고 token 발급 callback이나 원문 JWT를 받지 않는다. 같은 Google 계정의 동시 생성과 bounded cleanup은 기존 SQL 의미를 유지한다. 서명·저장 실패나 DB가 거부한 commit은 계정·refresh 변경을 함께 rollback하며 서비스 cookie를 발급하지 않는다. 연결 유실로 commit 결과가 불명확하면 rollback됐다고 단정하지 않으며, 자동 재시도나 token 반환 없이 로그인 실패로 처리한다. 사용자가 다시 로그인하면 같은 계정을 재사용하고 현재 refresh를 원자 교체한다. token은 commit 성공 확인 뒤에만 Controller로 반환한다. OAuth state·refresh CAS·logout의 기존 경계는 유지하며 상세 전파 규칙은 ADR-0002를 따른다.

최소 구성은 Controller, Module, Google/access/refresh Strategy·Guard, 업무 Service와 필요한 schema다. Google은 `passport-google-oauth20`, JWT는 `passport-jwt`·`@nestjs/jwt`를 Nest Passport에 연결한다. `openid-client`, `oidc-provider`, `@types/oidc-provider`는 이 목표 구성에 포함하지 않는다. Google ID token의 자체 OIDC 검증·discovery/JWKS·nonce·PKCE 구현도 추가하지 않는다. 모든 라이브러리마다 adapter·interface·policy·mapper 파일을 요구하지 않는다. Service는 자기 table의 Drizzle을 직접 사용할 수 있고 transaction·CAS 등 저장 책임이 모이면 Repository로 분리한다. HTTP DTO·cookie·redirect와 응답 envelope는 API 및 ADR-0007이 소유한다.

앱별 설정 파일은 `apps/api/.env.dev|.env.prod`, `apps/web/.env.dev|.env.prod`로 분리하고 실제 값은 사용자가 관리한다. Zod는 필수값·URL·운영 origin·각 key의 최소 32자를 한 번 검증한 뒤 Nest Config를 제공한다. access/refresh key와 새 `CSRF_SECRET`은 모두 서로 달라야 하며 Google provider issuer는 설정 입력이 아니다. secret은 API에만 두고 검증 실패에는 항목명만 남긴다. Service/Strategy의 설정 재검증이나 문자 종류로 entropy를 추정하는 보안 판정기는 만들지 않는다. 설정 소비자는 필요한 leaf 값만 가져온다. Controller·Google Guard·cookie 함수는 `secureCookies`, CSRF는 해당 secret·origin·cookie 설정, Google Strategy와 JWT 처리는 각자 사용하는 credential만 전달받는다.

`auth`가 [ADR-0002](0002-modular-monolith-domain-ownership.md)에 따라 account·로그인 state·refresh 상태를 소유한다. API는 Passport와 cookie를 연결하고 private repository에 접근하지 않는다. Google 인증에 성공한 사용자는 누구나 계정을 만들 수 있으며 별도 owner allowlist 설정은 없다. browser가 제출한 id·email이나 검증 없이 decode한 ID token을 사용하지 않는다. 필수 인증 설정이 유효하지 않으면 기동 시 실패하며 테스트용 로그인 우회는 운영에 두지 않는다.

서비스 JWT에는 `@nestjs/jwt`, `@nestjs/passport`, `passport`와 `passport-jwt`를 사용한다. access와 refresh의 Strategy/Guard는 각 JWT 검증을 연결하고 현재 refresh의 DB 대조·원자적 교체는 `auth.RefreshTokens`가 소유한다. 범용 인증 프레임워크, 별도 인증 서비스, RBAC, Redis token store, access denylist, 장치 관리와 token-family 추적은 만들지 않는다.

AlmondYoung에서는 Controller/Service의 역할, Passport Strategy, 전역 `JwtAuthGuard`와 명시적 `@Public()` 패턴만 참고한다. OAuth 서버·다중 client audience·roles/scopes·여러 소셜 계정 연결·Reader/Manager 계층은 가져오지 않는다. 참고 코드의 token 만료 처리·로그·cookie 정책을 그대로 복사하지 않고 사용자 선택인 **refresh JWT**와 아래 계약을 우선한다.

HTTP 요청 타입과 작은 헤더 검사는 `auth.http.ts`에, 쿠키 이름과 읽기·설정 함수는 `auth.cookies.ts`에 모은다. 타입·상수 하나마다 파일을 만들지 않는다. 복귀 경로 allowlist는 독립적인 보안 규칙인 `auth-return-to.ts`로 유지하고 Google/access/refresh Guard·Strategy의 책임은 바꾸지 않는다.

### 검증 책임과 구현 크기

- Google code 교환·profile 조회는 GoogleStrategy, 서비스 JWT의 서명·algorithm·issuer/audience·만료 검증은 Passport/JWT 설정에 맡긴다. 아래 조건은 지켜야 할 결과이지 조건마다 수동 validator·클래스를 만들라는 목록이 아니다.
- 보호된 요청은 Strategy가 검증한 claims/owner 타입을 전달하고 Controller·Service에서 같은 raw JWT와 `req.user` 모양을 다시 검증하지 않는다. refresh Service의 현재 hash·DB 만료·CAS 확인은 별도의 변경 가능한 상태 검사이므로 생략하지 않는다. Guard를 거치지 않는 logout 등 새 진입점에는 필요한 token 검증을 둔다.
- HTTP DTO는 class-validator로, 기동 설정과 서명 검증을 마친 JWT payload의 필수 구조·용도는 각각 Zod로 한 번 검증한다. JWT 서명·algorithm·issuer/audience·만료는 JWT 라이브러리가 맡는다. 같은 HTTP 입력을 Zod로 다시 검사하거나 타입이 있는 내부 반환값에 defensive check를 반복하지 않는다.
- pre-auth TTL·single-use, refresh 원자 교체·철회는 유지한다. 임의 전역 로그인 quota·advisory lock·cleanup scheduler·자동 재시도는 인증이면 당연히 필요한 기능으로 선행 구현하지 않고 실제 요구·위험이 있을 때 별도로 판단한다.

### Authorization 시작과 callback

서버가 client secret을 보관하는 Google Web application의 Authorization Code 흐름을 사용한다. GoogleStrategy에 고정 client ID·secret·callback URL을 설정하고 최소 `profile` scope만 요청한다. Passport 로그인 세션은 사용하지 않는다(`session: false`). PKCE를 제외하는 선택은 이 서버 기반 흐름의 범위 결정이며, PKCE가 제공하는 code 탈취 방어까지 갖췄다고 주장하지 않는다. mobile/public client 도입 시 다시 검토한다.

1. 시작 Guard는 난수 `state`와 browser binding을 만든다. PostgreSQL의 `auth_oauth_states`에 두 값의 hash와 5분 만료를 기록하고 binding은 HttpOnly cookie에 둔다. state를 위해 `express-session`, Redis나 범용 인증 상태 저장소를 새로 추가하지 않는다.
2. callback Guard는 Google 거절 응답·state 누락·binding 불일치·만료를 거부한다. Repository의 DELETE가 `state_hash`, `binding_hash`, `expires_at > now()`를 함께 검사하며 1건 반환될 때만 소모에 성공한다. 잘못된 binding 요청은 정상 브라우저의 state를 소모하지 않는다. 소모 뒤에만 Passport를 실행하며 성공·실패 시 임시 cookie를 정리한다. `session: false`에서 `state: true`만 켜면 저장·검증이 자동 완성된다고 가정하지 않는다.
3. `GoogleStrategy`가 서버 code 교환·Google profile 조회 뒤 `profile.id`를 `{ googleId }`로 반환한다. Controller가 이 값을 `AuthService.completeLogin()`에 전달하고 Service가 계정 재사용·첫 로그인 생성, 해당 계정의 refresh 원자 저장·JWT 발급을 처리한다. Controller는 결과로 cookie·redirect를 설정하며 callback query/body에서 owner를 받지 않는다.
4. callback/교환/profile 실패는 account·refresh write와 서비스 token 발급 0건이다. Google token은 profile 확인에만 사용한 뒤 폐기하며 DB·log·browser에 보존하지 않는다. Google offline access와 refresh token을 요청하지 않는다.

callback은 Nest의 고정 `/api/v1/auth/google/callback` route와 GoogleStrategy의 설정된 callback URL을 사용하며 production은 HTTPS다. raw Host/path를 다시 조립하는 validator·trust proxy 설정을 추가하지 않고 사용자 입력·forwarded host로 외부 redirect를 만들지 않는다. localhost 예외는 개발에만 둔다. Google 외부 호출은 DB transaction 밖에서 수행한다.

누락·변조된 callback, 사용자의 Google 동의 취소처럼 `UnauthorizedException` 또는 `AuthError('denied')`로 판정된 거부는 장애 error 로그를 남기지 않는다. provider 통신·예상하지 못한 장애는 기존의 고정된 오류 메시지만 기록하며 원본 예외·code·profile은 남기지 않는다.

`GET /auth/google?returnTo=...`는 `/library`의 page, `/search`의 q/page/mode, `/documents/<uuid>`의 revision UUID와 실제 화면 앵커(`#main-content`, `#note-title`, `#source-title`)만 허용한다. page는 1–100000, q는 최대 200자, mode는 `keyword | vector | hybrid`다. 중복·알 수 없는 query, 외부 URL·역슬래시·제어문자·임의 앵커는 `/library`로 대체한다. 검증한 상대 경로는 5분 state 행의 `return_to`에 저장하며 callback query로 덮어쓰지 않는다. 로그인 페이지는 returnTo를 로그인 시작 경로에 전달할 뿐 직접 redirect하지 않는다. mode 복원은 UI 선택 복원이며 의미 검색의 외부 호출을 자동 시작하지 않는다. 저장하지 않은 편집 내용은 OAuth 왕복으로 복원하지 않는다.

만료 pre-auth와 refresh 정리는 각 생성 transaction에서 **최대 100건**이다. `expires_at` index로 후보를 읽고 `FOR UPDATE SKIP LOCKED`로 다른 transaction이 잠근 행을 건너뛴다. 별도 scheduler·전역 quota는 추가하지 않는다. 정리 실패는 기존 Repository 오류 정책으로 처리하며 같은 transaction의 생성도 rollback한다. commit 후 cleanup 실패를 로그인 실패로 반환하거나 실패를 삼켜 성공으로 바꾸지 않는다. 기존 lock/statement timeout이 대기 상한을 제공한다. 이는 요청별 cleanup 비용 제한이지 공개 로그인 요청의 빈도 제한은 아니다. `0007_auth_expiry_and_return_to.sql`이 복귀 경로 컬럼·만료 index 두 개를 추가하며 API 기동 전에 명시적으로 적용한다.

복귀 경로의 문자 검증은 URL 구조와 검색어를 구분한다. raw returnTo의 공백·역슬래시는 거부하지만, 허용된 `q` 값 안의 percent-encoded 공백·역슬래시는 검색 문자로 보존한다. decode한 검색어의 제어문자는 거부한다. 내부 경로 allowlist와 앵커 계약은 그대로 유지한다.

### OAuth 임시 상태와 저장소 선택

`OAuthState`·`oauthStates`는 로그인 성공/실패 이력이나 횟수 제한 기능이 아니다. Google 왕복 요청과 브라우저를 연결하는 단기 상태이며 `saveOAuthState`·`consumeOAuthState`가 저장과 조건부 소모를 담당한다. 로그인 이력·실패 횟수·계정 잠금 기능은 추가하지 않는다.

state 검증이라는 보안 목적과 PostgreSQL 저장이라는 구현 선택은 구분한다. 쿠키나 Redis 기반 구현도 가능하지만 현재는 이미 필요한 PostgreSQL을 사용해 binding·TTL·일회성 소모를 원자적으로 처리한다. refresh도 해시만 저장하고 계정 생성과 같은 transaction에 묶는다. state용 새 세션 미들웨어나 인증용 Redis는 추가하지 않으며 Phase 2의 큐 도입만으로 인증 저장소를 이전하지 않는다. 쿠키 삭제와 DB 원자 소모를 동일한 보장으로 취급하지 않는다. 저장소는 실제 부하·장애 요구가 생길 때 재검토한다.

`0008_rename_oauth_state.sql`은 기존 `auth_login_attempts`를 `auth_oauth_states`로, PK와 만료 index 이름을 함께 변경한다. 데이터·5분 TTL·returnTo·cleanup 상한은 유지하며 이전 SQL/snapshot은 수정하지 않는다. 테이블 rename은 구버전 API와 호환되지 않으므로 기존 API를 멈춘 뒤 명시 migration, 새 API 시작 순서로 적용한다. 되돌릴 때도 이름을 복원하는 후속 migration과 코드 버전을 함께 맞춘다.

### 서비스 JWT와 최소 DB 상태

성공 callback은 임시 로그인 정보를 폐기하고 계정을 재사용하거나 생성한 뒤 access/refresh JWT를 발급한다. `accounts(issuer, subject)` unique로 같은 Google 계정의 중복 생성을 막되 전역 단일 계정 제약은 두지 않는다. 기존 DB 전환은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)의 forward migration으로 기존 account·refresh를 보존한다. issuer는 서버가 고정하는 Google provider 표지, subject는 `profile.id`이며 Google ID token claim을 직접 검증했다는 뜻은 아니다. 서비스 JWT의 `iss`/`aud`는 서비스 값, `sub`는 내부 account ID이며 이 값을 제품의 owner로 사용한다.

- Access JWT: 유효기간 **15분**. 허용 algorithm을 `HS256`으로 고정하고 signature, 서비스 `iss`/`aud`, `sub`, `exp`와 `token_use=access`를 검증한다. 매 요청 refresh DB 조회나 idle touch를 하지 않는다.
- Refresh JWT: 최초 로그인 시점부터 **7일**의 고정 만료. rotation해도 만료를 연장하지 않는다. 별도의 signing secret과 `token_use=refresh`, 매 발급마다 새로운 cryptographically random `jti`를 사용하고 DB의 현재 hash·만료도 확인한다. 두 HS256 key는 각각 32바이트 이상의 암호학적 난수를 생성해 hex/base64로 설정하는 것을 권장한다. 기동 시 최소 32자·서로 다른 키를 확인하되 64자리 hex만 강제하거나 문자열로 난수 품질을 판정하지 않는다.
- PostgreSQL에는 `auth` 소유 `auth_refresh_tokens`의 `owner_id` unique, 전체 JWT의 SHA-256 `token_hash`, `created_at`, `expires_at`만 둔다. 원문 JWT를 저장하지 않는다. 새 로그인은 owner의 기존 refresh를 교체하며 여러 기기의 독립적인 로그인 유지는 지원하지 않는다. 만료 행은 인증에서 즉시 거부하고 bounded cleanup으로 제거한다.

JWT와 DB 만료는 각각 `now >= exp` / `now >= expires_at`에서 거부하며 test clock으로 equality를 검증한다. refresh로 재발급할 수 있는 7일 기한은 새 Google 로그인에서만 다시 시작된다. 기한 직전에 발급된 access는 자신의 남은 15분까지 유효할 수 있다.

### Cookie, endpoint와 CSRF

웹과 API는 same-origin으로 제공한다. 서비스 access/refresh JWT는 모두 `Secure`, `HttpOnly`, `SameSite=Lax`, host-only(no `Domain`) cookie로만 browser에 보낸다. access는 `Path=/`, refresh는 `Path=/api/v1/auth`로 제한하고 만료/Max-Age를 토큰의 남은 수명에 맞춘다. pre-auth binding cookie도 HttpOnly이며 `Lax`로 Google top-level callback을 허용한다. localhost 개발의 Secure 예외가 필요하면 development 전용으로 제한하며 production에서는 허용하지 않는다.

callback 성공은 cookie 설정 후 state에 저장한 검증된 제품 경로로 redirect한다. Google token·서비스 JWT를 query/fragment, JSON body, JS-readable cookie 또는 browser storage에 넣지 않는다. 아래 CSRF token의 JSON 반환은 인증 JWT 노출과 다르다. auth 응답의 `Cache-Control: no-store`는 공통 설정에서 한 번 적용하고 cookie/token은 telemetry에 기록하지 않는다.

API 경로는 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)의 `/api/v1` prefix를 따른다.

- Google 시작/callback은 `/api/v1/auth/google`, `/api/v1/auth/google/callback`이며 access Guard의 명시적 예외다. callback은 state 확인과 GoogleStrategy 인증을 반드시 거친다.
- `GET /api/v1/auth/csrf`는 공개 bootstrap이며 `{ success: true, data: { csrfToken } }`을 반환한다. 인증 JWT나 사용자 자료를 반환하지 않는다.
- `POST /api/v1/auth/refresh`는 access Guard만 제외하고 refresh Guard와 CSRF 검사를 적용한다. access 만료/부재가 재발급을 막아서는 안 된다.
- `POST /api/v1/auth/logout`도 access 만료와 독립적이며 CSRF 검사 후 아래 로그아웃 계약을 수행한다.
- `GET /api/v1/auth/me`와 제품 API는 기본 access Guard로 보호한다. 다른 Guard가 붙었다는 이유만으로 access 인증을 생략하지 않는다. 공개 health probe가 있다면 content-free 경로만 명시적으로 예외 처리한다.

모든 unsafe 요청(특히 refresh/logout/동의 변경)은 **exact trusted `Origin`과 `X-CSRF-Token`**을 요구한다. `cookie-parser`로 cookie를 읽고 `csrf-csrf`가 서명된 double-submit token을 검증한다. 고정 문자열 header만 확인하는 방식은 쓰지 않는다. Origin 누락·`null`·불일치와 본문이 있는 mutation의 비 JSON 요청을 거부한다. same-origin을 기본으로 하며 CORS가 필요하면 credentialed exact allowlist만 사용한다.

`getSessionIdentifier`는 로그인 단위의 난수 binding cookie를 사용한다. 이는 서버 session이 아니다. binding과 별도 HMAC cookie는 HttpOnly·host-only·`Path=/`·7일 수명이며 production에서는 Secure와 `__Host-` 이름 prefix를 적용한다. HTTP localhost는 개발 예외로 구분한다. bootstrap은 binding이 없으면 만들고 있으면 재사용하며 성공 로그인은 두 cookie를 갱신한다. refresh는 같은 binding을 유지하고 logout은 JWT·CSRF cookie를 지운다. CSRF 전용 DB·Redis·express-session은 추가하지 않는다.

프론트는 unsafe 요청 직전에 생성 SDK로 bootstrap하고 받은 CSRF token을 해당 요청 header에 붙인다. 장기 메모리 cache 없이 동시에 진행 중인 bootstrap promise만 공유하며 `403` 뒤 mutation을 자동 반복하지 않는다. bootstrap은 인증 세션을 만들거나 Google callback의 5분 DB state 검증을 대체하지 않는다. 자료 변경·logout·동의·예산 변경은 GET으로 수행하지 않는다.

### 재발급과 로그아웃

1. `RefreshTokens`는 검증된 refresh JWT의 owner, 전체 token hash와 고정 만료를 확인한다. 새 random `jti`의 후보 JWT를 만들고 짧은 Drizzle transaction에서 `owner_id + 현재 token_hash + expires_at > DB now` 조건으로 새 hash를 CAS 교체한다. 조회 후 무조건 update하지 않으며 성공한 한 요청만 commit 뒤 새 access/refresh cookie를 받는다. DB 실패 시 새 cookie를 발급하지 않는다.
2. 재사용·만료·CAS loser는 `401`이다. 실패 응답이 먼저 성공한 재발급의 cookie를 지우지 않도록 refresh 실패에서는 `Set-Cookie`를 변경하지 않는다. 프론트는 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)의 bounded 복구를 따른다. 탭 내부 single-flight는 편의이며 DB CAS를 대체하지 않는다.
3. rotation commit 뒤 응답이 유실되면 옛 refresh로 복구하지 않고 Google 재로그인을 요구할 수 있다. grace window, 이전 token 결과 cache, token-family replay 추적은 MVP에 넣지 않으며 완전한 탈취 탐지나 무손실 재발급을 주장하지 않는다.
4. `RevokeRefreshToken`은 유효한 refresh signature/용도/owner/만료를 검증한 뒤 현재 refresh 행을 삭제하고 JWT·CSRF cookie를 동일 name/path 속성으로 지운다. rotation 직전 token으로 시작된 logout도 owner의 현재 행을 삭제하므로 logout과 refresh가 경쟁해도 새 refresh가 남지 않는다. 다른 owner는 삭제할 수 없다. 행이 이미 없으면 성공하며 token이 없거나 만료/무효면 영속 상태 변경 없이 cookie만 정리한다. DB 삭제가 실패하면 `503`으로 알리고 서버 철회 성공을 주장하지 않는다.
5. **로그아웃/새 로그인으로 refresh를 철회해도 이미 발급된 access JWT는 최대 15분 동안 유효하다.** 프론트는 로그아웃 때 사용자 cache와 진행 중 요청을 정리하지만 이것을 서버 즉시 철회로 표현하지 않는다. 즉시 access 철회가 실제 요구가 되면 별도로 재검토한다.

`RequireAccessToken`에서 얻은 account ID를 모든 material, revision, search, answer, usage query/command의 owner predicate로 사용하며 client가 보낸 owner ID를 신뢰하지 않는다. 서로 다른 Google 계정은 서로 다른 개인 자료함을 사용한다. production에는 test identity header·A/B owner switch·auth bypass가 없으며 교차 계정 검증용 fixture는 production build/config에서 활성화할 수 없다. Phase 1 자료 CRUD·검색은 실제 DB/HTTP 검사로 이 격리를 검증한다.

오류, log, trace와 metric에는 authorization code, state, binding, cookie, token hash, JWT, Google profile/token과 개인정보를 기록하지 않는다. browser 오류는 계정 정보나 provider 응답을 노출하지 않는 일반적인 인증 실패로 반환한다.

## Ownership

`auth`만 로그인 state·owner account·서비스 token 발급과 refresh 교체·철회를 소유한다. `apps/api`는 Google/JWT Passport Strategy·Guard와 callback/cookie/CSRF를 연결하고 auth 공개 메서드만 호출한다. PostgreSQL·transaction 규칙은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)을 따른다. 다른 feature는 검증된 owner ID만 입력받고 auth table이나 refresh repository를 직접 읽거나 쓰지 않는다.

## Consequences

- 같은 Google 계정은 같은 account를 사용하고 서로 다른 Google 계정은 분리한다. 이메일 변경·표시 이름이나 최초 방문자 선점으로 다른 사용자의 자료 소유권을 얻지 못한다.
- Google provider token은 폐기하고 서비스 access/refresh JWT만 관리한다.
- 고정 callback·state·browser binding은 유지하되 별도 OIDC client와 provider 테스트 서버를 운영하지 않는다. PKCE 미적용의 한계는 위 서버 기반 흐름으로 제한한다.
- access 인증에 매 요청 DB 조회·idle touch가 필요 없지만 즉시 access revoke는 지원하지 않는다. 계정별 refresh 현재 hash 1건과 원자 교체만 관리하며 응답 유실 시 재로그인을 허용한다.
- 여러 개인 계정을 허용해도 team·공유·초대·관리자 권한은 도입하지 않는다. 그 요구가 생기면 authorization 모델을 새로 결정해야 한다. 공개 사용자 환경의 전체 비용 상한은 AI·배포 gate에서 별도로 확인한다.

## Verification

- Google의 token/profile HTTP 응답만 테스트에서 통제하고 실제 Passport Strategy·Guard의 정상/실패 연결을 확인한다. 전체 Guard를 성공 mock으로 대체한 결과를 Google 연동 증거로 사용하지 않는다. `oidc-provider` 서버나 PKCE/JWKS 전수 fixture는 만들지 않는다. 실제 Google 로그인은 별도 수동 smoke로 구분한다.
- state 소모·재사용/만료·browser binding, 고정 callback·redirect와 code/profile 실패를 확인한다. 같은 조건을 모든 계층에 반복하지 않는다.
- 검증된 Google `profile.id`의 첫 로그인 계정 생성·재로그인 계정 재사용·서로 다른 Google 계정 분리를 실제 PostgreSQL로 확인한다. 누락/실패한 profile과 임의 client owner로는 account/refresh write가 없어야 한다. 새 migration의 기존 account·refresh 보존과 Google 식별자 unique 유지도 확인한다.
- callback의 pre-auth 소모, 새 login의 refresh 교체, provider token의 browser/DB 보존 0건과 서비스 JWT의 HttpOnly cookie 외 노출 0건을 확인한다. JWT 원문은 DB·Redis·log·URL·browser storage에 없어야 한다.
- JWT 설정과 실제 Strategy 연결, 잘못된 key/용도·만료 token 거절, access 15분/refresh 고정 7일과 회전 후 같은 refresh expiry를 검증한다. 우리가 계산하는 만료 경계는 제어 가능한 시계로 확인하고 라이브러리 내부 clock 구현은 다시 테스트하지 않는다.
- 실제 PostgreSQL integration으로 정상 rotation, 같은 초의 발급마다 다른 refresh `jti`, 동일 refresh 동시 요청의 성공 1건, DB 실패 시 cookie 발급 0건, 재사용 거절과 실패 응답의 cookie 변경 0건을 검증한다.
- duplicate logout, logout/refresh 경쟁 뒤 해당 계정 refresh 행 0건, 오래된 access의 만료 전 유효/만료 후 거절, refresh 철회·만료 후 재발급 거절을 분리해 검증한다. 한 계정의 로그인·refresh·logout은 다른 계정의 현재 refresh에 영향을 주지 않아야 한다. rotation 응답 유실 때 자동 재호출 없이 재로그인으로 복구하는 한계도 확인한다.
- CSRF bootstrap·정상 unsafe 요청, token/cookie 누락·변조·다른 binding·잘못된 Origin·비 JSON 거절과 cookie flags를 HTTP로 검증한다. 로그인 시 갱신·refresh 시 유지·logout 시 삭제도 확인하되 HMAC 알고리즘은 재구현하지 않는다. browser E2E는 로그인·재발급·복구·logout 여정에 집중하며 매 수정 전체 검사를 새로 만들지 않는다.
- test A/B owner로 모든 public command/query의 wrong-owner 결과가 0건인지 확인하되 production artifact/config에는 test bypass가 존재하지 않는지 별도 검사한다.

## References

- [NestJS Passport와 JWT](https://docs.nestjs.com/recipes/passport)
- [Passport Google OAuth 2.0 Strategy](https://www.passportjs.org/packages/passport-google-oauth20/)
- [csrf-csrf — signed double-submit과 로그인 binding](https://github.com/Psifi-Solutions/csrf-csrf)
- [Google 서버 기반 OAuth 흐름](https://developers.google.com/identity/protocols/oauth2/web-server)
- [AlmondYoung JwtAuthGuard — 전역 인증과 공개 예외 참고](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/apps/user-service/src/commons/guards/jwt-auth.guard.ts)
- [OAuth Security BCP — refresh rotation과 철회](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
- [OWASP — signed double-submit cookie](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#signed-double-submit-cookie-recommended)

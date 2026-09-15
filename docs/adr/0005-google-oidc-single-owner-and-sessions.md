# ADR-0005: Google OIDC 단일 소유자와 access/refresh JWT

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-14 — access/refresh JWT와 AlmondYoung의 작은 인증 구성 참고 범위 반영
- Canonical owner: Google OIDC admission, 단일 production owner와 서비스 JWT 발급·검증·재발급·로그아웃

## Context

devfootnote는 역할·초대·가입이 없는 단일 소유자 제품이다. 인증은 핵심 기술 과제가 아니므로 Google 로그인과 익숙한 NestJS Strategy/Guard, access JWT와 refresh JWT로 제한한다. 기존 opaque server session의 매 요청 DB 조회, idle expiry와 touch는 사용하지 않는다. JWT를 쓴다는 이유로 refresh 철회나 cookie 보안을 생략하지는 않는다.

이메일 주소, hosted domain, 표시 이름과 최초 로그인 사용자는 권한의 근거가 아니다. Google OIDC 검증과 configured owner 확인이 account/token 발급보다 먼저 실패 닫힘으로 동작해야 하며, Google provider token은 browser에 노출하지 않는다. 문서 전용 기준선 이전의 사용자 선택을 반영한 in-place 변경이며 기존 ADR 링크를 보존하기 위해 파일명은 유지한다.

## Decision

`identity`가 [ADR-0002](0002-modular-monolith-domain-ownership.md)의 public port를 통해 OIDC admission, owner account, pre-auth와 JWT/refresh 상태를 단독 소유한다. API adapter는 protocol과 cookie를 매핑할 뿐 admission을 재해석하거나 identity repository에 접근하지 않는다. production에는 배포 시 설정하고 검증한 Google OIDC `(issuer, subject)` tuple을 정확히 하나만 허용한다. email, `email_verified`, hosted domain, 이름, 최초 callback 또는 기존 cookie는 대체 근거가 아니다. 필수 인증 설정이 누락·중복·유효하지 않으면 fail closed하고 readiness가 실패한다.

서비스 JWT에는 `@nestjs/jwt`, `@nestjs/passport`, `passport`와 `passport-jwt`를 사용한다. `JwtStrategy`/`JwtAuthGuard`는 access 인증, `RefreshJwtStrategy`/`RefreshJwtGuard`는 refresh의 암호학적 검증을 연결한다. 현재 refresh의 DB 대조·원자적 교체는 Guard가 아닌 `identity.RefreshTokens`가 소유한다. 범용 인증 프레임워크, 별도 인증 서비스, RBAC, Redis token store, access denylist, 장치 관리와 token-family 추적은 만들지 않는다.

AlmondYoung의 NestJS controller/service, 전역 `JwtAuthGuard`와 명시적 `@Public()` 패턴을 참고한다. 우리 앱의 controller/strategy는 transport, `identity`의 service와 private repository는 발급·재발급·저장 책임으로 나누되 전달만 하는 manager 계층을 추가하지 않는다. 참고 저장소의 구형 JWT refresh 흐름과 신규 opaque OAuth 흐름을 혼합 복사하지 않으며 사용자 선택인 **refresh JWT**와 아래 최소 계약이 우선한다.

### Authorization 시작과 callback

검증과 code 교환은 직접 구현하지 않고 discovery, JWKS cache/rotation, Authorization Code flow와 claim 검증을 지원하는 유지보수되는 표준 OIDC client를 사용한다. 정확한 library와 호환 가능한 stable version은 scaffold에서 pin한다.

1. `BeginLogin`은 cryptographically secure한 single-use `state`, nonce와 PKCE verifier를 생성한다. verifier 원문은 짧은 TTL의 server-side pre-auth transaction에 browser binding, 생성 시각과 요청한 exact callback URI와 함께 저장하고 authorization request에는 S256 challenge만 보낸다.
2. authorization request는 최소 scope `openid`와 필요한 최소 identity scope만 요청한다. offline access를 요청하지 않으며 browser storage, URL, client-readable cookie에 provider token이나 verifier를 두지 않는다.
3. callback은 HTTPS와 고정된 exact allowlist의 scheme/host/port/path인지 먼저 확인한다. forwarded host/proto는 명시적으로 신뢰한 proxy에서 온 값만 사용하며 request parameter로 redirect URI를 선택하지 않는다.
4. callback은 허용 HTTP method, state 존재·TTL·single-use·constant-time equality·browser binding·exact redirect URI를 검증하고 state를 원자적으로 consume한다. 그 뒤에만 server가 PKCE verifier로 authorization code를 교환한다.
5. standards client가 ID token signature와 허용 algorithm, exact issuer, 이 client의 audience와 필요한 `azp`, nonce, 발급/만료/not-before clock 조건을 검증한다. 검증된 `(iss, sub)`를 configured tuple과 exact 비교한 뒤에만 owner account와 서비스 JWT/refresh write를 허용한다.
6. protocol, callback, token 또는 owner tuple mismatch는 account/서비스 refresh/provider credential을 0건 생성하고 기존 인증 상태를 승격하지 않는다. consumed 또는 실패한 pre-auth transaction은 재사용할 수 없다. Google provider access/refresh/ID token은 callback 완료 후 폐기하고 PostgreSQL, Redis, log 또는 browser에 보존하지 않는다. 아래 서비스 refresh JWT와 Google refresh token은 별개다.

callback URI는 환경별 exact allowlist로 관리한다. production allowlist에 localhost, wildcard, suffix match, arbitrary return URL 또는 test callback을 넣지 않는다. 로그인 뒤 이동 목적은 server-side allowlist key로 제한하며 외부 URL을 redirect하지 않는다.

### 서비스 JWT와 최소 DB 상태

성공 callback은 pre-auth identifier를 폐기하고 owner를 재사용하거나 생성한 뒤 access/refresh JWT를 발급한다. `(issuer, subject)` unique와 단일-owner constraint로 concurrent callback의 중복 owner 생성을 막는다. 서비스 JWT의 `iss`는 서비스 issuer, `aud`는 고정된 서비스 audience, `sub`는 검증된 내부 owner ID다. Google의 `(iss, sub)`와 혼동하지 않는다.

- Access JWT: 유효기간 **15분**. 허용 algorithm을 `HS256`으로 고정하고 signature, 서비스 `iss`/`aud`, `sub`, `exp`와 `token_use=access`를 검증한다. 매 요청 refresh DB 조회나 idle touch를 하지 않는다.
- Refresh JWT: 최초 로그인 시점부터 **7일**의 고정 만료. 같은 로그인에서 rotation해도 이 만료 시각은 연장하지 않는다. 별도의 충분히 긴 signing secret과 `token_use=refresh`, 매 발급마다 새로운 cryptographically random `jti`를 사용한다. access와 동일한 검증에 더해 DB의 현재 token hash와 만료도 확인한다. access/refresh secret이 같거나 entropy가 부족한 설정은 거부한다.
- PostgreSQL에는 `identity` 소유 `auth_refresh_tokens`의 `owner_id` unique, 전체 JWT의 SHA-256 `token_hash`, `created_at`, `expires_at`만 둔다. 원문 JWT를 저장하지 않는다. 새 로그인은 owner의 기존 refresh를 교체하며 여러 기기의 독립적인 로그인 유지는 지원하지 않는다. 만료 행은 인증에서 즉시 거부하고 bounded cleanup으로 제거한다.

JWT와 DB 만료는 각각 `now >= exp` / `now >= expires_at`에서 거부하며 test clock으로 equality를 검증한다. refresh로 재발급할 수 있는 7일 기한은 새 Google 로그인에서만 다시 시작된다. 기한 직전에 발급된 access는 자신의 남은 15분까지 유효할 수 있다.

### Cookie, endpoint와 CSRF

웹과 API는 same-origin으로 제공한다. 서비스 access/refresh JWT는 모두 `Secure`, `HttpOnly`, `SameSite=Lax`, host-only(no `Domain`) cookie로만 browser에 보낸다. access는 `Path=/`, refresh는 `Path=/api/v1/auth`로 제한하고 만료/Max-Age를 토큰의 남은 수명에 맞춘다. pre-auth binding cookie도 HttpOnly이며 `Lax`로 Google top-level callback을 허용한다. localhost 개발의 Secure 예외가 필요하면 development 전용으로 제한하며 production에서는 허용하지 않는다.

callback 성공은 cookie 설정 후 고정된 제품 경로로 redirect한다. token을 query/fragment, JSON body, JS-readable cookie 또는 browser storage에 넣지 않는다. auth 응답에는 `Cache-Control: no-store`를 적용하고 cookie/token header를 telemetry에서 정제한다.

API 경로는 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)의 `/api/v1` prefix를 따른다.

- Google 시작/callback은 `/api/v1/auth/google`, `/api/v1/auth/google/callback`이며 access Guard의 명시적 예외다. callback은 위 OIDC 검증을 반드시 거친다.
- `POST /api/v1/auth/refresh`는 access Guard만 제외하고 refresh Guard와 CSRF 검사를 적용한다. access 만료/부재가 재발급을 막아서는 안 된다.
- `POST /api/v1/auth/logout`도 access 만료와 독립적이며 CSRF 검사 후 아래 로그아웃 계약을 수행한다.
- `GET /api/v1/auth/me`와 제품 API는 기본 access Guard로 보호한다. 다른 Guard가 붙었다는 이유만으로 access 인증을 생략하지 않는다. 공개 health probe가 있다면 content-free 경로만 명시적으로 예외 처리한다.

모든 unsafe 요청(특히 refresh/logout/동의 변경)은 **설정된 exact trusted `Origin`과 `X-CSRF-Protection: 1` custom header를 모두** 요구한다. Origin 누락·`null`·불일치는 거부하고 본문이 있는 mutation은 `application/json`만 받는다. same-origin이 기본이며 CORS가 필요하면 credentialed exact origin allowlist만 사용한다. wildcard, origin reflection, 임의 subdomain 허용과 단순 form 요청 우회는 금지한다. 이 browser API 패턴을 사용하므로 별도 server session이나 synchronizer CSRF token store는 만들지 않는다. OIDC GET callback만 state/nonce/PKCE로 보호하는 예외이며 자료 변경·logout·동의·예산 변경을 GET으로 수행하지 않는다.

### 재발급과 로그아웃

1. `RefreshTokens`는 검증된 refresh JWT의 owner, 전체 token hash와 고정 만료를 확인한다. 새 random `jti`의 후보 JWT를 만들고 짧은 Drizzle transaction에서 `owner_id + 현재 token_hash + expires_at > DB now` 조건으로 새 hash를 CAS 교체한다. 조회 후 무조건 update하지 않으며 성공한 한 요청만 commit 뒤 새 access/refresh cookie를 받는다. DB 실패 시 새 cookie를 발급하지 않는다.
2. 재사용·만료·CAS loser는 `401`이다. 실패 응답이 먼저 성공한 재발급의 cookie를 지우지 않도록 refresh 실패에서는 `Set-Cookie`를 변경하지 않는다. 프론트는 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)의 bounded 복구를 따른다. 탭 내부 single-flight는 편의이며 DB CAS를 대체하지 않는다.
3. rotation commit 뒤 응답이 유실되면 옛 refresh로 복구하지 않고 Google 재로그인을 요구할 수 있다. grace window, 이전 token 결과 cache, token-family replay 추적은 MVP에 넣지 않으며 완전한 탈취 탐지나 무손실 재발급을 주장하지 않는다.
4. `RevokeRefreshToken`은 유효한 refresh signature/용도/owner/만료를 검증한 뒤 해당 owner의 현재 refresh 행을 삭제하고 두 cookie를 동일 name/path 속성으로 지운다. rotation 직전 token으로 시작된 logout도 owner의 현재 행을 삭제하므로 logout과 refresh가 경쟁해도 새 refresh가 남지 않는다. 다른 owner는 삭제할 수 없다. 행이 이미 없으면 성공하며, token이 없거나 이미 만료/무효면 영속 상태 변경 없이 cookie만 정리한다. 필요한 DB 삭제가 실패하면 `503`으로 알리고 서버 철회 성공을 주장하지 않는다.
5. **로그아웃/새 로그인으로 refresh를 철회해도 이미 발급된 access JWT는 최대 15분 동안 유효하다.** 프론트는 로그아웃 때 사용자 cache와 진행 중 요청을 정리하지만 이것을 서버 즉시 철회로 표현하지 않는다. 즉시 access 철회가 실제 요구가 되면 별도로 재검토한다.

`RequireAccessToken`에서 얻은 owner를 모든 material, revision, search, answer, usage query/command의 predicate로 사용하며 client가 보낸 owner ID를 신뢰하지 않는다. production에는 test identity header, A/B owner switch, auth bypass 또는 first-user bootstrap이 없다. 교차 소유자 A/B identity는 test fixture로만 주입하고 production build/config에서 활성화할 수 없다.

오류, log, trace와 metric에는 authorization code, state, nonce, verifier, cookie, token hash, JWT, OIDC claims와 개인정보를 기록하지 않는다. browser 오류는 protocol 세부나 configured subject를 노출하지 않는 일반적인 인증 실패로 반환한다.

## Ownership

`identity`만 pre-auth, canonical owner account, 서비스 token 발급·검증과 refresh 교체·철회를 소유한다. `apps/api`는 standards client, Passport Strategy/Guard와 HTTPS callback/cookie/CSRF adapter를 구성하고 identity public port만 호출한다. PostgreSQL 표현과 explicit transaction 규칙은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)을 따른다. 다른 다섯 feature는 검증된 owner identity만 입력으로 받고 identity table이나 refresh repository를 직접 읽거나 쓰지 않는다.

## Consequences

- 이메일 변경, domain claim과 최초 방문자 선점으로 production owner가 바뀌지 않는다.
- Google provider token은 폐기하고 서비스 access/refresh JWT만 관리한다.
- exact callback, server-side pre-auth와 state/nonce/PKCE 검증 때문에 여러 환경의 callback 설정과 proxy trust를 엄격히 운영해야 한다.
- access 인증에 매 요청 DB 조회·idle touch가 필요 없지만 즉시 access revoke는 지원하지 않는다. refresh 현재 hash 1건과 원자 교체만 관리하며 응답 유실 시 재로그인을 허용한다.
- 단일 owner 제약은 team account·초대·복구 관리자를 지원하지 않는다. 그 요구가 생기면 admission과 authorization 모델을 새로 결정해야 한다.

## Verification

- standards OIDC test server로 valid flow와 signature/algorithm/JWKS, issuer, audience/`azp`, nonce, issued-at/not-before/expiry 실패를 검증하고 실패마다 account/서비스 refresh/provider-token persistence가 0건인지 확인한다.
- state 누락·mismatch·재사용·만료, PKCE mismatch, browser binding, callback scheme/host/port/path/method, untrusted forwarded header와 open redirect를 검증한다.
- configured `(iss, sub)` 일치만 성공하고 email/domain/name/first caller, missing/duplicate config와 wrong issuer 또는 subject는 0건을 만드는지 real PostgreSQL integration으로 확인한다.
- callback의 pre-auth 소모, 새 login의 refresh 교체, provider token의 browser/DB 보존 0건과 서비스 JWT의 HttpOnly cookie 외 노출 0건을 확인한다. JWT 원문은 DB·Redis·log·URL·browser storage에 없어야 한다.
- access/refresh algorithm·key·issuer·audience·용도·subject 검증, token 바꿔 넣기 거절, access 15분/refresh 고정 7일의 만료 equality와 회전 후 같은 refresh expiry를 controllable clock으로 검증한다.
- 실제 PostgreSQL integration으로 정상 rotation, 같은 초의 발급마다 다른 refresh `jti`, 동일 refresh 동시 요청의 성공 1건, DB 실패 시 cookie 발급 0건, 재사용 거절과 실패 응답의 cookie 변경 0건을 검증한다.
- duplicate logout, logout/refresh 경쟁 뒤 refresh 행 0건, 오래된 access의 만료 전 유효/만료 후 거절, refresh 철회·만료 후 재발급 거절을 분리해 검증한다. rotation 응답 유실 때 자동 재호출 없이 재로그인으로 복구하는 한계도 확인한다.
- browser E2E로 cookie flags/path/no-Domain, access 만료 뒤 refresh 성공, refresh 실패 뒤 로그인 복귀, 모든 mutation의 exact Origin+custom header, Origin 누락/null·simple form·cross-site 요청 거부, unsafe GET 부재와 logout 뒤 사용자 cache 제거를 검증한다.
- test A/B owner로 모든 public command/query의 wrong-owner 결과가 0건인지 확인하되 production artifact/config에는 test bypass가 존재하지 않는지 별도 검사한다.

## References

- [NestJS Passport와 JWT](https://docs.nestjs.com/recipes/passport)
- [AlmondYoung JwtAuthGuard — 전역 인증과 공개 예외 참고](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/apps/user-service/src/commons/guards/jwt-auth.guard.ts)
- [OAuth Security BCP — refresh rotation과 철회](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
- [OWASP — browser API의 custom-header CSRF 방어](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)

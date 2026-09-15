# ADR-0007: OpenAPI client와 프론트엔드 상태 경계

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-15 — Terminus 기본 검사는 유지하고 health 전용 응답 계층·임시 status API·선행 요청 추적을 제거; health OpenAPI는 상태·설명으로 제한
- Canonical owner: HTTP contract, generated client, frontend dependency와 상태 소유권

## Context

devfootnote의 Next.js web과 NestJS API는 독립적으로 조립되지만 하나의 명시적 HTTP 계약을 공유해야 한다. backend runtime DTO를 web에 직접 공유하거나 endpoint별 fetch wrapper와 query key를 손으로 반복하면 contract drift가 생긴다. 반대로 작은 세 화면 제품에 범용 global store나 생성된 모든 abstraction을 도입하면 상태 소유권이 흐려진다.

화면과 디자인 계약은 [ADR-0006](0006-frontend-information-architecture-and-design.md), AI 동의·답변 상태는 [ADR-0008](0008-ai-provider-consent-budget-grounding-and-retention.md)이 소유한다.

## Decision Drivers

1. checked-in OpenAPI와 실제 API 응답 및 생성 client의 drift를 차단한다.
2. server, form, URL, local transient state를 각각 가장 좁은 owner에 둔다.
3. browser가 backend 구현 package나 private DTO에 runtime 의존하지 않게 한다.
4. 인증 만료, revision 충돌, optional subsystem 저하를 화면별로 일관되게 복구한다.

## Decision

### HTTP와 OpenAPI

NestJS API의 일반 endpoint는 `/api/v1` 아래에 둔다. 사용자 선택에 따라 AlmondYoung의 `ResponseInterceptor`와 `GlobalExceptionFilter` 책임 분리를 참고하되 우리 코드로 작게 구현한다. 기존 RFC 9457 결정은 이 문서 전용 기준선 이전 변경으로 대체하며 두 오류 형식을 병행하지 않는다. JSON 응답은 `application/json`을 사용하고 실제 HTTP status를 보존한다.

성공 JSON은 **`{ success: true, data: T }`**다. controller는 응답 DTO만 반환하고 API 전역 `ResponseInterceptor` 한 개가 한 번만 감싼다. controller/service에서 직접 같은 envelope를 만들거나 generator와 interceptor에서 이중으로 감싸지 않는다. 본문 있는 성공의 `data`는 생략하지 않으며 반환값이 없으면 명시적으로 `null`을 사용하거나 endpoint를 `204`로 선언한다. 목록의 items와 pagination은 해당 응답 DTO의 `data` 안에 두며 무조건적인 전역 `meta`·timestamp·message 필드는 추가하지 않는다.

```json
{ "success": true, "data": { "id": "material-example", "revision": 1 } }
```

오류 JSON은 **`{ success: false, error: string, message: string }`**이며 필요할 때만 검증 오류 `errors`를 추가한다. `error`는 UI 분기용 안정된 코드이고 `message`는 안전한 사용자 안내다. 프론트는 message 문자열을 파싱하지 않는다. 요청 ID·추적 header는 초기 HTTP 계약의 필수 항목이 아니며 ADR-0009의 후속 관측 단계에서 필요할 때 도입한다. 예를 들어 revision 충돌은 HTTP `409`와 다음 본문을 반환한다.

```json
{ "success": false, "error": "MATERIAL_REVISION_CONFLICT", "message": "자료가 변경되었습니다. 최신 내용을 확인해 주세요." }
```

`GlobalExceptionFilter` 한 개가 예상된 도메인 오류, Nest `HttpException`과 알 수 없는 오류를 처리한다. API adapter가 도메인 error code를 HTTP status·공개 message로 매핑하며 HTTP 표현을 backend 도메인에 전파하지 않는다. transport 내부에서 필요한 공통 `ApplicationException` 하나는 사용할 수 있지만 오류마다 상속 class나 범용 exception registry를 미리 만들지 않는다. unknown 오류는 모든 환경에서 `500 / INTERNAL_SERVER_ERROR`와 일반 안내로 응답한다. 알려진 오류도 명시적으로 허용한 필드만 직렬화하고 원래 exception payload를 그대로 전달하지 않는다.

ValidationPipe 오류의 `errors`는 `{ field, code, message }[]`로 정규화한다. field path와 validation code는 DTO의 허용 목록에 속해야 하고 공개 message에 거부된 입력값을 넣지 않는다. 원본 validator issue, exception, SQL, provider payload, prompt, cookie/token, 사용자 원문, 요청 URL query, `devMessage`와 `stack`은 응답과 telemetry에서 제외한다. 개발 환경도 예외가 아니다. `401`/`403`/`409`/`429`/`503` 등 실패를 HTTP `200`으로 바꾸지 않고 `Retry-After` 같은 의미 있는 응답 header도 보존한다.

OAuth `3xx` redirect, `204`, `HEAD`/`304`처럼 본문이 없는 응답은 성공 interceptor에서 감싸지 않는다. 내용에 `success` 필드가 있다는 이유로 자동 추정하거나 이를 위해 `RawResponse` 같은 metadata·범용 opt-out 계층을 만들지 않는다. refresh/logout 성공은 cookie 설정·삭제와 `204`로 끝나며 token JSON을 반환하지 않는다. OpenAPI 파일 생성은 HTTP interceptor와 별개다.

health도 일반 성공·오류 JSON을 사용한다. `live`는 `{ status: 'ok' }`를 바로 반환하고, `ready`만 Terminus의 `HealthCheckService`·`HealthIndicatorService` 기본 API로 기존 DB 연결의 `SELECT 1`을 확인한 뒤 같은 데이터를 반환한다. 두 성공 응답은 일반 interceptor로 감싸고, 알려진 DB 불가·Terminus 실패는 전역 필터의 안전한 503으로 반환한다. 예상하지 못한 오류는 다른 API와 같은 정제된 500이다. Terminus가 만드는 `status/info/error/details`·종료 JSON을 외부 계약으로 유지하려고 probe 전용 DTO 계층·예외 필터를 만들지 않는다. 구체적인 의존성·검증 범위는 [ADR-0009](0009-verification-observability-and-search-evaluation.md#health와-slo-gate)가 소유한다.

Phase 0의 health OpenAPI는 성공 200·readiness 실패 503·일반 오류 500의 상태 코드와 설명만 명시한다. health 본문 타입만을 위해 별도 DTO·inline schema를 늘리지 않으며, 생성 SDK의 health body가 `unknown`이어도 허용한다. 실제 성공·오류 JSON은 HTTP contract test로 확인하고 타입 단언으로 생성 계약이 완전한 것처럼 만들지 않는다. 임시 `/api/v1/health/status`와 로그인 화면의 API ping은 제거하며, Phase 1의 실제 제품 API부터 아래의 DTO·생성 client 계약을 적용한다.

request DTO는 NestJS `ValidationPipe`의 transform/whitelist/forbid-non-whitelisted 정책과 명시적 validator로 검증한다. path/query/body coercion, length, enum, pagination boundary를 OpenAPI와 동일하게 표현한다. `ETag` 또는 명시적 `expectedRevision`을 사용하는 update는 stale write에 `409`/`412` 중 contract가 선택한 하나를 일관되게 반환하고 client가 최신 revision recovery를 제공한다. state-changing GET은 없다.

NestJS Swagger로 생성한 canonical OpenAPI 문서를 repository에 보존한다. operation ID는 안정되고 유일해야 하며 schema/success/error/auth security requirement를 실제 controller와 함께 생성한다. 제품 API에서는 interceptor가 Swagger schema를 자동으로 바꾸지 않으므로 실제 `success: true + data`와 `success: false + error/message` 구조, 선택적 검증 오류 및 body 없는 응답을 명시한다. 반복되는 제품 DTO 계약이 생기면 작은 응답 decorator/schema helper를 사용할 수 있지만 초기 health만을 위해 범용 Swagger DSL을 만들지 않는다. 위의 최소 health는 본문 schema 완전성 요구의 제한된 예외다. exact-pinned `@hey-api/openapi-ts`가 `packages/api-client`의 TypeScript types와 Fetch SDK를 생성한다. 생성물은 직접 편집하지 않는다. CI에서 같은 pinned command로 재생성한 결과가 clean이어야 한다.

web은 `packages/api-client`만 사용하고 `packages/backend`, Nest controller/service/DTO 또는 backend private path를 import하지 않는다. backend도 generated browser client에 의존하지 않는다. contract test는 checked-in OpenAPI, 생성물과 실제 대표 응답이 일치함을 검증한다. package exact 버전은 scaffold 시점의 호환 가능한 stable 조합으로 고정한다.

### 프론트엔드 구조와 import 경계

- `apps/web/src/app`: `/login`, `/library`, `/search`, `/documents/[materialId]`의 route, layout, provider와 composition만 소유한다.
- `apps/web/src/features/auth|library|search|documents`: feature UI, query/mutation option, form schema, 화면별 state mapping을 소유한다.
- `apps/web/src/components/ui`: shadcn/ui와 Radix 기반의 domain-neutral primitive만 소유한다.
- `apps/web/src/lib/api`: generated client 설정, same-origin JWT cookie transport와 bounded refresh, 공통 오류 normalization만 소유한다.
- `packages/api-client`: OpenAPI에서 생성된 code/type만 소유한다.

feature끼리 private file을 deep import하지 않는다. app route가 public feature entry를 조합한다. `components/ui`가 feature/query/API에 의존하거나 `lib/api`가 UI 정책을 알게 하지 않는다. package alias는 public entry만 노출한다.

### 상태 소유권

| 상태 종류 | Owner | 규칙 |
|---|---|---|
| material/search/auth readiness 같은 server state | TanStack Query | generated SDK 기반 query option과 안정된 key factory; cache는 서버 권위 대체 아님 |
| save/edit/consent/question form | React Hook Form + Zod | client validation은 UX이며 server validation을 대체하지 않음 |
| 검색어, filter, selected mode, pagination | URL search params | 공유·새로고침 가능한 상태; schema parse 후 사용 |
| dialog open, disclosure, focus target 같은 일시 UI | 가장 가까운 component | URL/history 가치가 없을 때만 local state |
| 인증 | HttpOnly access/refresh JWT cookie + `/api/v1/auth/me` query | 서비스 JWT를 JS로 읽거나 저장하지 않으며 Google provider token도 받지 않음 |
| generated answer/index readiness | server lifecycle | client timer나 BullMQ 상태로 성공을 추정하지 않음 |

Redux/Zustand 등 범용 global store는 추가하지 않는다. 서로 멀리 떨어진 여러 route에서 공유되고 URL/server/query/form/local state로 정확히 표현할 수 없다는 측정된 요구가 생길 때 별도 결정을 한다. Context는 stable dependency/provider에만 쓰며 mutable server cache를 복제하지 않는다. `localStorage`는 인증, 원문, answer, citation, consent, budget 또는 authoritative draft의 저장소가 아니다.

### Query와 mutation 규칙

query key는 feature의 public key factory에서 resource ID, normalized filter, current revision을 구조적으로 포함한다. 임의 문자열 key와 전체 cache 무효화는 금지한다. query function은 AbortSignal을 transport에 전달하고 component unmount나 새 검색에서 불필요한 request를 취소한다.

mutation 성공은 server가 반환한 authoritative row/revision으로 좁게 cache를 갱신한 뒤 영향받는 key만 invalidate한다. optimistic update는 되돌리기와 concurrent response ordering을 증명할 수 있는 가벼운 UI에만 사용하며 material save/delete, consent, budget reservation, answer publication에는 사용하지 않는다. 중복 submit은 UI disable만 믿지 않고 backend idempotency key/command 계약에 의존한다.

검색은 URL에서 normalized query를 읽고 빈 query에는 network call을 만들지 않는다. debounce는 UX 최적화이며 server rate/cost gate가 아니다. 이전 결과를 유지할 때는 새 query가 진행 중임을 표시하고 결과를 새 query의 것으로 오인시키지 않는다.

### 인증과 오류 복구

browser transport는 [ADR-0005](0005-google-oidc-single-owner-and-sessions.md)의 HTTPS same-origin access/refresh JWT cookie를 사용한다. JS는 서비스 JWT를 읽지 않고 Google provider token도 받지 않는다. unsafe 요청은 exact Origin 검증과 `X-CSRF-Protection: 1` header 계약을 따른다. OpenAPI는 access/refresh cookie security를 구분하며 refresh에 access security requirement를 잘못 붙이지 않는다.

access 인증의 `401`에는 browser transport가 `POST /api/v1/auth/refresh`를 **최대 한 번** 호출한다. 같은 탭의 동시 실패는 한 refresh promise를 공유하고, 성공 뒤 원요청을 최대 한 번 재전송한다. mutation 재전송은 backend가 멱등성을 보장하는 command에만 허용하고 기존 body, idempotency/request ID와 expected revision을 그대로 사용한다. 재전송이 안전하지 않은 요청은 자동 반복하지 않고 사용자에게 재시도 동작을 제공한다. refresh/logout/Google endpoint에는 이 interceptor를 재귀 적용하지 않으며 TanStack Query retry와 중첩해 횟수를 늘리지 않는다.

refresh가 `401`이거나 재전송도 인증 실패면 private query cache를 지우고 안전한 현재 경로만 return target으로 보존해 `/login`으로 이동한다. refresh `503`·network 오류는 자동 refresh loop나 무조건 logout으로 바꾸지 않고 연결 오류와 명시적 복구를 제공한다. 회전 commit 뒤 응답 유실 또는 탭 간 경쟁 때문에 재로그인이 필요할 수 있으며 token grace/cache/범용 cross-tab coordinator는 만들지 않는다. 실패 refresh 응답은 cookie를 변경하지 않는다. access 만료만으로 server layout이 먼저 `/login`으로 보내 이 복구 경로를 막지 않도록 browser auth readiness에서 판단하고, 실제 보호는 API Guard가 수행한다.

logout은 진행 중인 refresh/제품 요청과 충돌하지 않게 시작 순서를 정리하고, 완료 시 pending query를 취소하며 private cache와 이전 요청의 늦은 UI 결과를 폐기한다. token은 JS 저장소가 아니라 서버의 만료 cookie로 제거한다. 이 UX 정리는 기존 access JWT의 즉시 서버 철회를 뜻하지 않는다. `403`은 refresh나 재로그인으로 권한이 생긴다고 암시하지 않으며 owner mismatch나 존재 여부를 드러내지 않는 resource denial을 일관되게 표시한다.

생성 SDK가 노출하는 HTTP JSON 성공 envelope의 `data`가 제품 데이터이며 SDK 자체의 transport result와 구분한다. 구체적인 SDK 반환 option은 scaffold에서 pin한 버전으로 contract test한다. 오류는 HTTP status와 본문의 `error`를 UI state로 매핑하고 `errors`를 form field에 연결한다. 알려지지 않은 error code나 JSON이 아닌 proxy/network 오류는 안전한 generic 오류를 보여 준다. revision conflict는 사용자의 입력을 몰래 덮지 않은 채 최신 자료를 다시 읽는 선택을 제공한다. retry는 idempotent read 또는 backend idempotency가 보장된 command에만 자동/명시적으로 허용한다. `429`의 `Retry-After`를 존중한다.

Redis, worker, embedding 또는 AI의 장애는 해당 readiness/answer query에만 degraded 상태를 만들며 자료 저장 commit, 현재 keyword 검색과 자료 읽기 cache를 전역 실패로 바꾸지 않는다. PostgreSQL 필수 경로 실패는 명시적 unavailable로 처리한다.

### Markdown과 외부 link

자료와 answer Markdown은 `react-markdown`과 `rehype-sanitize` allowlist로 렌더링한다. raw HTML, event handler, unsafe URL scheme은 허용하지 않는다. 외부 link는 사용자에게 목적지를 알 수 있게 하고 새 창이면 `rel="noopener noreferrer"`를 적용한다. citation은 임의 provider URL이 아니라 server가 게시한 current evidence ID와 reader anchor만 신뢰한다.

## Considered Options

1. **OpenAPI + Hey API SDK + TanStack Query를 feature가 얇게 조합** — 선택.
2. backend runtime DTO를 web과 공유 — deploy/runtime 결합과 private import를 만들어 기각.
3. OpenAPI type만 만들고 fetch/query wrapper를 모두 수작업 — 반복과 drift 때문에 기각.
4. 범용 global store에 server/form/UI 상태 통합 — authority가 중복되어 기각.
5. 모든 화면을 server component initial fetch로 통일 — authenticated interaction과 recovery를 복잡하게 하므로 기본값으로 기각; 측정된 waterfall 개선에는 국소적으로 사용할 수 있다.

## Consequences

- HTTP contract 변경은 OpenAPI diff와 generated client diff로 드러난다.
- 각 상태의 authority가 하나이며 optional subsystem 장애를 국소화한다.
- feature가 query/mutation UX를 소유하므로 generator 교체 없이 제품 의미를 표현한다.
- OpenAPI 생성물과 CI drift check를 유지해야 하는 비용이 생긴다.

## Verification contract

- OpenAPI lint, unique operation ID, generated-clean 검사를 수행한다.
- architecture test는 web→backend runtime/deep feature import, UI→API 역의존, cycle을 실패시킨다.
- MSW component test는 성공 envelope, error code·검증 errors·unknown/non-JSON 오류, 동시 401의 refresh single-flight·원요청 1회 재전송·멱등 key 유지, refresh 401/503/network 오류 구분, 403, 409/412, 429, cancellation과 degraded state를 검증한다.
- API integration은 ValidationPipe의 unknown field·boundary 거부, 성공 envelope 1회 적용, 도메인/HttpException/unknown 오류의 status·안전한 본문, redirect/204 등 본문 없는 응답과 제품 API의 실제 response/OpenAPI/generated type 일치를 검증한다. health는 DB 정상·장애·복구와 실제 일반 JSON 계약, OpenAPI의 상태 코드·설명 및 SDK 호출 경로를 확인하되 unknown 본문 타입을 완전한 typed schema로 주장하지 않는다. 폐기된 probe 전용 예외·종료 JSON·opt-out은 검사 대상으로 유지하지 않는다. 원문·token·stack이 포함된 예외 fixture도 모든 환경에서 응답·로그 노출 0건이어야 한다.
- Playwright는 URL state 복원, access 만료 후 HttpOnly cookie 재발급, refresh 만료 후 로그인 복귀, logout 뒤 private cache/late response 정리, duplicate submit, stale revision recovery, Redis/AI 장애 중 core 화면 지속을 검증한다.

## Revisit triggers

측정된 SSR waterfall, offline editing 요구, 또는 URL/query/local state로 표현할 수 없는 실제 cross-route client state가 생겼을 때만 해당 경계를 별도 ADR로 재검토한다.

## 참고한 구현

AlmondYoung의 다음 파일에서 작은 interceptor/filter 분리와 JSON 필드 구성을 참고했다. 외부 코드를 그대로 복사하거나 그 저장소의 debug payload·인증·배포 구성을 함께 도입하지 않는다.

- [ResponseInterceptor — success/data 참고; opt-out 기능은 도입하지 않음](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/libs/shared/src/interceptors/response.interceptor.ts)
- [GlobalExceptionFilter — success/error/message](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/libs/shared/src/filters/http-exception.filter.ts)

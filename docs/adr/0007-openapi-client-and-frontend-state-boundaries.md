# ADR-0007: OpenAPI client와 프론트엔드 상태 경계

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-10-01 — semantic POST·활성화 계약과 멱등 인증 복구
- Updated: 2026-09-16 — CSRF bootstrap·생성 SDK·서명된 double-submit token과 인증 JWT 경계 분리
- 문서 정리: 2026-09-30 — 현재 계약·실행 기록 분리; 제품 검증 재실행 없음
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

생성 명세는 API가 소유하는 `apps/api/openapi.json`에 두고 Git으로 관리한다. `packages/api-client`는 이 파일을 입력으로 SDK·타입을 생성한다. `docs/`는 사람이 읽는 요구사항·설계·작업 문서를 보관한다. 명세와 SDK는 직접 수정하지 않고 `pnpm openapi:generate`로 함께 재생성하며 `pnpm openapi:check`로 drift를 검사한다.

#### DTO와 응답 조립 책임

업무 오류는 각 모듈이 소유하며 HTTP status를 갖지 않는다. 전역 필터 옆 `domain-error-response.ts`의 `toDomainErrorResponse()`가 명시적인 분기로 각 모듈의 `{ status, error, message }` 매핑을 선택하고, `satisfies`로 오류 kind 누락을 검사한다. 필터는 공통 오류 분류·정제·로그·직렬화를, 인접 함수는 업무 오류의 공개 표현을 맡는다. 두 파일 모두 앱의 HTTP 조립 경계다. 공통 BusinessError·범용 registry·오류별 상속 계층은 도입하지 않는다. 모듈별 필터는 교차 모듈에서 전파되는 오류와 middleware 오류의 처리 범위가 흩어지므로 현재 도입하지 않는다.

HTTP DTO는 `apps/api/src/modules/<feature>/dto/` (materials는 `presentation/dto/`)에 두며 입력은 필요한 request DTO, 출력은 공개 response DTO로 구분한다. DTO는 class-validator·Swagger 계약이고 backend Service의 입력·결과 타입이나 Drizzle row가 아니다. Service는 업무 결과만 반환하고 Controller가 공개 필드만 response DTO의 `from()` 또는 작은 명시적 객체에 맞춰 선택한다. 의미 있는 변환이 반복될 때만 작은 mapper를 분리한다.

성공 경로는 `Request → Guard/Pipe·request DTO → Controller → Service → 업무 결과 → Controller의 response DTO → ResponseInterceptor`다. 저장 책임이 분리된 경우 Service가 Repository를 사용한다. 성공 envelope와 본문 없는 응답의 처리는 아래 HTTP 계약을 따른다. Swagger schema는 wire JSON 문서화용이지 Service 반환 객체가 아니다.

`from()` 사용 자체를 모든 응답에 강제하지 않는다. 중첩 결과·날짜 변환은 DTO의 `from()`, 짧은 결과는 Controller의 명시적인 객체 반환으로 공개 필드를 선택한다. `Promise<ResponseDto>`라는 타입만으로 내부 필드가 제거되지는 않으므로 Service 결과 전체를 그대로 반환하거나 spread하지 않는다. indexing preview는 업무 결과의 승인 설정·intent를 DTO에서 공개 필드로 좁히고, 활성화·철회는 Controller가 작은 응답 객체를 만든다.

이 중앙 매핑이 feature의 공개 오류를 아는 결합은 의도적으로 유지한다. `common`은 feature를 모르며 dependency-cruiser가 역방향 의존을 차단한다. Service에서 HttpException을 던지거나 원본 Error.message·SQL·provider 오류를 응답으로 복사하지 않는다. 공개 오류 DTO는 필요할 때 `common/dto/`에 공유하되 별도 공용 package는 만들지 않는다.

NestJS API의 일반 endpoint는 `/api/v1` 아래에 둔다. 사용자 선택에 따라 AlmondYoung의 `ResponseInterceptor`와 `GlobalExceptionFilter` 책임 분리를 참고하되 우리 코드로 작게 구현한다. 기존 RFC 9457 결정은 이 문서 전용 기준선 이전 변경으로 대체하며 두 오류 형식을 병행하지 않는다. JSON 응답은 `application/json`을 사용하고 실제 HTTP status를 보존한다.

성공 JSON은 **`{ success: true, data: T }`**다. controller는 응답 DTO만 반환하고 API 전역 `ResponseInterceptor` 한 개가 한 번만 감싼다. controller/service에서 직접 같은 envelope를 만들거나 generator와 interceptor에서 이중으로 감싸지 않는다. 본문 있는 성공의 `data`는 생략하지 않으며 반환값이 없으면 명시적으로 `null`을 사용하거나 endpoint를 `204`로 선언한다. 목록의 items와 pagination은 해당 응답 DTO의 `data` 안에 두며 무조건적인 전역 `meta`·timestamp·message 필드는 추가하지 않는다.

```json
{ "success": true, "data": { "id": "material-example", "revision": 1 } }
```

오류 JSON은 **`{ success: false, error: string, message: string }`**이며 필요할 때만 검증 오류 `errors`를 추가한다. `error`는 UI 분기용 안정된 코드이고 `message`는 안전한 사용자 안내다. 프론트는 message 문자열을 파싱하지 않는다. 요청 ID·추적 header는 초기 HTTP 계약의 필수 항목이 아니며 ADR-0009의 후속 관측 단계에서 필요할 때 도입한다. 예를 들어 revision 충돌은 HTTP `409`와 다음 본문을 반환한다.

```json
{ "success": false, "error": "MATERIAL_REVISION_CONFLICT", "message": "자료가 변경되었습니다. 최신 내용을 확인해 주세요." }
```

`ApiEnvelope(ResponseDto, status)` 합성 데코레이터가 `ApiExtraModels`·`getSchemaPath`로 공통 성공 envelope와 data schema를 선언한다. auth·materials·search 모두 같은 데코레이터를 사용하며 `{ success, data }` DTO를 엔드포인트마다 복제하지 않는다. `PaginationQueryDto`/`PaginationResponseDto`는 page·pageSize·hasNext의 HTTP 계약만 공유한다. 목록은 현재 규모에서 offset 페이지 방식이며 저장소 query는 feature가 소유한다. 타입 검사·OpenAPI 재생성만으로 실제 JSON이 보장되지는 않으므로 대표 HTTP 응답을 함께 확인한다.

자료 목록의 `data`는 `items`, `page`, `pageSize`, `totalCount`, `hasNext`를 제공한다. 전체 페이지 수는 프론트에서 `ceil(totalCount / pageSize)`로 계산하므로 중복된 `totalPages`·`hasPrevious` 필드는 추가하지 않는다. 빈 목록은 화면에서 1페이지로 표시하고 범위 밖 요청은 빈 items와 실제 totalCount를 반환한다. 검색 응답에 전체 개수를 의무화하지 않는다.

`GlobalExceptionFilter`는 위 업무 오류 매핑 외에 Nest `HttpException`과 알 수 없는 오류를 분류한다. unknown 오류는 모든 환경에서 `500 / INTERNAL_SERVER_ERROR`와 일반 안내로 응답한다. 알려진 오류도 명시적으로 허용한 필드만 직렬화하고 원래 exception payload를 그대로 전달하지 않는다.

body-parser의 본문 크기 초과는 `413`, 지원하지 않는 charset/content encoding은 `415 / CLIENT_ERROR`로 보존한다. 알려진 parser 오류의 type·status/statusCode·expose 조합만 인정하며 임의 Error의 status를 HTTP 권한으로 신뢰하지 않는다. 잘못된 JSON은 Nest가 변환한 `400`을 유지한다. 원본 body·parser message는 응답이나 로그로 복사하지 않는다. 현재 Express와 DI 의존 없는 필터에는 `useGlobalFilters(new GlobalExceptionFilter())`를 사용하며, `APP_FILTER`나 adapter 추상화는 필요한 의존성이 생길 때 도입한다.

ValidationPipe 오류의 `errors`는 `{ field, code, message }[]`로 정규화한다. field path와 validation code는 DTO의 허용 목록에 속해야 하고 공개 message에 거부된 입력값을 넣지 않는다. 원본 validator issue, exception, SQL, provider payload, prompt, cookie/token, 사용자 원문, 요청 URL query, `devMessage`와 `stack`은 응답과 telemetry에서 제외한다. 개발 환경도 예외가 아니다. `401`/`403`/`409`/`429`/`503` 등 실패를 HTTP `200`으로 바꾸지 않고 `Retry-After` 같은 의미 있는 응답 header도 보존한다.

OAuth `3xx` redirect, `204`, `HEAD`/`304`처럼 본문이 없는 응답은 성공 interceptor에서 감싸지 않는다. 내용에 `success` 필드가 있다는 이유로 자동 추정하거나 이를 위해 `RawResponse` 같은 metadata·범용 opt-out 계층을 만들지 않는다. refresh/logout 성공은 cookie 설정·삭제와 `204`로 끝나며 token JSON을 반환하지 않는다. OpenAPI 파일 생성은 HTTP interceptor와 별개다.

health도 일반 성공·오류 JSON을 사용한다. `live`는 `{ status: 'ok' }`를 바로 반환하고, `ready`만 Terminus의 `HealthCheckService`·`HealthIndicatorService` 기본 API로 기존 DB 연결의 `SELECT 1`을 확인한 뒤 같은 데이터를 반환한다. 두 성공 응답은 일반 interceptor로 감싸고, 알려진 DB 불가·Terminus 실패는 전역 필터의 안전한 503으로 반환한다. 예상하지 못한 오류는 다른 API와 같은 정제된 500이다. Terminus가 만드는 `status/info/error/details`·종료 JSON을 외부 계약으로 유지하려고 probe 전용 DTO 계층·예외 필터를 만들지 않는다. 구체적인 의존성·검증 범위는 [ADR-0009](0009-verification-observability-and-search-evaluation.md#health와-slo-gate)가 소유한다.

Phase 0의 health OpenAPI는 성공 200·readiness 실패 503·일반 오류 500의 상태 코드와 설명만 명시한다. health 본문 타입만을 위해 별도 DTO·inline schema를 늘리지 않으며, 생성 SDK의 health body가 `unknown`이어도 허용한다. 실제 성공·오류 JSON은 HTTP contract test로 확인하고 타입 단언으로 생성 계약이 완전한 것처럼 만들지 않는다. 임시 `/api/v1/health/status`와 로그인 화면의 API ping은 제거하며, Phase 1의 실제 제품 API부터 아래의 DTO·생성 client 계약을 적용한다.

request DTO는 NestJS `ValidationPipe`·class-validator로 transform/whitelist/forbid-non-whitelisted 정책을 적용하고 path/query/body·length·enum·pagination을 OpenAPI와 맞춘다. 같은 HTTP 입력을 backend Zod로 재검증하지 않는다. Zod는 기동 설정과 JWT 라이브러리가 검증한 payload의 구조·용도처럼 별도 신뢰 경계에서 사용한다. 자료 수정·삭제는 `expectedRevisionId`로 현재 revision을 확인하며 stale 요청은 HTTP `409 / MATERIAL_REVISION_CONFLICT`로 거부한다. 현재 ETag/412 방식은 사용하지 않으며 state-changing GET은 없다.

NestJS Swagger로 생성한 canonical OpenAPI 문서를 repository에 보존한다. operation ID는 안정되고 유일해야 하며 schema/success/error/auth security requirement를 실제 controller와 함께 생성한다. 제품 API에서는 interceptor가 Swagger schema를 자동으로 바꾸지 않으므로 실제 `success: true + data`와 `success: false + error/message` 구조, 선택적 검증 오류 및 body 없는 응답을 명시한다. 반복되는 제품 DTO 계약이 생기면 작은 응답 decorator/schema helper를 사용할 수 있지만 초기 health만을 위해 범용 Swagger DSL을 만들지 않는다. 위의 최소 health는 본문 schema 완전성 요구의 제한된 예외다. exact-pinned `@hey-api/openapi-ts`가 `packages/api-client`의 TypeScript types와 Fetch SDK를 생성한다. 생성물은 직접 편집하지 않는다. CI에서 같은 pinned command로 재생성한 결과가 clean이어야 한다.

web은 `packages/api-client`만 사용하고 API의 Nest controller/service/DTO 또는 backend private path를 import하지 않는다. backend도 generated browser client에 의존하지 않는다. contract test는 checked-in OpenAPI, 생성물과 실제 대표 응답이 일치함을 검증한다. package exact 버전은 scaffold 시점의 호환 가능한 stable 조합으로 고정한다.

### 프론트엔드 구조와 import 경계

- `apps/web/src/app`: `/login`, `/library`, `/search`, `/documents/[materialId]`의 route, layout, provider와 composition만 소유한다.
- `apps/web/src/features/auth|library|search|documents|indexing`: feature UI, query/mutation option, form schema, 화면별 state mapping을 소유한다.
- `apps/web/src/components/ui`: shadcn/ui와 Radix 기반의 domain-neutral primitive만 소유한다.
- `apps/web/src/lib/api-client.ts`: generated client 설정, same-origin JWT cookie transport와 bounded refresh, 공통 오류 normalization만 소유한다. `api-provider.tsx`는 안정적인 client·QueryClient 인스턴스를 제공한다.
- `packages/api-client`: OpenAPI에서 생성된 code/type만 소유한다.

feature끼리 private file을 deep import하지 않는다. app route가 public feature entry를 조합한다. `components/ui`가 feature/query/API에 의존하거나 `lib/api-client.ts`가 UI 정책을 알게 하지 않는다. package alias는 public entry만 노출한다.

### 상태 소유권

| 상태 종류 | Owner | 규칙 |
|---|---|---|
| material/search/auth readiness 같은 server state | TanStack Query | generated SDK 기반 query option과 안정된 key factory; cache는 서버 권위 대체 아님 |
| save/edit/consent/question form | React Hook Form + Zod | client validation은 UX이며 server validation을 대체하지 않음 |
| 검색어, pagination, 기존 mode 호환 값 | URL search params | 공유·새로고침 가능한 상태; schema parse 후 사용하며 mode 선택 UI는 없음 |
| dialog open, disclosure, focus target 같은 일시 UI | 가장 가까운 component | URL/history 가치가 없을 때만 local state |
| 인증 | HttpOnly access/refresh JWT cookie + `/api/v1/auth/me` query | 서비스 JWT를 JS로 읽거나 저장하지 않으며 Google provider token도 받지 않음 |
| generated answer/index readiness | server lifecycle | client timer나 BullMQ 상태로 성공을 추정하지 않음 |

Redux/Zustand 등 범용 global store는 추가하지 않는다. 서로 멀리 떨어진 여러 route에서 공유되고 URL/server/query/form/local state로 정확히 표현할 수 없다는 측정된 요구가 생길 때 별도 결정을 한다. Context는 stable dependency/provider에만 쓰며 mutable server cache를 복제하지 않는다. `localStorage`는 인증, 원문, answer, citation, consent, budget 또는 authoritative draft의 저장소가 아니다.

### Query와 mutation 규칙

private query key는 feature의 public key factory에서 인증 account ID, resource ID, normalized filter, current revision을 구조적으로 포함한다. 임의 문자열 key와 무관한 전체 cache 무효화는 피하며 로그인 계정 변경 시에는 이전 계정의 private cache·pending request·늦은 UI 결과를 폐기한다. query function은 AbortSignal을 transport에 전달하고 component unmount나 새 검색에서 불필요한 request를 취소한다.

mutation 성공은 server가 반환한 authoritative row/revision으로 좁게 cache를 갱신한 뒤 영향받는 key만 invalidate한다. optimistic update는 되돌리기와 concurrent response ordering을 증명할 수 있는 가벼운 UI에만 사용하며 material save/delete, consent, budget reservation, answer publication에는 사용하지 않는다. 중복 submit은 UI disable만 믿지 않고 backend idempotency key/command 계약에 의존한다.

자료 생성·수정·삭제의 공통 영향은 해당 owner의 목록·검색 cache 무효화이며 `invalidateMaterialCollections`가 맡는다. 상세 cache는 수정 시 invalidate, 삭제 시 remove로 각 mutation이 처리한다. 다른 계정의 cache를 무효화하지 않고 staleTime=0의 화면 재진입 재조회에 기대지 않는다. 생성·수정의 서버 필드 오류는 자료 폼 전용 함수가 허용된 필드에 적용하며 입력을 보존한다. pending fieldset 해제 뒤 첫 오류 필드로 focus하고 오류 문구·revision 충돌 복구는 각 화면이 소유한다.

검색은 URL에서 normalized query를 읽고 빈 query에는 network call을 만들지 않는다. debounce는 UX 최적화이며 server rate/cost gate가 아니다. 이전 결과를 유지할 때는 새 query가 진행 중임을 표시하고 결과를 새 query의 것으로 오인시키지 않는다.

keyword는 GET·기존 page 계약을 유지한다. 의미/hybrid는 `POST /search/semantic`의 `q`, `mode`, UUID `requestId`를 가진 명시적 mutation이며 focus/reconnect/mount 자동 refetch와 자동 mutation retry를 하지 않는다. 같은 요청의 인증 복구에는 기존 body/request ID를 보존한다. 응답은 `requestedMode`, `effectiveMode`, `degradedReason`, `resultLimit=50`, `truncated`를 포함하며 `page=1`, `hasNext=false`로 후속 페이지가 없음을 표현한다. 성공 envelope 안의 keyword fallback은 의미 검색 성공으로 표시하지 않는다. URL의 mode는 복귀할 UI 상태일 뿐 새 외부 호출 승인이 아니다.

검색 화면에는 모드 선택을 두지 않는다. 준비 상태가 유효하면 명시 submit이 hybrid mutation을 만들고, 그렇지 않으면 GET keyword를 사용한다. semantic 실패·저하에는 실제 keyword 결과를 표시하며 이전 의미 결과를 성공으로 재사용하지 않는다. transport 응답 유실 뒤 재확인은 같은 request ID를 보존한다. ⓘ 도움말은 hover뿐 아니라 클릭·키보드 focus·Escape로 조작할 수 있으며 최초 전송 안내를 대신 숨기는 용도가 아니다.

활성화 preview는 현재 epoch·config·자료 상태와 `automatic`, `includeExisting`을 제공한다. 최초 자동 준비 mutation은 `includeExisting=true`, 빈 `targets`와 request ID를 보내 기존·미래 자료 범위를 명시적으로 승인한다. 기존 범위 제한 활성화는 새 승인 전까지 유지한다. 명시적 실패 재시도는 해당 current revision targets, `retryFailed`와 새 request ID를 사용한다. 동의·철회·활성화 후 관련 상태를 다시 조회하되 자료 저장 성공과 별개의 결과로 안내한다.

### 인증과 오류 복구

browser transport는 [ADR-0005](0005-google-login-and-sessions.md)의 same-origin JWT cookie를 사용하며 Google token·서비스 JWT를 읽지 않는다. unsafe 요청 직전에 생성 SDK로 공개 `GET /api/v1/auth/csrf`를 호출하고 `data.csrfToken`을 `X-CSRF-Token`에 넣는다. token을 장기 cache하지 않고 진행 중인 bootstrap promise만 공유한다. API는 exact Origin과 signed double-submit을 검증하며 binding은 로그인 시 갱신·refresh 시 유지·logout 시 삭제한다. OpenAPI는 JSON CSRF token과 인증 cookie를 구분하고 csrf bootstrap·refresh에 access security를 잘못 붙이지 않는다.

access 인증의 `401`에는 browser transport가 `POST /api/v1/auth/refresh`를 **최대 한 번** 호출한다. 같은 탭의 동시 실패는 한 refresh promise를 공유하고 성공 뒤 원요청을 최대 한 번 재전송한다. mutation은 backend가 멱등성을 보장할 때만 기존 body·idempotency/request ID·expected revision을 유지해 재전송한다. refresh/logout/Google/csrf bootstrap에는 이 처리를 재귀 적용하지 않으며 TanStack Query retry와 중첩하지 않는다. CSRF `403`을 JWT refresh로 복구하거나 mutation을 자동 반복하지 않는다.

현재 GET/HEAD, 멱등 자료 POST·PUT·DELETE, 활성화·동의 철회 POST와 semantic 검색 POST만 401 뒤 자동 복구한다. 첫 전송 전에 body를 복제하여 `idempotencyKey`·`expectedRevisionId`·`requestId`·기대 consent epoch를 그대로 유지하고 한 번만 재전송한다. 그 밖의 mutation은 자동 재전송하지 않는다. 이 인증 복구는 provider 자동 retry가 아니며 서버 receipt 또는 기대 epoch 검사가 같은 요청의 중복 effect를 차단한다. QueryClient의 기본 retry는 끈다. `features/auth`의 인증 경계가 `/auth/me` query, 로그인 이동·오류 복구·로그아웃 UI를 소유한다. 로그아웃은 진행 중인 private query를 취소하고 refresh 완료 뒤 요청하며, 성공한 client는 페이지 이동 전까지 보호 요청을 재개하지 않는다. 이렇게 늦은 조회가 refresh나 CSRF bootstrap을 다시 시작해 삭제한 cookie·cache를 되살리는 경쟁을 막는다.

refresh가 `401`이거나 재전송도 인증 실패면 private query cache를 지우고 안전한 현재 경로만 return target으로 보존해 `/login`으로 이동한다. refresh `503`·network 오류는 자동 refresh loop나 무조건 logout으로 바꾸지 않고 연결 오류와 명시적 복구를 제공한다. 회전 commit 뒤 응답 유실 또는 탭 간 경쟁 때문에 재로그인이 필요할 수 있으며 token grace/cache/범용 cross-tab coordinator는 만들지 않는다. 실패 refresh 응답은 cookie를 변경하지 않는다. access 만료만으로 server layout이 먼저 `/login`으로 보내 이 복구 경로를 막지 않도록 browser auth readiness에서 판단하고, 실제 보호는 API Guard가 수행한다.

`/auth/me`도 이미 확인한 owner가 있으면 network·5xx의 background 재조회 실패에서 같은 owner의 자식 화면·초안·재전송 ID를 유지하고 경고와 재시도를 제공한다. 최초 인증 확인 실패나 403 등 접근 거부는 화면을 차단한다. 이전 owner의 cache로 새 owner 화면을 표시하지 않으며, terminal 401은 아래 종료 경로를 그대로 따른다.

terminal auth는 `/auth/me`의 query 오류에만 의존하지 않는다. browser client는 위 두 조건에서 `TerminalAuthError`와 종료 신호를 한 번 발생시키고 진행 중 private 요청을 abort하며 새 요청을 차단한다. ApiProvider가 종료 상태를 유지하고 AuthBoundary가 자식 화면을 숨긴 뒤 query 취소·cache 정리·현재 상대 경로를 담은 로그인 이동을 한 번 수행한다. 이전 요청의 늦은 성공을 적용하지 않으며 403·503·network 실패는 이 상태를 만들지 않는다. 실제 returnTo의 allowlist와 OAuth state 연결은 ADR-0005가 소유한다.

생성 SDK의 JSON 응답은 `unwrapApiResult`로 제품 data를 꺼내고 HTTP status·허용된 error code·검증 issues를 공통 정규화한다. feature는 한국어 안내·필드 오류 연결·revision 충돌 복구를 계속 소유한다. 자료 목록/current와 검색 key는 feature-local `materialKeys`·`searchKeys`를 사용하며 범용 key framework는 만들지 않는다.

logout은 진행 중인 refresh/제품 요청과 충돌하지 않게 시작 순서를 정리하고, 완료 시 pending query를 취소하며 private cache와 이전 요청의 늦은 UI 결과를 폐기한다. token은 JS 저장소가 아니라 서버의 만료 cookie로 제거한다. 이 UX 정리는 기존 access JWT의 즉시 서버 철회를 뜻하지 않는다. `403`은 refresh나 재로그인으로 권한이 생긴다고 암시하지 않으며 owner mismatch나 존재 여부를 드러내지 않는 resource denial을 일관되게 표시한다.

logout의 차단 상태는 request interceptor에서 CSRF bootstrap **전에** 시작한다. logout에 필요한 CSRF GET은 허용하고 이미 진행 중인 bootstrap은 공유하되 다른 unsafe 요청은 bootstrap 전에 거부한다. 이전 bootstrap을 기다리던 mutation도 취소된 signal을 확인해 전송하지 않는다. 진행 중 refresh의 응답을 기다린 뒤 logout을 전송하며, bootstrap·전송 실패 시에만 새 요청을 허용해 명시적으로 다시 시도할 수 있게 한다. 성공 뒤에는 새 bootstrap으로 삭제된 cookie를 되살리지 않는다.

문서의 background refetch가 network·5xx로 실패해도 이전 data와 편집 초안은 유지하며 최신 상태를 확인하지 못했다는 경고와 재시도를 표시한다. data 없는 최초 실패는 blocking error이고, 400·403·404는 이전 본문도 숨기고 접근 불가로 표시한다. terminal 401은 인증 경계가 처리한다. 삭제 충돌 복구는 `refetch().isSuccess`일 때만 성공으로 처리한다. cached data의 존재만으로 dialog·충돌 상태를 닫지 않으며 일시 장애에는 실패 안내와 재시도를 유지한다.

편집 충돌의 명시적 최신 내용 불러오기는 TanStack mutation으로 pending·오류를 관리한다. 진행 중에는 입력·저장·취소·중복 불러오기를 잠가, 늦은 응답이 새 초안을 덮지 않게 한다. 성공했을 때만 확인한 최신 revision으로 폼을 바꾸며 실패하면 기존 초안을 유지한다.

생성 SDK가 노출하는 HTTP JSON 성공 envelope의 `data`가 제품 데이터이며 SDK 자체의 transport result와 구분한다. 구체적인 SDK 반환 option은 scaffold에서 pin한 버전으로 contract test한다. 오류는 HTTP status와 본문의 `error`를 UI state로 매핑하고 `errors`를 form field에 연결한다. 알려지지 않은 error code나 JSON이 아닌 proxy/network 오류는 안전한 generic 오류를 보여 준다. revision conflict는 사용자의 입력을 몰래 덮지 않은 채 최신 자료를 다시 읽는 선택을 제공한다. retry는 idempotent read 또는 backend idempotency가 보장된 command에만 자동/명시적으로 허용한다. `429`의 `Retry-After`를 존중한다.

Redis, worker, embedding 또는 AI의 장애는 해당 readiness/answer query에만 degraded 상태를 만들며 자료 저장 commit, 현재 keyword 검색과 자료 읽기 cache를 전역 실패로 바꾸지 않는다. PostgreSQL 필수 경로 실패는 명시적 unavailable로 처리한다.

### 답변 HTTP 계약 — 2026-10-07

`GET /answers/configuration`, `POST /answers/consent`, `POST /answers/consent/revoke`, `POST /answers`와 `GET /answers/:requestId`를 생성 SDK로 호출한다(공통 `/api/v1` prefix 생략). 생성은 202와 현재 처리 상태를 반환하며 HTTP 수락을 답변 게시 성공으로 해석하지 않는다. 동일 요청 ID·동일 입력은 저장 상태를, 다른 입력은 409를 반환한다. 답변 예산 초과는 429이며 동의·설정·근거 오류는 안정된 `ANSWER_*` 코드로 구분한다.

답변 POST 세 경로는 서버 멱등성 계약을 전제로 access 만료 시 같은 본문으로 한 번만 재전송한다. query polling·명시적 조회 재시도는 생성 POST를 다시 실행하지 않는다. 조회 실패 시에는 문서 읽기와 달리 이전 답변을 숨긴다. 근거 revision·동의가 이미 바뀌었을 수 있기 때문이다. 답변 claim은 Markdown을 해석하지 않는 일반 텍스트이며 citation href는 서버가 공개 DTO로 만든 경로만 쓴다.

2026-10-13 자료별 대화 확장: `history`에는 최근 게시 답변 최대 3개의 request ID와 화면에 남아 있는 질문을 전달한다. 브라우저가 답변 본문을 권위로 제공하지 않으며 서버가 같은 owner·단일 자료·현재 revision·유효 동의·미만료의 저장 답변을 읽어 문맥을 만든다. history도 멱등 fingerprint에 포함되므로 응답 유실 재시도에서 변경하지 않는다. 자료 상세는 임베딩 완료 여부와 무관하게 현재 자료를 명시 근거로 사용한다.

`GET /answers/:requestId/events`는 생성 SDK의 SSE 경로로 처리 상태와 fenced publication을 통과한 최종 `AnswerResultDto`를 전달한다. 일반 JSON 성공 envelope와 `text/event-stream`은 구분한다. 스트림 연결·재연결은 조회일 뿐 생성·AI 재호출 승인이 아니며 매 결과 조회의 owner·동의·revision·만료 방어를 유지한다. 연결 실패 시 이전 답변을 숨기고 명시적인 상태 재확인을 제공한다. provider의 검증 전 token을 직접 전달하지 않는다. 새 채팅 세션 저장 API는 추가하지 않고 UI 대화 목록은 해당 자료 화면 메모리에 둔다.

### Markdown과 외부 link

자료와 answer Markdown은 `react-markdown`과 `rehype-sanitize` allowlist로 렌더링한다. raw HTML, event handler, unsafe URL scheme은 허용하지 않는다. 외부 link는 사용자에게 목적지를 알 수 있게 하고 새 창이면 `rel="noopener noreferrer"`를 적용한다. citation은 임의 provider URL이 아니라 server가 게시한 current evidence ID와 reader anchor만 신뢰한다.

등록·읽기 slice에서는 외부 Markdown 이미지를 자동 요청하지 않고 대체 설명으로 표시한다. 저장 자료 열람만으로 외부 추적 요청이 발생하지 않게 하며, 원문 자체는 바꾸지 않는다. 원문 heading은 앱의 제목·원문 section 아래에 배치한다. 등록 실패 시 같은 입력의 요청 ID를 컴포넌트 메모리에 유지하고 성공 전 폼을 비우지 않는다. 저장 응답의 식별자로 읽기 링크를 제공한 뒤 해당 계정의 목록·검색 cache를 무효화한다.

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
- dependency-cruiser는 web→backend runtime/deep feature import, UI→API 역의존, 앱 코드의 cycle을 실패시킨다. 생성 SDK 내부 타입 간 상호 참조는 생성기가 소유한다.
- MSW component test는 성공 envelope, error code·검증 errors·unknown/non-JSON 오류, 동시 401의 refresh single-flight·원요청 1회 재전송·멱등 key 유지, refresh 401/503/network 오류 구분, 403, 409, 429, cancellation과 degraded state를 검증한다.
- API integration은 ValidationPipe의 unknown field·boundary 거부, 성공 envelope 1회 적용, 도메인/HttpException/unknown 오류의 status·안전한 본문, redirect/204 등 본문 없는 응답과 제품 API의 실제 response/OpenAPI/generated type 일치를 검증한다. health는 DB 정상·장애·복구와 실제 일반 JSON 계약, OpenAPI의 상태 코드·설명 및 SDK 호출 경로를 확인하되 unknown 본문 타입을 완전한 typed schema로 주장하지 않는다. 폐기된 probe 전용 예외·종료 JSON·opt-out은 검사 대상으로 유지하지 않는다. 원문·token·stack이 포함된 예외 fixture도 모든 환경에서 응답·로그 노출 0건이어야 한다.
- Playwright는 URL state 복원, access 만료 후 HttpOnly cookie 재발급, refresh 만료 후 로그인 복귀, logout 뒤 private cache/late response 정리, duplicate submit, stale revision recovery, Redis/AI 장애 중 core 화면 지속을 검증한다.

## Revisit triggers

측정된 SSR waterfall, offline editing 요구, 또는 URL/query/local state로 표현할 수 없는 실제 cross-route client state가 생겼을 때만 해당 경계를 별도 ADR로 재검토한다.

## 참고한 구현

AlmondYoung의 다음 파일에서 작은 interceptor/filter 분리와 JSON 필드 구성을 참고했다. 외부 코드를 그대로 복사하거나 그 저장소의 debug payload·인증·배포 구성을 함께 도입하지 않는다.

- [ResponseInterceptor — success/data 참고; opt-out 기능은 도입하지 않음](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/libs/shared/src/interceptors/response.interceptor.ts)
- [GlobalExceptionFilter — success/error/message](https://github.com/LCNINE/almondyoung-server/blob/087bbf490fdef098caa9440c633d201295f5f71c/libs/shared/src/filters/http-exception.filter.ts)

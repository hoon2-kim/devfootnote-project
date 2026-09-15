# devfootnote 제품 명세

## 1. 문서 지위와 제품 목표

이 문서는 devfootnote의 canonical 제품 요구사항과 수용 기준을 소유한다. 구현 순서와 검증 선언은 [`plan.md`](plan.md), 기술 결정은 아래의 [ADR 기준선](#10-adr-기준선), 시각 설계의 원본 입력은 루트 [`DESIGN.md`](../DESIGN.md)가 소유한다. 현재 저장소는 Phase 0 scaffold 구현 중이며 제품 완성·검증 통과 또는 배포를 주장하지 않는다. 문서 전환 당시의 작업 경계는 아래에 보존하되 현재 작업 권한과 구현 상태는 최신 사용자 요청·plan·실제 검사 결과로 구분한다.

devfootnote는 개발 중 저장한 기술 메모와 근거 본문을 기억나는 한국어·영어·식별자 단서로 다시 찾고, 개인 메모와 저장 원문을 분리해 읽으며, 사용자가 명시적으로 요청할 때만 저장 근거에 제한된 답변을 제공하는 단일 소유자용 웹 제품이다.

역사적 교체 추적은 이것 하나뿐이다: `integration:github-oauth` → `integration:google-oauth`. 현재 인증 계약은 Google OIDC이며 이전 인증 통합은 현재 기능이나 의존성이 아니다.

## 2. 사용자, 진입점과 정확히 세 화면

Production 사용자는 배포 설정의 Google OIDC `(iss, sub)`와 정확히 일치하는 소유자 한 명뿐이다. `/login`은 제품 화면이 아닌 로그인 진입점이다. 인증 뒤 제품 화면은 다음 **정확히 세 개**다.

| 화면 | 책임 | 필수 상태 |
|---|---|---|
| 자료함 `/library` | 자료 목록, 생성·수정 form/panel, 출처와 최근 revision, keyword 및 의미 인덱싱 상태 | 빈 목록, 불러오는 중, 저장 중, 저장 실패, revision 충돌, 인덱싱 대기·실패·재시도 |
| 검색·질문 `/search` | keyword 기본 검색, 준비된 자료의 vector/hybrid 검색, filter와 fallback 이유, 명시적으로 요청한 근거 답변 | 초기·빈 결과, 검색 중, 부분 준비, fallback, 오류·재시도, 답변 대기·실패·만료·무근거 |
| 자료 읽기 `/documents/[materialId]` | 개인 메모와 저장 원문, source URL, revision, 근거 구간을 구분해 표시하고 수정·삭제 | loading, not-found/denied, stale citation, 삭제 확인·실패, 인덱싱 상태 |

대표 여정은 Google 로그인 → 자료 저장 → 한영 혼합 keyword 검색 → 메모와 원문 확인이다. 선택적으로 동의와 예산 gate를 통과한 의미 검색 또는 근거 답변을 사용하고, 수정·삭제 뒤 현재 revision과 인덱싱 상태를 확인한다. Redis, worker 또는 외부 AI가 없어도 저장 → keyword 검색 → 현재 원문 읽기는 끝까지 동작한다.

## 3. 기능 요구사항 선언

각 `F-*`는 이 표에서만 선언한다. 다른 문서는 `ref:F-*` 형식으로 참조하며 재정의하지 않는다.

| ID | 선언 | 결정 소유자 |
|---|---|---|
| `F-01` | 서버는 표준 Google OIDC Authorization Code+PKCE 흐름을 검증하고, configured production `(iss, sub)` 한 쌍에만 서비스 access/refresh JWT를 발급한다. Strategy/Guard로 access를 검증하고 PostgreSQL의 현재 refresh hash로 원자적 재발급·로그아웃을 처리한다. | [ADR-0005](adr/0005-google-oidc-single-owner-and-sessions.md) |
| `F-02` | 소유자는 본문과 선택적 제목·개인 메모·source URL·context를 idempotent하게 생성·수정·삭제한다. 저장 성공은 material, immutable revision, chunks, keyword projection, idempotency와 embedding intent를 함께 확정한 PostgreSQL commit이다. | [ADR-0003](adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md) |
| `F-03` | 저장 직후 현재 소유자·현재 revision·미삭제 자료를 keyword로 검색하고, 메모·원문·출처·근거 구간을 구분해 읽는다. | [ADR-0003](adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md) |
| `F-04` | commit 뒤 비동기 embedding을 lease와 revision fence로 게시한다. AI 설정·동의 전 저장된 현재 자료도 기존 화면의 명시적 활성화·재시도로 새 indexing work를 만들 수 있고, 준비된 현재 자료만 vector/hybrid 검색에 포함하며 불가할 때 이유가 있는 keyword fallback을 제공한다. | [ADR-0004](adr/0004-bullmq-embedding-delivery-retry-and-fencing.md) |
| `F-05` | 사용자의 명시적 요청에만 durable evidence snapshot과 consent/budget reservation을 만든 뒤 transaction 밖에서 provider를 호출하고, 재검증된 현재 근거의 인용을 가진 답변 또는 설명 가능한 no-answer를 게시한다. | [ADR-0008](adr/0008-ai-provider-consent-budget-grounding-and-retention.md) |
| `F-06` | 모든 query·job·citation·usage에 server-derived owner/current/deleted predicate를 적용하고, 동의·예산·보존·삭제 fence와 content-free telemetry로 사용자 자료와 비밀을 보호한다. | [ADR-0008](adr/0008-ai-provider-consent-budget-grounding-and-retention.md) |
| `F-07` | 로그인 진입과 세 화면은 repository-owned 디자인 문법을 devfootnote 의미로 적용하고 keyboard, focus, label/error, screen reader, non-color cue, reduced motion, 44×44 touch 및 좁은 화면 사용성을 제공한다. | [ADR-0006](adr/0006-frontend-information-architecture-and-design.md) |

## 4. 수명주기와 정합성 계약

이 절은 `ref:F-02`, `ref:F-03`, `ref:F-04`, `ref:F-05`, `ref:F-06`의 상태 전이 계약이다.

### 자료와 revision

- `Material`은 `ACTIVE → DELETED`로만 삭제 전이하며 삭제된 자료는 즉시 읽기·검색·답변 근거에서 제외된다.
- 모든 수정은 immutable `Revision`을 추가하고 material의 current revision pointer를 기대 revision CAS로 바꾼다. stale 수정은 충돌이며 기존 입력을 보존한다.
- idempotency key와 canonical input fingerprint가 같으면 같은 결과를 반환하고, 같은 key의 다른 입력은 충돌한다. 동시 생성·수정은 DB constraint와 transaction으로 한 효과만 남긴다.
- 현재 revision의 원문, chunks, keyword projection과 durable embedding intent는 한 transaction에서 all-or-none이다. 저장 응답은 Redis 또는 embedding을 기다리지 않는다.

### 인덱싱과 검색

- `materials`의 embedding intent는 저장 transaction에서 생성된 뒤 변경하지 않는 작업 의도다. 상태 전이는 별도의 `indexing` work에만 있으며 `PENDING → LEASED → CALLING → PUBLISHED`, retry 시 `CALLING → RETRY_WAIT → PENDING`, 종료 시 `FINAL_FAILED | OBSOLETE`를 사용한다. `OBSOLETE`는 삭제·비현재 revision·consent/config fence 불일치로 더는 실행하지 않는 terminal work state다.
- AI 설정·동의 전 저장된 intent는 대기 중인 현재 revision 의도로 남는다. 이후 사용자가 자료함 또는 검색 화면에서 의미 검색을 활성화하거나 실패한 현재 자료를 재시도하면 current revision·승인된 config·consent epoch·budget을 확인해 새 indexing work를 만든다. 기존 terminal work나 intent는 수정하지 않으며 같은 activation request의 반복과 같은 active config/epoch 조합은 중복 work를 만들지 않는다. 동의 철회 뒤 재동의도 새 epoch의 명시적 활성화로 처리한다.
- BullMQ 완료는 전달 상태일 뿐 effect 증거가 아니다. PostgreSQL의 owner, material, revision, embedding config, deletion, consent epoch와 lease token이 모두 일치하는 fenced publication만 `PUBLISHED`다.
- 중복·늦은 worker와 삭제 또는 새 revision 뒤 결과는 게시하지 않는다. repair는 활성화 receipt가 요구하는 누락 work와 non-terminal work의 delivery만 복구한다. 설정·동의가 없는 dormant intent나 terminal work를 자동 부활시키지 않는다.
- keyword는 항상 현재 revision을 대상으로 한다. vector는 완전히 게시된 현재 revision만 대상으로 하며 hybrid는 SQL에서 owner/current/deleted filter 후 안정적으로 dedupe한다.

### 답변과 보존

- answer request는 `REQUESTED → RESERVED → RUNNING → PUBLISHED | NO_ANSWER | FAILED | EXPIRED | INVALIDATED`로 전이한다. 동일 request/reservation의 late·duplicate 결과는 한 번만 게시·정산한다.
- pre-call transaction은 표시 가능한 evidence snapshot, consent epoch, expiry와 budget reservation을 함께 기록하고 request를 `RESERVED`로 만든다. 별도 짧은 claim transaction이 `RESERVED → RUNNING`과 call-attempt `STARTED`를 commit한 뒤에만 provider를 호출한다. provider network call 동안 DB transaction이나 connection을 보유하지 않는다.
- `RESERVED`에서 호출 전 실패한 요청은 비용 노출 없이 만료·해제할 수 있다. `RUNNING` 이후 timeout·crash처럼 호출 결과가 불명확한 요청은 provider별 보수적 비용 정책으로 정산하며 무조건 무료로 해제하지 않는다.
- post-call transaction은 owner, request, reservation, consent epoch, expiry, material deletion, current revision과 citation 범위를 다시 검사한다. 답변 게시 가능 여부와 이미 발생했거나 발생했을 수 있는 비용 정산 여부는 독립적으로 판정하고 각각 exactly-once 전이한다.
- 같은 owner·request ID·canonical input fingerprint의 재요청은 유효한 저장 결과를 추가 provider 호출 없이 반환한다. 같은 ID의 다른 입력은 충돌하며, 재조회도 current revision·삭제·동의·만료 fence를 통과해야 한다. 짧은 answer body 보존 기간이 끝나도 중복 호출 방지 receipt는 별도 기간 유지한다.
- 근거 밖 사실을 확정하거나 검증되지 않은 citation을 게시하지 않는다. 근거 부족·provider 오류·stale evidence는 기존 저장·keyword 검색·읽기를 실패시키지 않는다.
- 외부 전송 consent는 기본 off다. consent 철회·자료 삭제·만료는 새 호출과 결과 접근·게시를 즉시 막고 관련 파생 AI 자료를 24시간 안에 삭제한다. 원문/prompt와 raw provider response는 durable AI artifact나 log/trace/metric label로 저장하지 않는다.

## 5. 소유권과 공개 port

| Entity 또는 전이 | 단일 소유 module | 허용된 공개 경계 |
|---|---|---|
| OIDC admission, account, access/refresh JWT 발급·검증, refresh 교체·철회 | `identity` | identity command/query ports |
| material, revision, chunk, keyword, idempotency, embedding intent의 save transaction | `materials` | Save/Update/Delete/Read ports |
| delivery, lease, attempt, retry/final/repair, embedding publication | `indexing` | intent delivery/publication ports |
| keyword/vector/hybrid query와 dedupe | `search` | owner-scoped Search port |
| answer request, snapshot, citation, answer lifecycle | `answers` | pre-call/post-call answer ports |
| consent, budget reservation/settlement, usage와 retention | `usage-retention` | consent/reservation/settlement/deletion ports |

`apps/api`와 `apps/worker`는 composition, transport와 lifecycle만 소유한다. 업무 규칙과 transaction은 `packages/backend`의 feature별 Module·Service·Repository로 구성하는 간단한 모듈러 모놀리스에 둔다. 여기서 public port는 이름 있는 업무 호출 계약이며 공개 Nest Module과 Service 메서드로 구현할 수 있다. 모든 기능에 interface·UseCase 계층을 강제하지 않으며 외부 AI 등 실제 실패 격리 경계만 좁은 port로 분리한다. 다른 module의 private repository나 schema에 접근하지 않는 소유권·DAG 계약은 유지한다. 저장 machinery, queue adapter와 provider adapter는 정책이나 도메인 전이를 소유하지 않는다. consumer·scheduler 등록은 worker 전용이며 공유 Module을 가져오는 것만으로 API에서 기동되지 않는다.

## 6. 장애와 성능 저하 계약

| 실패 | 계속 제공하는 기능 | 노출·복구 계약 |
|---|---|---|
| Redis/BullMQ 중단 | 저장, 현재 keyword 검색, 읽기·수정·삭제 | 저장은 성공하고 인덱싱 `PENDING`/degraded를 표시하며 durable intent repair 뒤 재개 |
| embedding/provider 중단 또는 AI 미동의·예산 차단 | 저장, keyword 검색, 읽기 | vector/answer를 성공처럼 위장하지 않고 구체적 fallback/block 이유와 retry 가능 여부 표시 |
| worker crash/duplicate/late result | 이미 commit된 자료와 keyword | lease expiry와 durable repair; fence 불일치 결과는 무효화 |
| PostgreSQL 불가 | liveness와 순수 access JWT 검증은 가능하나 로그인·재발급·서버 logout 처리·저장·검색·읽기는 unavailable | readiness 실패와 content-free 진단; DB가 필요한 작업의 성공 응답 또는 메모리 fallback 금지 |
| stale revision, 삭제 또는 consent revoke가 provider 호출과 경쟁 | 저장·keyword·현재 읽기 | 답변 publish/access는 차단하고 request를 invalidated 처리하되, 실제 또는 불명확한 호출 비용은 별도 exposure 정책으로 exactly-once 정산 |

초기 SLO는 측정 전 주장하지 않는다. 저장·검색·queue·provider 지연, fence 거부와 repair를 분리해 측정한다.

## 7. 인증, 보안과 privacy

이 절은 `ref:F-01`과 `ref:F-06`의 경계다.

- 유지보수되는 standards client가 discovery/JWKS, signature, exact issuer, audience, 시간, state, nonce, PKCE와 exact callback allowlist를 서버에서 검증하고 code를 서버에서 교환한다.
- protocol·callback·configured tuple 검증이 끝나기 전 account/서비스 refresh write와 서비스 JWT 발급은 0건이다. email, hosted domain, display name, client-provided owner 또는 first-caller bootstrap은 admission 근거가 아니다.
- Google provider access/refresh/ID token은 browser나 장기 저장소에 보존하지 않는다. 성공 callback은 pre-auth identifier를 폐기하고 서비스 access JWT(15분)와 refresh JWT(로그인부터 7일 고정)를 HttpOnly cookie로 발급한다. 두 종류의 JWT는 signing key·용도와 검증 경로를 분리한다.
- 현재 refresh는 owner당 PostgreSQL hash 한 건으로 관리한다. 재발급은 만료·현재 hash를 조건으로 원자 교체하고 access 만료와 독립적으로 동작한다. 새 로그인 또는 logout은 기존 refresh를 무효화하지만 기존 access JWT는 최대 잔여 15분 동안 유효하다. 즉시 access 철회·매 요청 세션 DB 조회·idle touch·인증용 Redis·장치 관리는 범위에 넣지 않는다.
- 서비스 cookie는 HTTPS 전용 `Secure`, `HttpOnly`, `SameSite=Lax`, 좁은 `Path`와 no `Domain`을 사용한다. cookie clear, exact Origin+custom header 기반 mutation CSRF를 적용하고 state-changing GET을 금지한다. token을 URL·JS storage·JSON 응답에 노출하지 않는다. 구체 endpoint·cookie·rotation 실패 계약은 ADR-0005를 따른다.
- production에는 test identity나 login bypass가 없다. A/B owner isolation은 production admission과 분리된 test runtime에서 검증한다.
- secrets, cookie/token/hash, 사용자 원문·메모·질문, prompt/answer, raw provider response와 source URL query를 telemetry에 기록하지 않는다. correlation과 metric label은 bounded pseudonym만 사용한다.

## 8. 디자인과 접근성

이 절은 `ref:F-07`의 화면 계약이다. [`DESIGN.md`](../DESIGN.md)의 `Notion Analysis`에서 정보 위계와 warm paper/white surface, typography, spacing, restrained radius/elevation, navigation/card/input/modal/empty/toast 문법만 적용한다. 글꼴은 **Inter**다. Notion 이름·logo·product copy·이미지·sticker·고유 asset·`NotionInter`를 복사하거나 사칭하지 않는다.

- canvas `#f6f5f4`, surface `#ffffff`, near-black/warm-gray text, hairline `#e6e6e6`, 8px-derived spacing을 사용한다.
- `#0075de`는 유일한 primary/action/link/focus accent, `#005bab`는 pressed다. error/warning/success/destructive는 별도 semantic token과 text/icon/ARIA를 함께 쓴다.
- `ink-faint` `#a39e98`는 정보 없는 장식에만 사용한다. Placeholder는 흰 surface에서 약 6.53:1인 `text-muted` `#615d59`처럼 일반 text 대비 4.5:1 이상인 token을 사용한다. large text·UI component·focus indicator는 3:1 이상의 WCAG AA를 충족한다.
- 모든 control은 persistent label 또는 screen-reader name과 명확한 focus를 갖고, 오류는 field와 연결되며 async/status 변화는 적절히 announce한다. dialog 종료 뒤 focus를 복귀한다.
- hover-only 의미를 금지하고 touch target은 최소 44×44다. tablet에서는 navigation을 collapse하고 mobile에서는 단일 열로 재배치하되 source·citation·primary action을 숨기지 않는다.

## 9. 고정 기술 스택

- **Workspace/runtime:** pnpm, Turborepo(Phase 0부터 최소 task 구성), Node.js LTS, strict TypeScript; 원격 cache는 초기 범위 아님
- **Local development / images:** 루트 `docker-compose.yml`로 PostgreSQL+pgvector를 실행하고 Phase 2부터 Redis를 추가한다. 평소 web/API/worker는 호스트의 pnpm·Turbo 개발 script로 실행한다. 별도 `app` profile은 각 앱 Dockerfile로 빌드한 runtime image의 전체 실행·smoke 검증에 사용하며 자동화된 DB·큐 통합 테스트는 별도 Testcontainers로 격리한다. 이미지·네트워크·데이터 보존 기준은 ADR-0001/0009를 따른다.
- **Frontend:** Next.js App Router, React, Tailwind CSS, shadcn/ui와 Radix, TanStack Query, React Hook Form과 Zod, `react-markdown`과 `rehype-sanitize`, Lucide
- **Backend/data/async:** NestJS modular monolith, PostgreSQL+pgvector, `pg`+`drizzle-orm/node-postgres`, `drizzle-kit` SQL migrations, Redis+BullMQ
- **Auth:** 표준 Google OIDC client, `@nestjs/passport`+`passport`+`passport-jwt`, `@nestjs/jwt`; access/refresh 모두 JWT
- **Contract:** Swagger, 공통 성공 `{ success: true, data }`·오류 `{ success: false, error, message }` JSON, checked-in OpenAPI, `@hey-api/openapi-ts` generated client; 세부 예외·검증 오류는 ADR-0007
- **Verification:** Vitest, React Testing Library, MSW, Supertest, Testcontainers, Playwright
- **Operations:** Nest 기본 기동 로그, 공유 Pino logger, 단순 liveness 응답과 Terminus 기본 API의 DB readiness. 커스텀 로그·probe 계층을 선행 구현하지 않으며 OpenTelemetry·요청 추적은 Phase 2 이후 실제 비동기 처리·운영 관측에 필요한 범위부터 도입한다.

Monorepo target은 `apps/web`, `apps/api`, `apps/worker`, `packages/backend`, `packages/api-client`부터 필요한 만큼만 만든다. 전체 목표 폴더 구조는 ADR-0001이 소유한다. API는 `src/auth`, `src/materials`, `src/search`, `src/answers`의 기능별 Controller·DTO와 `src/common`, `src/health`로 구성하고 모든 transport를 별도 `http` 폴더 아래에 몰지 않는다. frontend는 `src/app` route composition, `src/features`, `src/components/ui`, `src/lib` adapter 경계를 지키며 backend runtime이나 다른 feature private module을 import하지 않는다. UI·Tailwind·config 공용 패키지는 미리 분리하지 않는다. exact package version은 별도 승인된 scaffold에서 호환 가능한 stable 조합으로 고정한다. AI provider/model/version/dimension은 문서 단계에서는 미정이지만 첫 실제 embedding 또는 answer 호출 전에 품질·privacy·비용 evidence와 별도 승인으로 고정한다. 로컬 앱 이미지 제작·검증은 AWS runtime이나 배포 방식의 선택이 아니며 AWS region/SKU/topology는 Phase 6까지 결정하지 않는다.

## 10. ADR 기준선

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

## 11. 수용 기준 선언

각 `AC-*`는 이 표에서만 선언한다. `V-*`는 [`plan.md`의 검증 선언](plan.md#4-검증-선언)만 소유한다.

| ID | 선언 | 요구사항 참조 | 검증 참조 |
|---|---|---|---|
| `AC-01` | 로그인 진입과 정확히 세 제품 route만 존재하고 각 화면의 정상·빈·대기·실패·충돌·복구 상태가 관찰 가능하다. | `ref:F-07` | `ref:V-01`, `ref:V-10` |
| `AC-02` | 올바른 configured `(iss, sub)`만 서비스 JWT를 얻고 protocol/tuple negative는 account/refresh write 0건이다. 토큰 용도·만료 검증, access 만료 후 refresh, 원자 rotation·재사용 거절, logout 후 refresh 거절과 access 잔여 유효성, CSRF와 no-state-changing-GET 조건을 통과한다. | `ref:F-01`, `ref:F-06` | `ref:V-02`, `ref:V-03` |
| `AC-03` | 새 저장·동일 재전송·다른 payload 재사용·stale/concurrent update·삭제에서 정확한 단일 effect와 current revision 불변식이 실제 PostgreSQL에서 성립한다. | `ref:F-02` | `ref:V-04` |
| `AC-04` | Redis와 AI가 없어도 저장 직후 한영 혼합 keyword 검색으로 현재 원문과 메모를 owner 격리해 찾고 읽는다. | `ref:F-03`, `ref:F-06` | `ref:V-05`, `ref:V-11` |
| `AC-05` | AI 설정·동의 전 저장, 최초 활성화, 재동의, 명시적 재시도, queue loss, crash, duplicate, final failure, repair와 late-result 경쟁에서 terminal work를 되살리지 않고 필요한 새 work만 중복 없이 생성하며 현재 revision vector만 한 번 게시한다. 상태·fallback 이유가 정확하다. | `ref:F-04` | `ref:V-06` |
| `AC-06` | 답변은 explicit request+consent+budget 뒤에만 호출되고 snapshot citation에 grounded된다. 호출 전/후 장애와 재요청에서 결과는 idempotent하며, stale/delete/revoke/expiry 경쟁의 게시 차단과 실제·불명확 비용 정산을 독립적으로 exactly-once 판정한다. | `ref:F-05`, `ref:F-06` | `ref:V-07`, `ref:V-08` |
| `AC-07` | provider 전송·보존·telemetry 검사에서 금지 content/secret 0건이고 revoke/delete 뒤 즉시 차단과 24시간 내 파생 AI 자료 삭제가 성립한다. | `ref:F-06` | `ref:V-08`, `ref:V-12` |
| `AC-08` | optional subsystem 실패는 저장·현재 keyword 검색·읽기를 막지 않으며 PostgreSQL 장애는 성공으로 위장되지 않는다. | `ref:F-02`, `ref:F-03`, `ref:F-04`, `ref:F-05` | `ref:V-05`, `ref:V-06`, `ref:V-09` |
| `AC-09` | package와 여섯 feature module DAG는 acyclic이고 public port 외 deep import, cross-private repository와 app-owned rule/schema가 0건이다. | `ref:F-02`, `ref:F-04`, `ref:F-05`, `ref:F-06` | `ref:V-09` |
| `AC-10` | 세 화면이 Inter·semantic token·contrast·ARIA·keyboard/focus·reduced-motion·44×44·tablet/mobile 계약을 충족하고 금지 brand asset이 0건이다. | `ref:F-07` | `ref:V-10` |
| `AC-11` | OpenAPI/client와 frontend state 경계, fixed library names 및 provider/version/topology deferral이 ADR과 일치한다. | `ref:F-01`–`ref:F-07` | `ref:V-01`, `ref:V-09`, `ref:V-13` |
| `AC-12` | 동결된 40-case 검색·답변 평가와 분리된 1k/10k 성능 측정이 근거성, 무근거 응답, latency와 비용을 재현 가능하게 보고한다. | `ref:F-03`, `ref:F-04`, `ref:F-05` | `ref:V-11` |
| `AC-13` | 동일 worksheet를 두 검토자가 재계산해 같은 `finalTotalKRW`와 gate를 얻고 30,000 KRW 초과, 근거 누락, memory 또는 restore 실패를 BLOCK한다. | `ref:F-02`–`ref:F-06` | `ref:V-13` |
| `AC-14` | canonical 문서는 devfootnote만 설명하고 exact ADR link와 F/AC/V/non-goal typed graph가 완전하며 현재 문서 전환에서 Git·제품·test·IaC·cloud action은 0건이다. | `ref:F-01`–`ref:F-07`, `ref:NG-06`, `ref:NG-07` | `ref:V-14` |

## 12. Non-goal 선언

각 `NG-*`는 이 표에서만 선언한다.

| ID | 선언 |
|---|---|
| `NG-01` | 공개 self-signup, 초대, role, team, 공유·협업 권한과 복수 production owner |
| `NG-02` | crawler, browser extension, PDF/image OCR, YouTube 전사와 전체 GitHub code 분석 |
| `NG-03` | 장기 chat history, billing/subscription, 추천 feed, mobile app, Agent/MCP와 지식 graph |
| `NG-04` | 초기 reranker, HNSW tuning, 고급 chunking과 범용 workflow engine |
| `NG-05` | 문서 단계에서의 AI provider/model/dimension 또는 exact package version 선택; AI 구성은 첫 실제 호출 전 별도 gate에서만 고정 |
| `NG-06` | 이 문서 단계의 제품 code, config, manifest, migration, test 실행, Terraform, AWS resource와 deployment |
| `NG-07` | 이 문서 전환의 Git 초기화·commit·PR·push; source control은 나중에 별도 승인된 제품 scaffold 또는 구현에서만 시작 |
| `NG-08` | Notion identity, trademark, logo, product copy, imagery, sticker, proprietary font 또는 pixel copy |

# Phase 1 — 구현·검증 이력

상태: 완료 기록. 2026-09-17~21의 실행 당시 범위·결과를 보존한다. 당시 파일 경로와 미구현 항목은 현재 상태를 뜻하지 않는다. 최신 단계와 승인 범위는 [plan](../plan.md#현재-상태)을 따른다. 이 기록을 분리하면서 제품 검사나 벤치마크를 다시 실행하지 않았다.

## 초기 인증·화면 구현

첫 slice인 **환경 설정 + 인증**은 앱별 `.env.dev`·`.env.prod` 로딩, Nest Config·Zod 설정 검증, Google OAuth·서비스 JWT·인증 migration, 로그인 UI·인증 복구와 최소 `/library` 진입을 구현했다. `passport-google-oauth20`과 backend `auth`를 사용하며 실제 API·격리 PostgreSQL·Google 외부 응답 fixture 기반 브라우저 검증까지 완료했다. 실제 Google 계정의 로그인·새로고침 유지·로그아웃·보호 화면 접근은 사용자가 로컬에서 확인했다. 실제 비밀값 파일은 사용자가 관리한다. 이후 자료 CRUD·검색·읽기와 격리된 production 이미지의 HTTPS 검증을 추가했다. 실제 배포 도메인·공인 인증서 확인은 Phase 6 범위다. 책임 분리는 ADR-0001/0002, 응답 조립은 ADR-0007을 따른다.

후속 승인 범위인 **로그인 화면·공통 디자인 정리**도 구현했다. `DESIGN.md`와 ADR-0006 기준으로 로그인, 헤더·자료함 진입 안내, 인증 대기·오류·로그아웃 화면을 정리하고 shadcn/Radix Button과 Lucide를 필요한 곳에만 사용했다. 당시 모바일·태블릿·데스크톱, focus·skip link·동작 줄이기·axe를 포함한 브라우저 16개를 통과했다. 이후 목록·등록 폼·검색을 실제 API와 연결했다.

## 자료 구현과 후속 정리

2026-09-17 후속 승인 범위인 **자료 등록·목록·현재 원문 읽기**를 구현했다. backend `materials` Service는 입력 준비·멱등 경쟁의 업무 흐름을, Repository는 동일 tx의 revision/chunk/keyword/receipt/intent 저장과 owner/current/deleted 조회를, API Controller·DTO는 HTTP와 공개 응답을 소유한다. `/library`의 실제 등록 폼·목록과 `/documents/[materialId]`의 메모/원문 읽기를 생성 SDK로 연결했다. 당시 관련 Vitest 91개와 브라우저 21개를 통과했으며, 개발 DB 적용은 사용자 작업으로 남겼다. `0004` 생성 DDL과 `0005` 관계 제약은 격리 DB의 빈 DB 적용·이전 인증 schema upgrade로 검증했다. 이후 수정·삭제·키워드 검색 API와 화면, 앱 이미지를 구현했다.

2026-09-18 **API 모듈·테스트 구조 개편**: API 전용 backend 패키지를 modules로 통합하고 materials 저장 포트·공개 index·dependency-cruiser·공통 응답 선언을 적용한다. migration은 전체를 `apps/api/drizzle`로 이동하며 SQL/metadata를 변경하지 않는다. 중복 helper/scaffold 테스트를 줄이고 실제 DB/HTTP·브라우저 회귀와 순수 본문 규칙을 유지한다. env 모드는 실행 명령이 소유하며 실제 비밀 파일은 사용자가 관리한다. 범위·결과는 [개편 기록](2026-09-18-api-module-reorganization.md), 검증 정책은 ADR-0009를 따른다.

2026-09-18 **Phase 1 로컬 gate 완료**:

- `ref:V-01`–`ref:V-05`: 단위·HTTP 42개, 실제 PostgreSQL 통합 63개, 브라우저 27개 통과. 등록·목록·검색·읽기·수정·삭제, 두 탭의 revision 충돌과 최신 내용 복구, 응답 유실 재시도의 중복 방지, 계정 전환 뒤 자료·검색 격리, 페이지네이션을 검증했다. 검색·삭제 확인창의 320/1280px axe·스크린샷과 Escape 취소·포커스 복귀를 추가했다. 기존 인증·등록·읽기의 320/768/1280px 검사는 유지했다.
- `ref:V-09`: 실제 Compose app profile의 API·web·migration 이미지와 테스트 전용 PostgreSQL을 사용한 HTTPS 여정 1개 통과. production 설정의 Secure/HttpOnly/host-only cookie, CSRF 누락·다른 Origin 거부, refresh, Redis/AI 없는 저장·검색, 전체 앱/DB 재시작 후 보존, DB 장애 시 live 200/ready 503과 복구를 확인했다. web healthcheck를 추가해 `--wait`가 웹 응답 준비도 기다리게 했다.
- 검증 명령: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm openapi:check`, `pnpm test:browser`, `pnpm test:images`. CI에도 동일한 이미지 여정을 연결했다. 로컬 통과와 원격 GitHub Actions 실행은 구분한다.
- 코드 가독성 요청에 따라 Prettier·EditorConfig 및 ESLint 중괄호/빈 줄 규칙을 추가하고 소스·테스트 형식을 통일했다. 생성 SDK·OpenAPI·migration 이력과 문서는 일괄 포맷에서 제외한다. `pnpm format`으로 수정하고 `pnpm lint`에서 형식을 강제한다.
- 실제 사용자 env·개발 DB·migration 이력은 변경하지 않았다. Google 응답과 인증서는 격리 fixture이며 실제 Google 계정의 로컬 로그인은 앞선 사용자 확인을 근거로 한다. 공인 인증서·운영 도메인·클라우드 배포는 Phase 6, worker·AI 호출은 Phase 2 이후의 별도 승인 범위다. 이번 작업에서 commit/push는 하지 않았다.

#### Phase 1 리뷰 후속 수정 — 2026-09-19

- snippet의 전각/NFKC 일치 위치, 여러 필드에 분산된 토큰, surrogate 경계 오류를 기존 로직에서 3개 실패로 재현한 뒤 수정했다. 정규화 길이 변화·시작 경계·plain text·미리보기까지 좁은 단위 9개로 검증하고 실제 검색 HTTP 회귀를 추가했다.
- materials Service의 원문 준비·fingerprint는 유지하고, 기존 멱등 경쟁 처리는 Repository 안으로 옮겼다. 2026-09-17 기록의 Service 책임에서 이 부분만 변경했다. 저장 포트는 작업별 입력 객체와 `PageResult<T>`를 사용하며 `ReceiptRace`·추가 한 행 규약을 소비자에게 노출하지 않는다. SQL transaction·CAS·HTTP JSON·OFFSET·migration은 그대로다.
- `pnpm bench:search`로 1k/10k/20k 합성 자료의 실제 Repository SQL 27조건·총 360표본을 측정했다. 짧은 한글뿐 아니라 흔한 단어·과거 revision 비용을 확인했다. [당시 측정 요약](../benchmarks/keyword-search.md#phase-1-keyword-측정-2026-09-19)을 기준으로 후속 최적화를 판단하며 이번에 검색 의미나 index를 바꾸지 않았다.
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
- 동일 검색 fixture의 변경 전/후 27조건·각 실행 360표본을 비교했다. 모든 조건에서 저장 vector와 기존 표현식 SQL의 반환 행·순서가 같았다. 20k `인증` p50은 238.02→23.54ms, `공통기록`은 376.77→290.47ms였다. 흔한 단어·이력 증가 비용은 남아 있으며 projection·후보 제한·점수 변경은 도입하지 않았다. raw 표본과 계획은 로컬 test-results, 공개 요약·재현 명령과 한계는 당시 ADR-0009에 기록했다(현재 [검색 측정 기록](../benchmarks/keyword-search.md)에 보존).
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

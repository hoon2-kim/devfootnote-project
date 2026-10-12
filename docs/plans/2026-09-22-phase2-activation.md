# Phase 2 — 2단계: 명시적 활성화와 admission

상태: 2단계 API·DB 구현·검증 기록. 이후 책임 정리도 날짜별로 보존하며 [3단계 실행·복구](2026-09-22-phase2-recovery.md)의 완료를 뜻하지 않는다. 최신 상태와 승인 범위는 [plan](../plan.md#현재-상태)을 따른다.

## 범위와 승인 경계

사용자 승인에 따라 API·DB에서 동의, 비용 예약, 현재 자료의 bounded 활성화, 멱등 receipt와 commit 이후 전달을 구현한다. 실제 provider/model/가격·보존 기간은 아직 승인되지 않았으므로 제품의 승인 설정은 비어 있으며 활성화를 거부한다. 성공·경쟁 경로는 격리 테스트의 합성 설정만 사용한다. 실제 AI 호출, UI 활성화 공개, 자동 저장 후 활성화, retry/repair·publication은 후속 단계다. 개발 DB 적용·사용자 env 열람·commit/push는 하지 않는다.

## 원자 작업과 책임

- indexing Service가 전체 활성화 transaction을 소유하고 materials 공개 조회와 usage-retention 공개 admission을 호출한다. 각 저장소는 자기 schema만 접근한다.
- `nestjs-cls` transactional Drizzle adapter로 동일 transaction을 전파한다. 새 공개 협력 메서드는 활성 transaction을 요구하며 DB handle을 공개 인자로 전달하지 않는다. 기존 auth/materials 쓰기는 변경하지 않는다.
- 서버가 승인한 설정은 provider/model/version/dimension·입력 처리·policy/pricing·통화/정수 비용 단위·기간/한도·예약 만료를 명시한다. 기본 가격·기간·provider와 실행 가능한 fixture 설정을 제품 환경에 넣지 않는다.
- 활성화는 명시 동의, preview의 config/consent epoch, bounded 대상 current revision을 확인한다. receipt·동의 변경·예약·work 중 하나라도 실패하면 전체 rollback한다. Redis는 commit 뒤 호출하며 전달 실패로 DB 성공을 뒤집지 않는다.
- terminal work 자동 재활성화와 예약 자동 재생성은 하지 않는다. 명시적 실패 재시도·만료 예약과 lease 복구는 후속 slice에서 연결한다.

## 수용 기준과 검사

- 설정 없음·동의 없음·예산 부족·stale revision·다른 owner 요청은 work/예약을 남기지 않는다.
- 같은 요청 재전송은 저장된 결과를 반환하고 다른 fingerprint는 충돌한다.
- 같은 intent/config/epoch의 active work와 비용 예약은 동시 요청에도 중복되지 않는다.
- 예약·work·receipt 중간 실패는 실제 PostgreSQL에서 all-or-none이다.
- Redis에 전달되는 시점에는 별도 DB 연결에서 commit 결과를 볼 수 있고 전달 중 열린 활성화 transaction이 없다.
- 기존 저장·keyword·읽기는 미설정/Redis 장애에서도 유지한다.
- API DTO/envelope·인증/CSRF·OpenAPI·생성 SDK를 맞추고, `pnpm build:backend`, 좁은 실제 DB/Redis 통합, 타입/lint/아키텍처 검사 순으로 검증한다.

## 구현과 검증 결과

- 새 `usage-retention` 모듈이 동의·기간 예산·예약 ledger를, indexing이 preview·활성화·receipt를 소유한다. `0011_dear_meteorite.sql`은 이 다섯 table과 work의 owner-scoped 예약 FK를 추가한다. 기존 migration은 변경하지 않는다.
- `GET /api/v1/indexing/embedding/preview`, `POST /api/v1/indexing/embedding/activations`, `POST /api/v1/indexing/embedding/consent/revoke`를 OpenAPI와 생성 SDK에 반영했다. 현재 제품 설정이 없으므로 활성화는 409이고 UI에 기능을 노출하지 않는다.
- `pnpm openapi:generate`, `pnpm lint`, `pnpm typecheck`, `pnpm openapi:check` 통과. backend와 공유 패키지 빌드도 통과했다.
- `pnpm test`: 73개 통과. `pnpm test:integration`: 실제 PostgreSQL/Redis 110개 통과. 새 admission 검사는 인증·CSRF, 중간 실패 rollback, consent/shared-budget 잠금 경쟁, 다른 연결에서 commit 관찰, stale/삭제/owner, 철회·재동의, terminal 비부활, preview cursor, 정산액·만료 예약, Redis 중단을 포함한다.
- 첫 격리 검사에서 beforeAll timeout이 발생했다. 이후 기존 Redis fixture 기동 옵션과 맞춘 개별 검사 및 전체 통합 재실행은 통과했다. 최초 timeout의 원인을 확정했다고 주장하지 않는다. 포맷 검사 한 파일 실패는 수정 후 재실행해 통과했다.
- 이번 API·DB slice에서는 브라우저·전체 이미지 검사를 재실행하지 않았다. 실제 provider 호출·의미 품질·UI 동의 흐름·retry/repair·publication·정산 실행기는 미구현/미검증이다. 개발 DB migration, 실제 env 열람, commit/push는 하지 않았다. AGENTS 문구는 갱신했지만 새 Codex/Claude 세션의 로딩은 확인하지 않았다.

## 다음 단계

3단계에서 attempt·retry·lease 만료·repair와 동의/삭제/현재 revision fence를 구현한다. 예약 만료 후 호출 금지와 호출 시작 뒤 불명 비용의 보수적 정산을 함께 다룬다. 실제 provider/model·가격·보존 조건을 승인하기 전까지 합성 provider만 사용한다. activation receipt의 만료·수동 terminal 재시도·저장 이후 활성화 연결은 해당 상태 전이와 함께 검증하고 기존 terminal work를 자동 부활시키지 않는다.

## 동시기 후속 정리 기록

아래는 당시 plan에 기록한 공통 오류·인증·조회 책임 정리와 검증 결과다. 3단계 실행·복구의 완료 증거로 확대하지 않는다. 최신 상태는 [plan](../plan.md#현재-상태)을 따른다.

2026-09-21 검증: build/typecheck/lint·OpenAPI drift 검사 통과, 단위·HTTP 66개·실제 DB/Redis 통합 94개·브라우저 42개·HTTPS 이미지 여정 1개 통과. 기존 migration SQL·snapshot 20개와 journal의 이전 항목을 보존했다. `0010`은 격리 DB에만 적용했으며 개발 DB 적용과 실제 env 작성은 사용자 작업으로 남겼다.

2026-09-22 전체 리뷰 후속 수정:

- 전역 필터는 하나로 유지하고 업무 오류의 HTTP 매핑만 인접 정적 함수로 분리했다. body-parser의 413/415를 보존하고 API·worker의 Nest 내부 오류 출력에서 원본 message·stack·cause를 차단했다. 정상 Nest 기동 로그·기존 Pino는 유지한다.
- 활성화 preview·revoke의 DB 잠금 timeout을 기존 unavailable 계약으로 맞추고 source URL의 NUL을 DTO에서 차단했다. 자료 경쟁 검사와 인증 fixture의 정리를 보완했으며 DB schema·인증 방식·검색 SQL은 변경하지 않았다.
- 인증 background network/5xx에서 같은 owner의 초안·요청 ID를 유지하고, 편집 충돌의 최신 조회 중에는 새 입력·저장을 잠근다. 최초/403/terminal 인증 오류는 계속 화면을 차단한다. 누락된 화면 token과 feature 공개 entry 사용도 맞췄다.
- auth는 기존 책임 분리를 유지한다. [ADR-0002의 읽기 순서](../adr/0002-modular-monolith-domain-ownership.md#현재-코드를-읽는-순서), 필터 책임·CLS 적용 범위·현재 worker 단계의 문서 모순을 정리했다. frontend 공개 entry·UI/transport 역의존을 dependency-cruiser에 연결하고 테스트 타입 검사에 JSX를 허용했다.
- 수정 전 오류 경로 11개 실패를 확인한 뒤 수정 후 단위·HTTP 86개, 실제 PostgreSQL/Redis 통합 112개, 브라우저 45개, HTTPS 이미지 여정 1개가 통과했다. backend build, 전체 타입 검사, ESLint·Prettier·dependency-cruiser와 OpenAPI/SDK drift 검사를 통과했다. 브라우저에는 인증 일시 장애의 320px axe·초안 보존 및 최신 조회 pending 스크린샷이 포함된다.
- 재현 명령은 루트의 `pnpm test`, `pnpm test:integration`, `pnpm test:browser`, `pnpm test:images`다. 이번 Vitest·Playwright 실행은 pnpm 네트워크 제약 때문에 설치된 동일 실행기를 Node로 직접 실행했고, build/typecheck/OpenAPI는 승인 후 pnpm 명령으로 실행했다. 최초 네트워크 실패와 제품 테스트의 RED를 구분한다.
- cleanup 단계 자체의 실패 주입, 검색 성능 재측정, 실제 Google 재로그인·원격 CI·배포는 실행하지 않았다. worker의 종료 시간 상한·실제 provider 복구는 완료 주장에 포함하지 않는다. 실제 env·개발 DB·migration 이력·의존성은 변경하지 않았고 commit/push도 하지 않았다. AGENTS의 최신 단계 문구는 정리했으나 새 Codex/Claude 세션의 지침 로딩은 별도 확인하지 않았다.

2026-09-22 후속 책임 분리:

- `AuthService.completeLogin`이 기존 CLS transaction으로 계정 조회·생성, 로컬 토큰 발급과 refresh 해시 저장을 조합한다. Repository의 발급 callback·TokenService 의존을 제거하고, OAuth state·refresh CAS·logout은 유지했다. 저장소→Service 역의존은 dependency-cruiser로 막는다.
- materials의 목록·현재 원문·keyword 후보만 `MaterialsQueryRepository`와 Drizzle 조회 구현으로 분리했다. SQL·공개 API는 유지하고 receipt·revision 잠금·쓰기·활성화 intent 조회/잠금은 기존 저장소에 남겼다. 기존 검색 benchmark는 새 조회 구현을 사용하도록 연결했다.
- 활성화 대상 정규화·fingerprint를 순수 함수로 추출하고 최대 비용 계산은 usage-retention에서 공유한다. 동의·예약·work·receipt transaction과 commit 이후 큐 전달은 기존 Service에 유지했다. 새 업무 계층·의존성·schema·migration·AI 기능은 추가하지 않았다.
- 검증: backend build, 전체 타입 검사와 추가 테스트 타입 검사, ESLint·Prettier·dependency-cruiser(216 modules), OpenAPI/SDK drift 검사 통과. 단위·HTTP 96개, 격리 PostgreSQL/Redis 통합 합계 115개, 브라우저 45개, HTTPS 앱 이미지 여정 1개 통과. 통합 검사는 관련 4개 파일, DB/worker 2개 파일을 나눠 실행하고 COMMIT 거부 검사를 추가한 인증 47개를 다시 확인했다. 로그인 실패 시 신규 계정 rollback·기존 refresh 보존·서비스 cookie 미발급과 기존 실제 잠금 경쟁을 확인했다.
- 검색 SQL 성능 재측정은 하지 않았고 benchmark 진입점 구문 검사만 실행했다. SQL 이동을 성능 개선으로 주장하지 않는다. 실제 Google·AI 호출·개발 DB 변경·원격 CI·배포·commit/push와 새 세션의 AGENTS/CLAUDE 로딩 확인은 수행하지 않았다. 명령은 위 재현 안내와 같다.

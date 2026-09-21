# ADR-0009: 검증, 관측성과 검색 평가

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-20 — 인증 복구·DB 경쟁/수명주기 회귀와 CI 실행 경계 보강
- Canonical owner: 검증 계층, telemetry·health 계약, 검색·답변 품질 및 성능 평가

## Context

devfootnote의 핵심 주장은 transaction, PostgreSQL filter, BullMQ lease/fence, 외부 AI 호출 전후 경쟁처럼 mock만으로 증명할 수 없는 경계에 있다. 동시에 원문, 검색어, prompt와 answer를 관측성에 남기지 않고도 저장부터 indexing·검색·답변 publication까지 실패를 조사할 수 있어야 한다. 아직 운영 baseline이 없으므로 임의의 SLO나 품질 수치를 제품 보장으로 선언해서는 안 된다.

저장·indexing delivery 계약은 [ADR-0004](0004-bullmq-embedding-delivery-retry-and-fencing.md), answer의 consent·budget·grounding fence는 [ADR-0008](0008-ai-provider-consent-budget-grounding-and-retention.md), UI 상태 표현은 [ADR-0006](0006-frontend-information-architecture-and-design.md)이 소유한다. 이 ADR은 그 계약을 재정의하지 않고 어떤 evidence로 검증하고 운영 중 어떻게 관찰할지를 정한다.

## Decision Drivers

1. DB·queue의 실제 의미론을 mock 통과로 오인하지 않는다.
2. race와 crash window를 sleep이나 우연한 scheduling이 아니라 재현 가능한 barrier로 검증한다.
3. 검색·답변 품질, latency와 비용을 고정 corpus와 구성 snapshot으로 비교한다.
4. 사용자 content, credential과 고카디널리티 ID를 telemetry에서 배제한다.
5. baseline 전에는 SLO·attainment를 주장하지 않고 측정 사실과 장애 범위를 정직하게 표시한다.

## Decision

### 검증 계층

Vitest·RTL/MSW·Supertest·Testcontainers·Playwright 중 이번 변경의 계약을 증명하는 검사를 선택한다. 모든 변경에 모든 계층을 적용하거나 기존 검사로 충분한데 새 fixture·harness·script를 만들지 않는다. exact package version은 도입 시 호환 가능한 stable 조합으로 고정한다.

평소 로컬 개발은 [ADR-0001](0001-monorepo-and-package-boundaries.md)의 루트 `docker-compose.yml`로 DB·Redis를 실행하고 앱은 호스트에서 실행한다. 선택적인 `app` profile은 현재 단계에 존재하는 앱의 runtime image를 빌드·기동해 확인하는 용도다. 자동화된 DB·큐 통합 테스트는 별도의 Testcontainers 환경에서 실행하며 image smoke로 대체하지 않는다. 테스트는 자신이 시작한 컨테이너의 연결 정보를 주입받으며 개발·운영 DB URL, 고정 개발 포트 또는 개발 named volume으로 fallback하지 않는다. 테스트가 시작한 자원만 정리하고 개발 DB를 truncate/reset하거나 개발 volume을 삭제하지 않는다.

개발과 테스트는 도입 단계에 고정한 PostgreSQL·pgvector·Redis 버전과 같은 검토된 SQL migration을 사용한다. 테스트 간 상태는 독립 DB/schema 또는 명시적인 fixture 초기화로 격리한다. Docker 실행 환경이 없거나 컨테이너 준비에 실패하면 필요한 통합 검증을 미실행/실패로 보고하며 mock으로 대체해 통과시키지 않는다. 컨테이너·제품 테스트 실행은 실제 승인된 구현 또는 진단 범위에서 수행한다.

| 계층 | 증명하는 것 | 증명하지 못하는 것 |
|---|---|---|
| unit/property | 순수 normalization, 상태 전이, budget 계산, ranking/dedupe, fence predicate, redaction | 실제 transaction, constraint, Redis lease나 network contract |
| component/MSW | 화면 상태, success/data·error/errors mapping, focus·ARIA·복구 동작 | API/DB/queue의 실제 정확성 |
| API contract | guard, ValidationPipe, access/refresh JWT·CSRF, OpenAPI response | worker crash와 storage race |
| PostgreSQL integration | save all-or-none, unique/idempotency, revision 보존, owner/current/deleted filter, pgvector query와 concurrent CAS | Redis delivery |
| Redis/BullMQ integration | enqueue 장애, duplicate delivery, restart, lease expiry, late worker fence, repair와 DLQ/terminal receipt | semantic 검색 품질 |
| browser E2E | owner 관점의 로그인·저장·검색·읽기·삭제·동의·답변 및 degraded recovery | 내부 race를 단독으로 완전 증명 |

fake provider는 timeout, 429, malformed output, citation escape, unknown outcome과 crash 위치를 제어하는 데만 쓴다. fake embedding/generation 결과는 semantic 품질 증거가 아니다. transaction·constraint·pgvector·BullMQ·lease·fence·repair에 행동이 의존하는 acceptance는 실제 PostgreSQL 또는 Redis integration evidence가 없으면 실패다.

### 테스트 작성과 AI 검토

- 테스트는 우리 입력·설정·반환값·DB effect·오류를 계약에 대조한다. 라이브러리 내부 알고리즘·기본 동작을 전수 재검증하거나 모든 클래스의 mock 테스트·내부 호출 순서를 복제하지 않는다. mock은 외부 호출의 실패 경계에 사용하고 DB 원자성·SQL·제약·동시성은 실제 DB로 확인한다.
- 기대 결과와 허용되지 않는 effect는 spec/ADR에서 먼저 도출한다. 구현과 테스트를 같은 AI가 작성했거나 별도 AI 리뷰가 통과했다는 사실만으로 정확성을 보장하지 않는다. 담당자는 주요 불변식·경계값·실패 결과를 원문 계약과 대조한다.
- 버그 수정은 가능한 가장 좁은 재현 테스트의 수정 전 실패·수정 후 통과를 우선 확인한다. 일반 기능·설정·문구 수정에 의도적 RED나 새 테스트 기반을 의무화하지 않는다. owner/revision/fence 같은 핵심 조건은 누락 시 검사가 실패하는지 선택적으로 확인하되 상시 mutation testing 도구는 요구하지 않는다.
- 비동기 경쟁은 서로 다른 실제 연결·작업과 barrier로 검증하며 고정 sleep이나 반복 실행 운에 기대지 않는다. 테스트 격리를 위한 바깥 transaction 하나가 worker의 별도 연결·commit·rollback 검증을 가리지 않게 한다.
- 컨테이너는 격리를 보장할 수 있는 suite/run 단위로 재사용할 수 있다. 매 assertion마다 컨테이너를 만들지 않으며, 데이터·작업·시계는 테스트 간 격리하고 생성한 자원만 정리한다. 열린 app·pool·consumer는 종료 실패도 드러나게 정리한다.
- 업무 규칙의 검증은 backend 소유 위치에서 수행하고 API·worker에서는 각 transport·등록·lifecycle을 확인한다. 같은 규칙을 계층마다 똑같이 반복하지 않는다. 테스트 위치는 기존 runner가 발견하는 구조를 따르며 파일 이동이나 공용 test-support 패키지를 먼저 만들지 않는다.
- 프론트 component 테스트는 RTL/MSW로 사용자에게 보이는 상태·상호작용을 검사하고, 실제 API와 연결한 핵심 여정은 Playwright로 확인한다. MSW 통과를 backend 정확성으로 해석하지 않는다.
- 목표는 회귀를 잡는 신뢰할 수 있는 검사다. 테스트 수나 일률적인 100% coverage를 완료 조건으로 삼지 않고, 놓친 버그·실행 시간·flaky failure를 보고 검사를 개선한다.

### 현재 테스트 구성과 선택적 TDD

핵심은 테스트 개수·coverage가 아니라 실제 회귀를 잡는가다. 이 프로젝트는 **실제 PostgreSQL + HTTP 통합 중심, 주요 브라우저 E2E, 필요한 순수 규칙 단위 검사**로 운영한다. 업계 전체의 정해진 비율이나 AI 시대의 유일한 표준이라고 주장하지 않는다.

- `apps/api/src/**/*.spec.ts`: 원문 정규화·분할 등 독립 규칙. Nest source unit을 위해 별도 SWC 변환기를 추가하지 않는다.
- `tests/*.test.ts`: 공통 HTTP/SDK transport·보안 설정/로그 등 런타임 경계. HTTP는 실제 빌드 산출물을 Node 로더로 읽어 Nest metadata·DI token을 일치시킨다.
- `tests/*.integration.test.ts`: 실제 API·격리 DB·migration·멱등성·CAS·rollback. Repository mock으로 SQL·제약을 대신하지 않는다.
- `tests/browser/`: 실제 API/DB를 연결한 핵심 UI 흐름. Google 외부 응답만 fixture로 제어하며 매 실행 실제 Google 로그인은 요구하지 않는다.
- import 경계는 `pnpm lint:architecture`로 검사한다. 타입/린트가 확인하는 사실을 테스트로 반복하지 않으며 SDK 타입이 실제 JSON을 보장한다고도 해석하지 않는다.

버그는 명세에서 재현 조건을 정하고 실패 확인 → 수정 → 통과 → 관련 회귀 확인으로 진행한다. 새 기능은 성공·주요 실패의 수용 기준을 먼저 정하고 AI가 테스트를 먼저 작성해도 된다. 금지하는 것은 **AI가 구현 결과를 그대로 정답으로 삼는 것**이다. 단순 DTO·getter·controller 전달·라이브러리 기본 옵션에 파일별 테스트를 의무화하지 않는다. 복잡한 순수 분기가 있다면 좁은 단위 테스트를 허용하되 mock 호출 횟수를 업무 결과로 오인하지 않는다.

컨테이너/마이그레이션은 suite 단위로 준비하고 데이터는 테스트마다 격리한다. HTTP·worker가 별도 연결을 쓰거나 실제 commit/경쟁을 검증할 때는 외부 transaction rollback만으로 격리하지 않는다. 실행 시간 문제가 확인되면 fixture 초기화·DB/schema 분리·병렬화를 측정 후 선택한다.

#### 이번 정리의 삭제·유지 근거

| 변경 | 이유와 남은 검증 |
|---|---|
| auth-cookies·auth-request 단위 검사 제거 | 옵션 객체/헤더 helper 반복을 제거. 실제 로그인·CSRF·쿠키 HTTP 흐름 유지 |
| design token 수식 검사 제거 | 실제 페이지의 Playwright/axe 검사 유지. 모든 미사용 token 조합까지 검사한다고 주장하지 않음 |
| architecture.test 제거 | 수작업 AST graph·manifest snapshot 대신 dependency-cruiser + 타입/린트/실제 build 사용 |
| run-env.test 제거 | 사용자 요청으로 실행기 전용 suite 제거. env/Next 자식 프로세스 회귀가 자동 E2E로 전부 대체되지는 않음 |
| configuration 축소 | 포트·enum·필수 문자열 등 schema 복사 검사를 줄이고 운영 HTTPS·키 분리·비밀값 오류 정제 유지 |
| logging 축소 | Pino 레벨 필터 기본 동작 반복 제거. 요청한 KST 변환과 민감 정보 비노출 유지 |
| material-content 이동 | 순수 규칙 옆으로 이동; unicode offset·내용 fingerprint 검사 유지 |

실행기 수정 시 비밀값 없는 임시 fixture에서 dev/prod 선택·주입값 우선순위·Next 실제 기동을 확인한다. 이는 변경 시 점검이며 새 영구 실행기 테스트 suite를 만들라는 뜻이 아니다. 실제 `.env.dev/.env.prod`는 사용자 소유이며 검사 중 읽거나 출력하지 않는다.

근거: [Fowler의 테스트 형태 논의](https://martinfowler.com/articles/2021-test-shapes.html), [Anthropic의 테스트 우선 개발 사례](https://www.anthropic.com/engineering/claude-code-best-practices), [Playwright의 사용자 관점 검증](https://playwright.dev/docs/best-practices). 문헌은 판단 근거이며 특정 비율이나 모든 팀의 관행을 증명하지 않는다.

### Scaffold 검사의 수명

- **작성 시점:** 테스트는 해당 기능 구현에 착수할 때 작성한다. 아직 없는 다음 phase 기능을 의도적으로 실패시키는 테스트·전용 script·영구 skip을 선행 phase의 산출물로 요구하지 않는다. 현재 기능의 버그를 재현하고 수정 후 통과시키는 절차는 유지한다.
- **아키텍처:** 승인된 package/feature 소유권, 의존 방향·private 경계·cycle, export map과 상태 기반 task의 cache 정책을 검사한다. 현재 클래스명, API 목록·개수나 임시 폴더 목록을 복제한 snapshot을 장기 회귀 기준으로 삼지 않는다. phase 범위 준수는 계속 확인하되 다음 phase 시작 시 정상적인 feature 도입을 이전 phase의 부재 검사로 막지 않는다. 파일명 금지만으로 YAGNI를 증명하거나 source 문자열 부재만으로 worker 미기동·DB 없는 build 성공을 주장하지 않는다.
- **DB:** migration의 반복 적용에서 이미 적용한 작업이 중복되지 않는지, 연결·잠금 timeout 이후 복구되는지, 앱 종료 시 Pool이 닫히는지를 실제 DB로 확인한다. 현재 migration 기록 수나 Pool 설정 숫자를 그대로 복제하는 assertion은 별도 공개 계약이 아닌 한 피한다. 호환성·재현성을 위한 버전 고정과 유한 timeout 요구는 유지한다.
- **HTTP:** 실제 Nest 설정을 사용하는 성공 envelope·오류 정보 정제·입력 검증·body 없는 응답·probe 계약 검사는 유지한다. 테스트 전용 controller는 공통 HTTP 처리를 검증하는 좁은 fixture이며 제품 endpoint를 늘리는 근거가 아니다.
- **프론트:** 실제 페이지의 접근성·좁은 화면 여정을 우선한다. 별도 semantic token 수식 검사는 중복이면 유지하지 않는다. API ping 표시를 검사를 위한 제품 기능으로 두지 않는다. 대비는 실제 사용하는 foreground/background 조합을 대상으로 하며 token 검사나 비활성 로그인 버튼 확인을 실제 로그인·접근성 전체의 증거로 사용하지 않는다. 실제 기능이 도입되면 scaffold 동작을 고정하지 않고 해당 사용자 여정으로 검사를 바꾼다.
- **정리 원칙:** 제품 계약과 허용 범위는 유지하고, 검사 대상이 없어진 임시 확인이나 같은 계약의 중복 검사만 근거와 변경 범위를 확인해 정리한다. 실제 기능의 실패를 숨기려고 회귀 테스트를 삭제·완화하지 않는다. 과거 실행 evidence는 현재 결과처럼 고치지 않고 현재 gate와 구분한다. 단순 정리를 위해 새 test framework나 공용 package를 도입하지 않는다.

### CI와 실행 증거

CI는 구현된 기능과 함께 점진적으로 연결한다. 아래는 CI·phase gate의 정책이며 일상 수정마다 전체 suite를 로컬에서 반복하라는 뜻이 아니다. 로컬에서는 영향받는 검사를 먼저 실행하고 변경된 경계에 따라 넓힌다.

현재 workflow는 PR·기본 branch push·수동 실행을 검사한다. feature branch의 push job은 건너뛰므로 PR을 만들기 전에는 자동 검사가 없다. 같은 PR/ref의 이전 실행은 취소하며 action은 full commit SHA, runner는 `ubuntu-24.04`, 저장소 권한은 `contents: read`로 제한한다. 의존성 설치 뒤 typecheck를 전체 build보다 먼저 실행하고 브라우저 검사 뒤 추적 중인 Next 설정/타입 파일의 drift를 검사한다. Next 생성물 관리와 Turbo 입력은 ADR-0001을 따른다.

1. **빠른 검사:** 타입·lint·현재 unit/component 검사를 먼저 실행한다. runner에 발견되지 않는 테스트와 검사 대상 0건을 통과 증거로 삼지 않는다.
2. **정합성 검사:** 해당 phase의 실제 PostgreSQL 및 필요한 Redis 통합 검사를 전용 환경에서 실행한다. Docker·DB 설정 누락으로 필수 검사를 조용히 skip하거나 개발 DB로 fallback하지 않고 필수 gate를 실패로 처리한다.
3. **계약·사용자 여정:** 실제 HTTP·OpenAPI/client 일치와 구현된 핵심 browser journey를 검증한다. 공통 backend·DB·API 계약 변경이 해당 통합 검사를 빠뜨리지 않도록 CI trigger 범위를 확인한다.
4. **별도 평가:** 외부 provider가 필요한 검색·답변 품질 및 비용 평가는 승인된 구성·예산 아래 별도 실행한다. 일반 코드 검사마다 실제 Google 로그인이나 유료 AI 호출을 요구하지 않는다.

빠른 검사 통과를 전체 통과로 보고하지 않는다. 명령·환경·범위·결과·미실행 사유는 짧은 완료 보고나 기존 CI 결과로 충분하며 별도 evidence 문서를 매번 만들지 않는다. 환경이 없어 실행하지 못한 필수 검사는 미실행으로 남긴다. 실행 기록이나 CI 요구를 다음 phase 기능·새 검증 시스템을 미리 만드는 근거로 사용하지 않는다.

### 로컬 실행과 이미지 검증

Phase 1의 `pnpm test:images`는 `tests/images/compose.yml`을 기본 Compose와 병합해 실제 app profile의 API·standalone web·명시 migration 이미지를 검증한다. Docker Compose 2.24.4 이상과 OpenSSL을 사용하며 사용자 env_file은 제거하고 project·볼륨·loopback 포트를 격리한다. 로컬 자체 서명 HTTPS에서 Secure cookie·CSRF·exact Origin, access 부재 후 refresh, 저장·검색·재시작 보존, PostgreSQL 중단 시 live 200/ready 503 및 복구를 확인한다. Google 외부 응답은 테스트 mount에서만 바꾸고 제품 이미지에 fixture를 넣지 않는다. 자체 서명 인증서 신뢰 생략은 테스트 context에 한정하며 실제 공개 도메인·인증서 배포 확인을 대체하지 않는다. CI는 같은 명령을 실행하고 해당 실행의 임시 자원만 정리한다.

제품 구현 승인 후 현재 phase에 실제 존재하는 앱만 검증한다. Phase 0·1의 개발 의존성은 PostgreSQL+pgvector이며 Redis와 worker는 Phase 2부터 추가한다. 호스트의 pnpm/Turborepo 개발 실행과 선택 `app` profile은 같은 업무·인증 계약을 사용한다. 앱 이미지는 web/API가 동작하는 Phase 1부터, worker 이미지는 Phase 2부터 검증하며 빈 앱이나 미래 단계용 이미지를 먼저 만들지 않는다.

- **이미지 빌드와 기동:** 모노레포 루트를 build context로 사용한 multi-stage build가 필요한 workspace 산출물을 포함하는지 확인한다. runtime image는 non-root로 실행하고 secret·개발용 `.env`·인증 정보를 layer나 build log에 포함하지 않는다. CI는 해당 phase의 image build와 최소 runtime smoke를 수행하도록 구성하되 registry push·cloud resource·deployment 권한은 갖지 않는다.
- **데이터와 schema:** PostgreSQL의 named volume은 일반 중지·재시작 후에도 유지되어야 한다. 검토된 SQL migration은 앱 시작 전에 명시적으로 적용하며 container entrypoint/API/worker startup에서 자동 실행하지 않는다. 자동화된 image smoke도 개발 volume을 재사용하지 않고 해당 실행이 소유한 격리된 테스트 의존성을 사용한다.
- **HTTP와 인증:** 호스트와 Docker 앱 실행의 same-origin `/api/v1`·HTTPS cookie·CSRF·OpenAPI 계약을 확인한다. Google token/profile 외부 요청만 fixture로 제어해 실제 Passport Strategy/Guard의 설정·대표 실패와 DB 효과를 검증한다. 별도 인증 provider 서버·규격 전수 검증 플랫폼이나 실제 Google/AI 호출·production credential은 smoke의 필수 조건이 아니다.
- **의존성 장애:** PostgreSQL이 준비되지 않으면 core readiness가 실패해야 한다. 반면 Redis/AI가 처음부터 unavailable하거나 실행 중 끊겨도 API 기동과 저장·현재 keyword 검색·읽기는 유지하고 관련 기능만 degraded로 표시한다. API 이미지에 worker processor·scheduler가 등록되지 않고 worker에서만 실행되는지도 확인한다.
- **종료와 복구:** SIGTERM 수신 시 새 요청·작업 수락을 중단하고 진행 중 처리를 정해진 종료 유예 시간 안에서 마무리하는지 확인한다. worker의 정상 drain과 유예 시간 초과·강제 종료를 구분하고, 후자의 작업이 lease 만료·repair·publication fence로 복구되어 중복·과거 결과를 게시하지 않는지 실제 DB·큐 테스트로 검증한다.
- **DB 연결 수명주기:** ADR-0003의 연결 획득/잠금 timeout과 SQL 실패 뒤 연결을 다시 사용할 수 있고, Nest app close에서 pool이 닫히는지 확인한다. pool의 idle-client error와 DB-down은 정제된 오류·health로 관찰하고 연결 누수나 원본 exception 출력으로 처리하지 않는다.

build 성공, runtime smoke, 통합 테스트의 결과는 따로 보고한다. smoke는 이미지가 현재 기능을 실행할 수 있다는 최소 증거일 뿐 전체 acceptance, 운영 안정성 또는 AWS 배포 준비 완료를 뜻하지 않는다. 이 검증 계획만으로 Dockerfile·Compose·CI 설정 변경이나 이미지 실행이 승인되지는 않으며 현재 승인 phase와 작업 범위를 따른다.

### 필수 race와 failure matrix

- Google 로그인은 state의 난수·브라우저 binding·TTL·원자 소모·재사용 거부, Google profile 검증 전 쓰기 0건, 첫 로그인 계정 생성·재로그인 재사용·다른 Google 계정 분리를 검증한다. 서비스 JWT의 서명·용도·만료, 계정별 refresh CAS 단일 성공·재사용 거부·logout 경쟁과 다른 계정에 영향 없음을 확인한다. CSRF는 실제 라이브러리에 연결한 bootstrap·변조/다른 binding 거절·로그인 갱신/refresh 유지/logout 삭제를 HTTP로 검증한다. 고정 만료와 access 잔여 유효성 등 상세 계약은 [ADR-0005](0005-google-login-and-sessions.md)를 따른다.
- material create/update는 revision, chunk, keyword row, idempotency record와 durable embedding intent가 한 PostgreSQL transaction에서 모두 생기거나 모두 생기지 않음을 증명한다. 이전 revision은 실패한 update에도 보존한다.
- Redis down, enqueue 실패와 worker down 중에도 PostgreSQL save commit은 성공하며 current keyword 검색과 자료 읽기는 계속된다. repair가 committed intent를 빠짐없이 재전달한다.
- duplicate job, worker crash 전후, lease 만료, 재시작과 늦은 old worker가 terminal receipt 또는 vector를 중복·stale publication하지 않음을 증명한다.
- owner, current revision, deleted predicate가 keyword/vector/hybrid의 모든 branch에 적용되고 delete/edit와 concurrent search에서 과거 chunk가 새 결과로 게시되지 않음을 증명한다.
- answer의 pre-call snapshot+reservation은 all-or-none이며 provider 동안 열린 DB transaction이 없다. consent epoch 변경, budget 경쟁, edit/delete, expiry, duplicate result, publish 직전 crash를 deterministic latch/barrier로 재현해 fenced publication과 exactly-once settlement를 검증한다.
- 미동의, budget exhausted와 pricing 부재는 provider spy call count가 정확히 0이어야 한다.
- retry, race와 expiry test는 임의 `sleep` 순서에 기대지 않고 virtual clock, DB server time, barrier와 명시적 lifecycle hook을 사용한다.

Phase 1 인증 경쟁은 첫 계정 생성·state 소모·refresh CAS·refresh/logout의 대상 테이블을 잠그고 `pg_stat_activity`에서 요청들이 실제 lock 대기 중임을 확인한 뒤 해제한다. `Promise.all()` 호출 자체를 경쟁의 증거로 삼지 않는다. 자료 update/delete 경쟁은 최종 current revision·본문/삭제 상태, 승자의 receipt와 revision/chunk/keyword/intent 수, read/search 노출까지 검사해 패자의 부분 저장을 배제한다.

barrier 관찰이 실패해도 blocker를 해제하고 시작한 요청들을 `allSettled`로 정리한 뒤 원래 실패를 전달한다. auth 만료 정리는 OAuth state와 refresh 각각에서 100건 상한·잠긴 만료 행 보존·유효 행 보존을 확인한다. DB lifecycle teardown은 unpause·app close·container stop·환경 복원을 단계별 finally로 분리해 앞 단계 실패가 뒤 정리를 생략하지 않게 한다.

DB lifecycle 검사는 기동 장애·빈 DB/migration·준비된 runtime을 구분하고 각 case가 독립 컨테이너·필요한 migration·종료 정리를 소유한다. 앞선 case가 DB를 복구하거나 migration을 적용했다는 가정 없이 `-t`로 단독 실행할 수 있어야 한다. 컨테이너 초기화 시간이 늘어나는 대신 실행 순서 의존성을 없앤다.

인증 복구 회귀는 이미 열린 보호 화면에서 refresh 401과 재전송 401이 중앙 종료로 이어지는지, 늦은 응답·후속 요청이 차단되는지, 재로그인 뒤 허용된 query/revision/앵커로 복귀하는지 확인한다. refresh 503·network 실패는 입력을 보존하고 명시적 재시도로 복구한다. OAuth 검사는 잘못된 binding이 정상 state를 소모하지 않는지와 callback query가 저장된 복귀 경로를 덮지 못하는지도 포함한다. 만료 정리는 유효 행·잠긴 행을 보존하고 한 호출에서 100건을 넘기지 않는지 실제 DB로 확인한다.

### 검색·답변 품질 평가

평가 dataset은 개발용 20 cases와 release 전에 동결한 final 40 cases로 분리한다. final set은 답할 수 있는 grounded 32 cases와 근거가 부족한 8 ungrounded cases를 포함하고 개발 중 prompt/ranking 조정에 사용하지 않는다. 각 case는 owner, current/deleted state, keyword/한영 혼합 query, 필요한 evidence ID와 허용 answer claim 또는 `insufficient-evidence` 판정을 versioned fixture로 가진다. 실제 사용자 원문을 corpus에 복사하지 않는다.

모든 비교는 corpus version, index snapshot/content hash, embedding·generation configuration ID, dimension, chunking, readiness, filter, 후보 수 `k`, query mode를 함께 기록한다. provider/model/version/dimension은 지금 선택하지 않으며 평가 결과가 승인 전 기본값을 암묵적으로 만들지 않는다.

검색은 Hit@1, Hit@5, multi-evidence recall, owner/current/deleted filter 위반 0건을 보고한다. 답변은 grounded claim ratio, valid citation ratio, false-answer ratio와 ungrounded case의 올바른 refusal ratio를 보고한다. 한 aggregate 점수로 실패를 숨기지 않고 case별 결과와 numerator/denominator를 보존한다. threshold는 첫 구현 전 별도 release criterion으로 승인하며, threshold가 없는 동안 결과는 관찰값이지 합격 주장이나 운영 SLO가 아니다.

semantic 품질 평가는 실제 후보 configuration으로 실행한다. provider nondeterminism이 있으면 반복 횟수, temperature/seed 지원 여부와 분산을 기록한다. provider 출력 schema/citation allowlist의 mechanical validation과 claim의 semantic groundedness를 별도 판정한다.

### 성능 평가

1k와 10k current-chunk corpus를 분리해 keyword/vector/hybrid query와 save/indexing/answer 단계의 p50/p95를 측정한다. hardware/OS, CPU·memory limit, PostgreSQL/pgvector setting, index state, dimension, cache warm/cold, query plan, connection pool, 동시성, corpus seed와 실행 시각을 기록한다. transaction 시간과 provider/network 시간을 분리하고 한 번에 한 변수만 바꾼다. 표본 수와 raw bounded measurement artifact 없이 percentile만 주장하지 않는다.

성능·품질 결과는 topology나 provider 선택이 아니며 [ADR-0010](0010-aws-terraform-decision-gate.md)의 배포 cost worksheet에 workload evidence로만 제공한다.

#### Phase 1 keyword 측정 (2026-09-19)

재현: `pnpm bench:search` (Docker 필요). 테스트 전용 PostgreSQL에만 기존 migration과 fixture를 적용하고 종료 시 해당 컨테이너를 제거한다. 구현된 Repository가 생성한 SQL을 캡처해 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`을 실행하므로 별도 단순화 쿼리를 대신 측정하지 않는다. raw 표본·plan·index·설정은 Git에서 제외하는 `test-results/keyword-search.json`에 저장한다.

- 환경: Apple M2 Max/arm64, 호스트 12 CPU·32 GiB, Docker 28.0.4 VM 12 CPU·약 7.65 GiB. 컨테이너 별도 CPU/memory limit 없음. PostgreSQL 17.11/pgvector 0.8.6 고정 이미지, pool max 5, shared_buffers 128 MiB, work_mem 4 MiB, parallel workers per gather 2.
- 자료 1k/10k/20k 각각 현재·과거 revision 한 개씩(20k 자료일 때 keyword 40k행), 조회 owner 80%, tombstone 5%. 약 300–950자 합성 본문, 희소어는 현재 자료의 0.5%, 흔한 단어는 50%. 실제 chunk·AI corpus가 아니라 Phase 1 keyword projection 부하 fixture다.
- 시나리오마다 1회 예열 후 순차 10표본, `인증`은 동시 4요청×10회도 측정. cold cache·HTTP·snippet·사용자 네트워크는 제외한다. p95는 작은 표본의 관찰값이며 SLO·성능 보장으로 해석하지 않는다.

20k 자료의 warm Repository 지연(ms):

| 검색어/조건 | p50 | p95 | keyword 접근 계획 |
|---|---:|---:|---|
| bullmq | 10.15 | 10.73 | full-text + trigram BitmapOr |
| 재시도 | 9.85 | 10.52 | BitmapOr |
| 인증 | 234.71 | 246.82 | 병렬 Seq Scan |
| 큐 | 236.22 | 248.37 | 병렬 Seq Scan |
| bullmq 백오프 | 10.84 | 11.11 | BitmapOr |
| 공통기록 (50% 일치) | 380.41 | 392.12 | BitmapOr, 많은 후보의 점수 계산 |
| 공통기록 400페이지 | 389.94 | 401.53 | 같은 후보·정렬 + OFFSET |
| 과거전용 (현재 결과 0개) | 236.06 | 254.31 | 병렬 Seq Scan, 현재 revision JOIN에서 제외 |
| 인증, 동시 4요청 | 244.58 | 255.39 | 병렬 Seq Scan |

1k→10k→20k에서 `인증` p50은 25.17→119.14→234.71ms, `bullmq`는 1.87→6.71→10.15ms였다. OR 자체가 index 사용을 막는다는 가설은 기각한다. 반면 선행·후행 wildcard를 붙인 짧은 토큰은 추출 가능한 trigram이 부족하며, 이 fixture에서 순차 스캔 비용이 확인됐다. 흔한 단어와 과거 revision도 별도 비용이므로 “짧은 한글만 고치면 검색이 빠르다”고 결론 내리지 않는다.

이번에는 부분 문자열 정확도·정렬·schema를 변경하지 않았다. 후속 최적화는 동일 fixture와 실제 사용 규모를 기준으로 현재/owner 후보 축소·점수 계산 범위를 먼저 비교한다. 짧은 토큰의 FTS-only 전환은 검색 누락 정책이 바뀌므로 별도 승인 대상이다. `word_similarity_threshold` 변경은 현재 LIKE 조건의 해결책이 아니다. 2-gram projection이나 index 추가도 migration·쓰기 비용과 recall 비교가 선행돼야 한다. 반복 측정 없이 SQL만 바꾸거나 이 결과를 의미 검색 품질로 주장하지 않는다.

#### 검색 저장 vector·snippet 후속 비교 (2026-09-20)

같은 `pnpm bench:search` fixture·이미지·호스트에서 변경 전과 `0009` 적용 후 실제 Repository를 비교했다. 검색 결과·정렬·추가 한 행을 포함한 27조건은 저장 vector SQL과 기존 `to_tsvector` 표현식 SQL의 반환 행을 대조해 동일함을 확인했다. 비교 SQL은 실제 생성 쿼리의 vector 표현만 치환하고 표본 측정 밖에서 실행한다. 성능 baseline은 이전 표현식 index가 있는 변경 전 실행이며, 신규 실행에서는 저장 컬럼 index만 사용한다. 각 조건 10표본(동시성 조건 40표본), warm cache이며 다른 실행 시점의 비교라 정확한 개선율이나 운영 SLO로 일반화하지 않는다.

20k 자료, 단일 요청·첫 페이지의 Repository 지연(ms):

| 검색어 | 이전 p50 / p95 | 저장 vector p50 / p95 |
|---|---:|---:|
| bullmq | 11.81 / 12.92 | 6.83 / 7.77 |
| 인증 | 238.02 / 249.76 | 23.54 / 25.44 |
| 큐 | 238.57 / 258.61 | 23.58 / 24.58 |
| 공통기록 | 376.77 / 383.31 | 290.47 / 306.62 |
| 과거전용 | 233.13 / 260.46 | 22.43 / 34.35 |

흔한 단어의 similarity 계산과 이력 스캔은 남아 있다. 점수 변경 없이 효과가 큰 저장 vector만 채택하고, owner/current 후보 축소·본문 후조회·current-search projection은 이번에 도입하지 않았다. 상위 N건만 재점수하거나 similarity를 제거하는 것은 순위 변경이므로 별도 결정이다. EXPLAIN의 total-startup 차이를 Sort 자체 시간으로 해석하지 않는다. index 접근 여부와 별개로 행별 함수 계산도 비용에 포함된다.

snippet 재현은 `pnpm build:api` 후 `node tests/benchmarks/search-snippet.mjs`다. Node 24.20.0에서 1k/10k UTF-16 길이, 한글/ASCII/전각/소문자 길이 확장, 앞/중간/끝 24조건을 각각 100회 예열 후 50건×20표본으로 측정한다. raw 표본·CPU·실행 시각은 Git에서 제외한 `test-results/search-snippet.json`에 기록한다. DB·HTTP를 제외한 동기 함수 비용이다.

10k 한글·50건의 p50은 앞 36.38→0.82ms, 중간 41.80→7.30ms, 끝 45.00→10.42ms였다. 전각 끝은 45.11→10.75ms, ASCII 끝은 31.40→3.22ms였다. 전체 grapheme 배열 대신 필요한 경계만 조회해 모든 측정 조건에서 p50이 감소했다. 소문자 길이 확장 문자 `İ`를 10k 가까이 반복한 끝 매칭은 145.11→110.85ms로 개선됐지만 여전히 비용이 크며 일반 본문과 구분해 기록한다. 임의 성능 상한 테스트나 fallback으로 정확도를 바꾸지 않는다.

### 관측성

**Phase 0·1:** Nest 기본 기동 로그를 유지하고 애플리케이션 오류는 Pino logger를 직접 사용한다. `apps/api/src/infrastructure/logging/logger.ts`에서 한 번 설정한 인스턴스를 API 내부에서 직접 import하며 각 모듈·DB가 각자 logger나 래퍼를 만들지 않는다. DB idle-client 오류·알려진 실패·기동 실패는 원본 오류를 넘기지 않고 안전한 고정 메시지로 남긴다. 자체 `logEvent`, 허용 필드·`errorClass` registry, AsyncLocalStorage 요청 문맥, 요청 ID·응답 추적 header는 선행 구현하지 않는다. `main.ts`는 앱 생성·공통 설정·종료 hook·listen을 중심으로 유지하며, `configureApp`은 실제 서버·테스트·OpenAPI 생성이 함께 쓰는 작은 설정 함수로 둘 수 있다. 목표는 라이브러리를 제거하는 것이 아니라 기본 API를 활용하면서 직접 만든 주변 계층을 줄이는 것이다.

**Phase 2 이후:** 실제 비동기 작업과 운영 조사 요구가 생기는 범위부터 기존 Pino 로그에 필요한 lifecycle event와 correlation을 추가한다. OpenTelemetry는 필요한 trace·metric에 사용하되 모든 자동 계측이나 범용 로그 프레임워크를 한 번에 도입하지 않는다. material commit, intent, attempt, vector publication과 이후 answer의 비용·게시 경계를 필요한 bounded lifecycle event로 연결하고 Phase 5에서 실제 복구 evidence를 확인한다. 추적 ID를 도입할 때는 서버가 만들고 클라이언트가 보낸 값을 신뢰하지 않는다. 원시 owner/material/revision/request/job ID는 metric label에 넣지 않으며, 조사에 식별자가 필요하면 환경별 telemetry key와 key version으로 만든 비가역 pseudonym을 structured log/trace에만 사용한다. 이 후속 설계는 Phase 0 gate가 아니다.

허용 label/field는 component, operation, purpose, outcome, bounded error class, retry count, queue kind, configuration/pricing version과 비용 bucket처럼 유한한 값이다. 다음은 log, trace, metric, error reporting과 durable debug artifact에서 금지한다.

- 사용자 원문·메모·chunk·검색어, prompt, answer text와 citation excerpt
- raw provider request/response와 nested provider error body
- cookie, 서비스 access/refresh JWT와 저장 해시, Google provider token·profile, API key, secret과 credential
- owner/material/request/provider-request ID의 원시값 및 URL query의 사용자 content

초기에는 원본 error나 요청 객체를 logger에 전달하지 않는 것으로 경계를 작게 유지하고, 응답·출력 fixture로 금지 content 0건을 검사한다. 기동 실패도 DB URL·credential을 포함할 수 있으므로 요청 문맥이 없다는 이유로 원문 exception·stack을 stderr에 출력하지 않는다. 이후 동적 field·trace를 추가할 때 serialization 경계의 허용 필드를 검토하고 nested error, circular/oversized value와 URL fixture를 보강한다. 원문 exception dump를 우회로 보존하지 않는다.

Drizzle query logger와 DB 자동 계측에도 같은 규칙을 적용한다. 실행 SQL·bound parameter·원본 DB 오류의 `detail`/`cause`를 운영 telemetry에 남기지 않으며 SQL을 포함할 수 있는 span 속성도 수집 전에 제외한다. query plan·SQL 형태 확인은 합성 fixture의 격리된 검증 artifact에서 수행한다. 운영에서는 operation 이름·시간·결과·정제된 오류 분류만 관찰하며 DB 오류 redaction fixture로 사용자 본문·토큰 해시가 HTTP와 telemetry에 0건인지 확인한다.

후속 phase에서 해당 기능을 구현한 뒤 관측할 항목은 save commit/failure, keyword·vector·hybrid latency/outcome, indexing intent age·attempt·terminal·repair·fence, answer admission denial reason·provider latency/outcome·settlement/fence, authentication/refresh denial, retention cleanup과 dependency health다. Phase 0에는 미래 기능의 빈 metric을 만들지 않는다. provider outage는 answer/embedding만 degraded로 만들며 core save/current keyword/read 성공률과 분리한다.

### Health와 SLO gate

health는 다음 두 개로 제한한다. 다른 API와 같은 성공·오류 JSON 계약을 사용하며, 이 경계는 호스트와 Docker 앱 실행에 동일하게 적용한다.

| 경로 | 확인하는 것 | 기본 판정 |
|---|---|---|
| `GET /api/v1/health/live` | HTTP 프로세스가 응답할 수 있는지 | 정상 실행 중 200. DB·Redis·외부 AI를 호출하지 않으며 그 장애를 liveness 실패로 취급하지 않음 |
| `GET /api/v1/health/ready` | core path에 필요한 PostgreSQL 연결 | 기존 DB 연결에서 `SELECT 1` 성공 시 200, 연결·쿼리 실패 또는 timeout 시 503 |

readiness는 연결 가능성을 확인하는 최소 검사이지 migration 완료·모든 업무 query·검색 품질의 증거가 아니다. Redis/worker/AI provider 장애는 해당 capability를 degraded로 표시하되 API 기동·liveness와 저장·현재 keyword 검색·읽기 가능성을 실패시키지 않는다. Phase 0에는 이들 미래 의존성용 probe나 빈 indicator를 만들지 않는다.

**구현 경계:** API의 작은 HealthController에서 `live`는 단순 응답을 반환하고 `ready`만 Terminus의 `HealthCheckService`·`HealthIndicatorService` 기본 API로 DB를 확인한다. `modules/health/HealthService`는 기존 private DB 연결로 확인하는 메서드 하나만 제공한다. singleton Pool·유한 timeout·정제된 DB 오류·종료 hook은 이후 업무에도 사용하는 ADR-0003의 기반이므로 유지한다. health를 위해 별도 Pool, Repository, UseCase, 범용 checker interface·registry나 전용 공용 package를 추가하지 않는다.

**응답 처리:** `live`는 바로, `ready`는 Terminus 검사 성공 뒤 `{ status: 'ok' }`를 반환해 모두 일반 `{ success: true, data }`로 응답한다. 알려진 DB 연결·쿼리 실패·Terminus 실패는 전역 예외 필터의 안전한 503 `{ success: false, error, message }`이며 예상하지 못한 오류는 다른 API와 같은 안전한 500을 유지한다. `ProbeExceptionFilter`, `RawResponse`, 여러 probe 전용 DTO와 종료 중 `shutting_down` JSON 계약은 제거한다. Swagger는 상태 코드·설명만 명시하고 실제 본문은 [ADR-0007의 공통 HTTP 계약](0007-openapi-client-and-frontend-state-boundaries.md#http와-openapi)에 대조하는 HTTP 테스트로 확인한다. health 생성 SDK의 unknown 본문은 허용하며 inline 모델을 별도로 추가하지 않는다. app close의 Pool 정리는 유지하되 종료 중 별도 HTTP 본문은 보장하지 않는다.

**임시 기능 정리:** `/api/v1/health/status`와 로그인 화면의 API 연결 ping은 제거한다. 생성 SDK는 실제 health 응답을 사용하는 contract test로 확인할 수 있으며, Phase 1부터 실제 제품 API의 사용자 여정에 연결한다. 테스트 편의를 위해 별도 상태 API나 화면 기능을 남기지 않는다.

Phase 0의 health 검증은 다음 범위로 닫는다. DB 장애 검증은 격리된 실제 PostgreSQL 환경에서 수행하고, 각 경로의 HTTP status·안전한 JSON·OpenAPI 일치를 함께 확인한다.

- DB 정상에서 `live`·`ready` 모두 200.
- 유효한 연결 설정으로 시작하되 DB가 불가하거나 실행 중 중단된 경우 `live`는 200, `ready`는 유한한 대기 뒤 503. DB 복구 후 `ready`가 다시 200이 되는지 확인.
- 성공은 일반 success/data, DB 실패는 일반 safe error 503이며 성공으로 위장하지 않음. 공통 예외 필터의 예상하지 못한 오류는 정제된 500임을 별도로 확인.
- 응답·로그에 DB URL, credential, SQL·parameter나 원본 오류가 노출되지 않음.
- app close 시 기존 Pool이 닫힘. 종료·probe의 검증을 자료 저장 원자성이나 운영 안정성 전체의 증거로 사용하지 않음.

운영 traffic과 workload baseline이 쌓이기 전에는 availability, latency, indexing freshness 또는 answer latency SLO와 error budget을 선언하지 않는다. 대시보드는 관찰 p50/p95, sample count, failure class와 degraded 기간을 표시한다. 첫 SLO 제안은 측정 기간·표본·제외 조건·사용자 영향·alert burn rule을 담은 별도 승인으로 정한다. 테스트 timeout이나 provider SDK default를 제품 SLO로 승격하지 않는다.

## Considered Options

1. **계층별 검증 + 실제 PostgreSQL/Redis integration + 고정 quality corpus** — 선택.
2. ORM/queue mock 중심 테스트 — 빠르지만 핵심 transaction·lease·fence 주장을 증명하지 못해 기각.
3. 운영 로그에 payload를 남겨 디버깅 — privacy 경계와 최소 보존을 깨므로 기각.
4. 작은 합성 corpus의 단일 aggregate accuracy — filter·refusal·citation 실패를 숨겨 기각.
5. baseline 전 임의 SLO 고정 — 근거 없는 운영 약속이므로 기각.

## Consequences

- Testcontainers, race barrier와 frozen corpus를 유지하는 비용이 생기지만 load-bearing 주장을 재현 가능한 evidence로 남긴다.
- content 없이 조사해야 하므로 bounded lifecycle event와 pseudonym correlation 설계가 중요해진다.
- 품질과 latency 수치는 configuration별 관찰값이며 provider/model/topology 선택을 선행하지 않는다.
- optional subsystem 장애와 PostgreSQL core 장애를 운영·UI에서 명확히 구별한다.

## Verification contract

각 제품 acceptance는 적절한 테스트·실행 결과에 연결한다. 별도 matrix·artifact는 여러 실험·복구 결과를 묶어 보존할 때만 만들되 검색·성능 평가의 configuration snapshot은 유지한다. DB/queue 의미론은 실제 integration, semantic 품질은 실제 provider 평가로 증명하며 mock·fake 결과로 대체하지 않는다.

별도 검증은 다음을 포함한다.

- nested telemetry redaction과 bounded label cardinality
- 실제 DB/queue crash·duplicate·restart·late-worker·repair matrix
- answer snapshot/reservation/publish/settlement의 deterministic race matrix와 provider-in-transaction 0건
- frozen 40-case 검색·답변 report 및 development 20-case와의 분리
- 1k/10k reproducible performance report와 query plan
- readiness/liveness 및 PostgreSQL/Redis/provider 장애의 화면별 degraded mapping
- phase별 이미지 build/runtime smoke와 호스트·Docker 실행의 동일 HTTP·인증 계약
- 개발 named volume 보존, 테스트 환경 격리와 startup 자동 migration 부재
- API의 worker 등록 0건, SIGTERM drain 및 중단 작업의 lease/fence 복구
- baseline 전 SLO/attainment 문구가 제품·대시보드·문서에 0건인지 확인

## Revisit triggers

운영 baseline으로 첫 SLO를 제안할 때, corpus나 품질 threshold를 변경할 때, 새 외부 provider/data class를 관측할 때, 또는 승인된 topology가 health dependency 의미를 바꿀 때 재검토한다.

# ADR-0009: 검증, 관측성과 검색 평가

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-15 — Terminus·Pino 기본 사용은 유지하고 전용 probe 계층·임시 status API·커스텀 로그/추적 구현 요구 제거
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

Vitest를 web과 backend의 unit/component runner로 사용하고, React Testing Library·MSW, Supertest, Testcontainers PostgreSQL·Redis, Playwright를 목적에 맞게 사용한다. exact package version은 scaffold 시 호환 가능한 stable 조합으로 고정한다.

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

- 테스트는 입력·관찰 가능한 반환값·DB effect·오류를 계약에 대조한다. 모든 클래스나 Service에 mock 기반 테스트를 일률적으로 만들거나 내부 호출 순서를 그대로 복제하지 않는다. mock은 외부 AI 등 필요한 실패 경계에 사용하고 DB 원자성·SQL·제약·동시성은 실제 DB로 확인한다.
- 기대 결과와 허용되지 않는 effect는 spec/ADR에서 먼저 도출한다. 구현과 테스트를 같은 AI가 작성했거나 별도 AI 리뷰가 통과했다는 사실만으로 정확성을 보장하지 않는다. 담당자는 주요 불변식·경계값·실패 결과를 원문 계약과 대조한다.
- 버그 수정은 가능한 가장 좁은 재현 테스트가 수정 전 실패하고 수정 후 통과하는지 확인한다. owner/revision/fence처럼 중요한 조건은 해당 조건이 잘못되거나 누락되면 검사가 실패하는지 선택적으로 점검한다. 상시 mutation testing 도구 도입이나 전체 코드 변형을 요구하지 않는다.
- 비동기 경쟁은 서로 다른 실제 연결·작업과 barrier로 검증하며 고정 sleep이나 반복 실행 운에 기대지 않는다. 테스트 격리를 위한 바깥 transaction 하나가 worker의 별도 연결·commit·rollback 검증을 가리지 않게 한다.
- 컨테이너는 격리를 보장할 수 있는 suite/run 단위로 재사용할 수 있다. 매 assertion마다 컨테이너를 만들지 않으며, 데이터·작업·시계는 테스트 간 격리하고 생성한 자원만 정리한다. 열린 app·pool·consumer는 종료 실패도 드러나게 정리한다.
- 업무 규칙의 검증은 backend 소유 위치에서 수행하고 API·worker에서는 각 transport·등록·lifecycle을 확인한다. 같은 규칙을 계층마다 똑같이 반복하지 않는다. 테스트 위치는 기존 runner가 발견하는 구조를 따르며 파일 이동이나 공용 test-support 패키지를 먼저 만들지 않는다.
- 프론트 component 테스트는 RTL/MSW로 사용자에게 보이는 상태·상호작용을 검사하고, 실제 API와 연결한 핵심 여정은 Playwright로 확인한다. MSW 통과를 backend 정확성으로 해석하지 않는다.
- 목표는 회귀를 잡는 신뢰할 수 있는 검사다. 테스트 수나 일률적인 100% coverage를 완료 조건으로 삼지 않고, 놓친 버그·실행 시간·flaky failure를 보고 검사를 개선한다.

### Scaffold 검사의 수명

- **작성 시점:** 테스트는 해당 기능 구현에 착수할 때 작성한다. 아직 없는 다음 phase 기능을 의도적으로 실패시키는 테스트·전용 script·영구 skip을 선행 phase의 산출물로 요구하지 않는다. 현재 기능의 버그를 재현하고 수정 후 통과시키는 절차는 유지한다.
- **아키텍처:** 승인된 package/feature 소유권, 의존 방향·private 경계·cycle, export map과 상태 기반 task의 cache 정책을 검사한다. 현재 클래스명, API 목록·개수나 임시 폴더 목록을 복제한 snapshot을 장기 회귀 기준으로 삼지 않는다. phase 범위 준수는 계속 확인하되 다음 phase 시작 시 정상적인 feature 도입을 이전 phase의 부재 검사로 막지 않는다. 파일명 금지만으로 YAGNI를 증명하거나 source 문자열 부재만으로 worker 미기동·DB 없는 build 성공을 주장하지 않는다.
- **DB:** migration의 반복 적용에서 이미 적용한 작업이 중복되지 않는지, 연결·잠금 timeout 이후 복구되는지, 앱 종료 시 Pool이 닫히는지를 실제 DB로 확인한다. 현재 migration 기록 수나 Pool 설정 숫자를 그대로 복제하는 assertion은 별도 공개 계약이 아닌 한 피한다. 호환성·재현성을 위한 버전 고정과 유한 timeout 요구는 유지한다.
- **HTTP:** 실제 Nest 설정을 사용하는 성공 envelope·오류 정보 정제·입력 검증·body 없는 응답·probe 계약 검사는 유지한다. 테스트 전용 controller는 공통 HTTP 처리를 검증하는 좁은 fixture이며 제품 endpoint를 늘리는 근거가 아니다.
- **프론트:** 작은 semantic token 대비 검사와 현재 페이지의 좁은 화면 smoke는 유지할 수 있다. API ping 표시를 검사를 위한 제품 기능으로 두지 않는다. 대비는 실제 사용하는 foreground/background 조합을 대상으로 하며 token 검사나 비활성 로그인 버튼 확인을 실제 로그인·접근성 전체의 증거로 사용하지 않는다. 실제 기능이 도입되면 scaffold 동작을 고정하지 않고 해당 사용자 여정으로 검사를 바꾼다.
- **정리 원칙:** 제품 계약과 허용 범위는 유지하고, 검사 대상이 없어진 임시 확인이나 같은 계약의 중복 검사만 근거와 변경 범위를 확인해 정리한다. 실제 기능의 실패를 숨기려고 회귀 테스트를 삭제·완화하지 않는다. 과거 실행 evidence는 현재 결과처럼 고치지 않고 현재 gate와 구분한다. 단순 정리를 위해 새 test framework나 공용 package를 도입하지 않는다.

### CI와 실행 증거

CI는 구현된 기능과 함께 점진적으로 연결한다. 아래는 실행 정책이며 workflow 파일의 존재나 성공을 주장하지 않는다.

1. **빠른 검사:** 타입·lint·현재 unit/component 검사를 먼저 실행한다. runner에 발견되지 않는 테스트와 검사 대상 0건을 통과 증거로 삼지 않는다.
2. **정합성 검사:** 해당 phase의 실제 PostgreSQL 및 필요한 Redis 통합 검사를 전용 환경에서 실행한다. Docker·DB 설정 누락으로 필수 검사를 조용히 skip하거나 개발 DB로 fallback하지 않고 필수 gate를 실패로 처리한다.
3. **계약·사용자 여정:** 실제 HTTP·OpenAPI/client 일치와 구현된 핵심 browser journey를 검증한다. 공통 backend·DB·API 계약 변경이 해당 통합 검사를 빠뜨리지 않도록 CI trigger 범위를 확인한다.
4. **별도 평가:** 외부 provider가 필요한 검색·답변 품질 및 비용 평가는 승인된 구성·예산 아래 별도 실행한다. 일반 코드 검사마다 실제 Google 로그인이나 유료 AI 호출을 요구하지 않는다.

빠른 검사 통과만으로 전체 테스트 통과를 보고하지 않는다. 각 실행은 명령·환경·검사 범위·결과와 미실행 사유를 남기며 script 등록, 테스트 작성, 로컬 통과, CI 통과를 구분한다. 환경이 없어 실행하지 못한 검사는 미실행이며 해당 필수 gate는 통과하지 않은 상태다. 테스트·CI 실행 정책은 기존 phase gate를 구현하는 수단이지 다음 phase 기능을 미리 만드는 근거가 아니다.

### 로컬 실행과 이미지 검증

제품 구현 승인 후 현재 phase에 실제 존재하는 앱만 검증한다. Phase 0·1의 개발 의존성은 PostgreSQL+pgvector이며 Redis와 worker는 Phase 2부터 추가한다. 호스트의 pnpm/Turborepo 개발 실행과 선택 `app` profile은 같은 업무·인증 계약을 사용한다. 앱 이미지는 web/API가 동작하는 Phase 1부터, worker 이미지는 Phase 2부터 검증하며 빈 앱이나 미래 단계용 이미지를 먼저 만들지 않는다.

- **이미지 빌드와 기동:** 모노레포 루트를 build context로 사용한 multi-stage build가 필요한 workspace 산출물을 포함하는지 확인한다. runtime image는 non-root로 실행하고 secret·개발용 `.env`·인증 정보를 layer나 build log에 포함하지 않는다. CI는 해당 phase의 image build와 최소 runtime smoke를 수행하도록 구성하되 registry push·cloud resource·deployment 권한은 갖지 않는다.
- **데이터와 schema:** PostgreSQL의 named volume은 일반 중지·재시작 후에도 유지되어야 한다. 검토된 SQL migration은 앱 시작 전에 명시적으로 적용하며 container entrypoint/API/worker startup에서 자동 실행하지 않는다. 자동화된 image smoke도 개발 volume을 재사용하지 않고 해당 실행이 소유한 격리된 테스트 의존성을 사용한다.
- **HTTP와 인증:** 호스트 실행과 Docker 앱 실행 모두 브라우저에는 HTTPS same-origin의 `/api/v1` 경로를 제공하고 JWT cookie·CSRF·OpenAPI 계약을 동일하게 검증한다. 구체적인 프록시 제품은 이 검증 계약으로 선택하지 않는다. 인증 자동 검증에는 standards OIDC test server를 사용하고 실제 Google/AI 호출이나 production credential을 smoke의 필수 조건으로 두지 않는다.
- **의존성 장애:** PostgreSQL이 준비되지 않으면 core readiness가 실패해야 한다. 반면 Redis/AI가 처음부터 unavailable하거나 실행 중 끊겨도 API 기동과 저장·현재 keyword 검색·읽기는 유지하고 관련 기능만 degraded로 표시한다. API 이미지에 worker processor·scheduler가 등록되지 않고 worker에서만 실행되는지도 확인한다.
- **종료와 복구:** SIGTERM 수신 시 새 요청·작업 수락을 중단하고 진행 중 처리를 정해진 종료 유예 시간 안에서 마무리하는지 확인한다. worker의 정상 drain과 유예 시간 초과·강제 종료를 구분하고, 후자의 작업이 lease 만료·repair·publication fence로 복구되어 중복·과거 결과를 게시하지 않는지 실제 DB·큐 테스트로 검증한다.
- **DB 연결 수명주기:** ADR-0003의 연결 획득/잠금 timeout과 SQL 실패 뒤 연결을 다시 사용할 수 있고, Nest app close에서 pool이 닫히는지 확인한다. pool의 idle-client error와 DB-down은 정제된 오류·health로 관찰하고 연결 누수나 원본 exception 출력으로 처리하지 않는다.

build 성공, runtime smoke, 통합 테스트의 결과는 따로 보고한다. smoke는 이미지가 현재 기능을 실행할 수 있다는 최소 증거일 뿐 전체 acceptance, 운영 안정성 또는 AWS 배포 준비 완료를 뜻하지 않는다. 이 검증 계획만으로 Dockerfile·Compose·CI 설정 변경이나 이미지 실행이 승인되지는 않으며 현재 승인 phase와 작업 범위를 따른다.

### 필수 race와 failure matrix

- 인증은 access 만료 뒤 유효한 refresh를 통한 복구, JWT 서명·만료·용도/키 혼용 거부, 기존 refresh 재사용 거부, 실제 PostgreSQL의 동시 refresh CAS 단일 성공, 새 로그인의 교체와 logout 경쟁을 검증한다. 7일의 고정 refresh 만료가 회전으로 연장되지 않고 logout 뒤 이미 발급한 access는 만료까지 유효할 수 있다는 [ADR-0005](0005-google-oidc-single-owner-and-sessions.md)의 제한도 그대로 확인한다.
- material create/update는 revision, chunk, keyword row, idempotency record와 durable embedding intent가 한 PostgreSQL transaction에서 모두 생기거나 모두 생기지 않음을 증명한다. 이전 revision은 실패한 update에도 보존한다.
- Redis down, enqueue 실패와 worker down 중에도 PostgreSQL save commit은 성공하며 current keyword 검색과 자료 읽기는 계속된다. repair가 committed intent를 빠짐없이 재전달한다.
- duplicate job, worker crash 전후, lease 만료, 재시작과 늦은 old worker가 terminal receipt 또는 vector를 중복·stale publication하지 않음을 증명한다.
- owner, current revision, deleted predicate가 keyword/vector/hybrid의 모든 branch에 적용되고 delete/edit와 concurrent search에서 과거 chunk가 새 결과로 게시되지 않음을 증명한다.
- answer의 pre-call snapshot+reservation은 all-or-none이며 provider 동안 열린 DB transaction이 없다. consent epoch 변경, budget 경쟁, edit/delete, expiry, duplicate result, publish 직전 crash를 deterministic latch/barrier로 재현해 fenced publication과 exactly-once settlement를 검증한다.
- 미동의, budget exhausted와 pricing 부재는 provider spy call count가 정확히 0이어야 한다.
- retry, race와 expiry test는 임의 `sleep` 순서에 기대지 않고 virtual clock, DB server time, barrier와 명시적 lifecycle hook을 사용한다.

### 검색·답변 품질 평가

평가 dataset은 개발용 20 cases와 release 전에 동결한 final 40 cases로 분리한다. final set은 답할 수 있는 grounded 32 cases와 근거가 부족한 8 ungrounded cases를 포함하고 개발 중 prompt/ranking 조정에 사용하지 않는다. 각 case는 owner, current/deleted state, keyword/한영 혼합 query, 필요한 evidence ID와 허용 answer claim 또는 `insufficient-evidence` 판정을 versioned fixture로 가진다. 실제 사용자 원문을 corpus에 복사하지 않는다.

모든 비교는 corpus version, index snapshot/content hash, embedding·generation configuration ID, dimension, chunking, readiness, filter, 후보 수 `k`, query mode를 함께 기록한다. provider/model/version/dimension은 지금 선택하지 않으며 평가 결과가 승인 전 기본값을 암묵적으로 만들지 않는다.

검색은 Hit@1, Hit@5, multi-evidence recall, owner/current/deleted filter 위반 0건을 보고한다. 답변은 grounded claim ratio, valid citation ratio, false-answer ratio와 ungrounded case의 올바른 refusal ratio를 보고한다. 한 aggregate 점수로 실패를 숨기지 않고 case별 결과와 numerator/denominator를 보존한다. threshold는 첫 구현 전 별도 release criterion으로 승인하며, threshold가 없는 동안 결과는 관찰값이지 합격 주장이나 운영 SLO가 아니다.

semantic 품질 평가는 실제 후보 configuration으로 실행한다. provider nondeterminism이 있으면 반복 횟수, temperature/seed 지원 여부와 분산을 기록한다. provider 출력 schema/citation allowlist의 mechanical validation과 claim의 semantic groundedness를 별도 판정한다.

### 성능 평가

1k와 10k current-chunk corpus를 분리해 keyword/vector/hybrid query와 save/indexing/answer 단계의 p50/p95를 측정한다. hardware/OS, CPU·memory limit, PostgreSQL/pgvector setting, index state, dimension, cache warm/cold, query plan, connection pool, 동시성, corpus seed와 실행 시각을 기록한다. transaction 시간과 provider/network 시간을 분리하고 한 번에 한 변수만 바꾼다. 표본 수와 raw bounded measurement artifact 없이 percentile만 주장하지 않는다.

성능·품질 결과는 topology나 provider 선택이 아니며 [ADR-0010](0010-aws-terraform-decision-gate.md)의 배포 cost worksheet에 workload evidence로만 제공한다.

### 관측성

**Phase 0·1:** Nest 기본 기동 로그를 유지하고 애플리케이션 오류는 Pino logger를 직접 사용한다. `packages/backend/src/infrastructure/observability/logging.ts`에서 한 번 설정한 인스턴스를 root export로 공유하며 API·DB가 각자 logger나 래퍼를 만들지 않는다. DB idle-client 오류·알려진 실패·기동 실패는 원본 오류를 넘기지 않고 안전한 고정 메시지로 남긴다. 자체 `logEvent`, 허용 필드·`errorClass` registry, AsyncLocalStorage 요청 문맥, 요청 ID·응답 추적 header는 선행 구현하지 않는다. `main.ts`는 앱 생성·공통 설정·종료 hook·listen을 중심으로 유지하며, `configureApp`은 실제 서버·테스트·OpenAPI 생성이 함께 쓰는 작은 설정 함수로 둘 수 있다. 목표는 라이브러리를 제거하는 것이 아니라 기본 API를 활용하면서 직접 만든 주변 계층을 줄이는 것이다.

**Phase 2 이후:** 실제 비동기 작업과 운영 조사 요구가 생기는 범위부터 기존 Pino 로그에 필요한 lifecycle event와 correlation을 추가한다. OpenTelemetry는 필요한 trace·metric에 사용하되 모든 자동 계측이나 범용 로그 프레임워크를 한 번에 도입하지 않는다. material commit, intent, attempt, vector publication과 이후 answer의 비용·게시 경계를 필요한 bounded lifecycle event로 연결하고 Phase 5에서 실제 복구 evidence를 확인한다. 추적 ID를 도입할 때는 서버가 만들고 클라이언트가 보낸 값을 신뢰하지 않는다. 원시 owner/material/revision/request/job ID는 metric label에 넣지 않으며, 조사에 식별자가 필요하면 환경별 telemetry key와 key version으로 만든 비가역 pseudonym을 structured log/trace에만 사용한다. 이 후속 설계는 Phase 0 gate가 아니다.

허용 label/field는 component, operation, purpose, outcome, bounded error class, retry count, queue kind, configuration/pricing version과 비용 bucket처럼 유한한 값이다. 다음은 log, trace, metric, error reporting과 durable debug artifact에서 금지한다.

- 사용자 원문·메모·chunk·검색어, prompt, answer text와 citation excerpt
- raw provider request/response와 nested provider error body
- cookie, 서비스 access/refresh JWT와 저장 해시, OIDC token·claim, API key, secret과 credential
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

**구현 경계:** API의 작은 HealthController에서 `live`는 단순 응답을 반환하고 `ready`만 Terminus의 `HealthCheckService`·`HealthIndicatorService` 기본 API로 DB를 확인한다. backend는 기존 private DB 연결로 확인하는 공개 메서드 하나만 제공한다. singleton Pool·유한 timeout·정제된 DB 오류·종료 hook은 이후 업무에도 사용하는 ADR-0003의 기반이므로 유지한다. health를 위해 별도 Pool, Repository, UseCase, 범용 checker interface·registry나 전용 공용 package를 추가하지 않는다.

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

구현 단계의 acceptance matrix는 각 제품 acceptance를 unit, component, API, real PostgreSQL, real Redis/BullMQ 또는 E2E 중 적절한 evidence에 연결하고 artifact와 configuration snapshot을 기록한다. DB/queue 의미론을 mock evidence에만 연결하거나 fake provider 결과를 품질 evidence로 연결하면 matrix는 실패한다.

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

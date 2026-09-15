# devfootnote (바이브코딩 프로젝트)

> **🚧 개발 진행 중 · Phase 0 — 기반 구성**
>
> 모노레포, DB 연결, API 계약과 로그인 진입 화면을 구성했습니다. 실제 로그인·자료 저장·검색·AI 기능은 구현 예정이며, 아직 배포하지 않았습니다.

**개발 메모와 근거 자료를 기억나는 단서로 다시 찾는 개인 자료함입니다.**

Next.js와 NestJS로 개발하는 개인 포트폴리오 입니다. 직접 남긴 기술 메모와 저장한 원문을 구분해 확인하고, 필요한 경우에만 저장 자료를 근거로 AI 답변을 받는 흐름을 목표로 합니다.

## 해결하려는 문제

개발 중 참고한 공식 문서, 에러 해결 과정, 기술 선택의 이유는 여러 메모와 북마크에 흩어지기 쉽습니다. 시간이 지나면 문서 제목보다 “중복 실행을 막으려고 DB 제약을 확인했던 내용”처럼 일부 맥락만 기억납니다.

devfootnote는 자료를 많이 수집하는 것보다 **저장 당시의 맥락과 실제 근거를 다시 연결하는 일**에 집중합니다.

- 기술 메모와 근거 본문을 저장하고, 제목·출처·개인 메모는 필요에 따라 덧붙입니다.
- 한국어 설명과 영어 기술 식별자가 섞인 단서로 자료와 관련 본문 구간을 찾습니다.
- 내가 작성한 메모, 저장된 원문, AI가 생성한 답변을 분리해 보여 줍니다.
- AI를 사용하지 않거나 외부 서비스에 장애가 있어도 저장·키워드 검색·원문 읽기는 유지하도록 설계합니다.

MVP는 소유자 한 명을 위한 서비스로 제한합니다. 로그인 이후 화면은 **자료함 → 검색·질문 → 자료 읽기** 세 개이며, 팀 협업·공개 가입·범용 웹 크롤러는 범위에 포함하지 않습니다.

## 개발 현황

| 단계      | 범위                                                                                  | 상태                               |
| --------- | ------------------------------------------------------------------------------------- | ---------------------------------- |
| Phase 0   | 모노레포, PostgreSQL·Drizzle 연결, 공통 HTTP 응답, OpenAPI·생성 SDK, 로그인 진입 화면 | 기반 코드 구현·로컬 검증 기록 있음 |
| Phase 1   | Google 로그인·JWT, 자료 등록·수정·삭제, 키워드 검색·원문 읽기                         | 예정                               |
| Phase 2   | 비동기 임베딩, 벡터·혼합 검색, 재시도·중복 작업 처리                                  | 예정                               |
| Phase 3   | 저장 근거 기반 RAG 답변, 인용 검증, 동의·비용 통제                                    | 예정                               |
| Phase 4–5 | 화면별 오류·복구·접근성, 검색 평가, 장애·복구 검증                                    | 예정                               |
| Phase 6   | 비용·복구 조건을 확인한 뒤 배포 방식 결정                                             | 예정                               |

현재 실행하면 `/login` 진입 화면을 확인할 수 있습니다. Google 로그인 버튼은 비활성화되어 있으며, 제품 데이터를 저장하는 테이블은 아직 없습니다. API 상태는 아래 health endpoint로 별도 확인합니다.

기존 실행 결과는 [2026-09-15 Phase 0 검증 기록](docs/evidence/phase0/README.md)에 정리되어 있습니다. 이는 단순화 이전의 probe 응답·로그·임시 API 연결 화면에 대한 로컬 실행 기록입니다. 현재 계약의 통과 여부는 새 검사 결과로 판단하며, 과거 기록은 원격 CI·운영 환경이나 아직 구현하지 않은 기능의 검증을 뜻하지 않습니다.

## 기술 스택

현재 기반 코드에 사용한 기술입니다. 정확한 버전은 각 `package.json`과 [`pnpm-lock.yaml`](pnpm-lock.yaml)에서 관리합니다.

| 영역          | 기술                                             |
| ------------- | ------------------------------------------------ |
| 언어·모노레포 | TypeScript, pnpm workspace, Turborepo            |
| 프론트엔드    | Next.js App Router, React, Tailwind CSS          |
| 백엔드        | NestJS, class-validator, Pino, Terminus          |
| 데이터베이스  | PostgreSQL, pgvector 확장, `pg`, Drizzle ORM·Kit |
| API 계약      | NestJS Swagger, OpenAPI, `@hey-api/openapi-ts`   |
| 테스트        | Vitest, Supertest, Testcontainers, Playwright    |
| 로컬 환경     | Docker Compose                                   |

Redis·BullMQ와 AI 기능은 후속 단계에 도입합니다. 기동은 Nest 기본 로그, 애플리케이션 오류는 한 번 설정한 Pino logger를 사용하며 DB readiness는 Terminus 기본 API로 확인합니다. 별도 로그 프레임워크는 두지 않고 요청 추적·OpenTelemetry는 실제 비동기 처리와 운영 관측이 필요할 때 도입합니다. 현재 pgvector는 확장 설치까지만 구성되어 있으며 벡터 검색은 미구현입니다. 임베딩·생성 모델은 품질·비용·데이터 전송 조건을 확인한 뒤 선택할 예정입니다.

## 프로젝트 구조

```text
devfootnote/
├── apps/
│   ├── web/                 # Next.js 화면·API 연동
│   └── api/                 # NestJS HTTP 서버·컨트롤러·공통 응답
├── packages/
│   ├── backend/             # 백엔드 모듈·DB 연결·migration
│   └── api-client/          # OpenAPI에서 생성한 SDK·타입
├── tests/                   # HTTP·패키지 경계·DB 통합·브라우저 검증
├── scripts/                 # 생성물 drift 확인
├── .github/workflows/       # 저장소 검사(CI)
├── docs/                    # 명세·계획·ADR·검증 기록
├── docker-compose.yml       # 로컬 PostgreSQL
└── turbo.json               # workspace 작업 순서·캐시 설정
```

백엔드는 **기능별 모듈러 모놀리스**를 기본으로 설계했습니다. `apps/api`는 HTTP 처리와 모듈 조립을, `packages/backend`는 업무 규칙과 트랜잭션을 맡습니다. 현재 backend에는 DB 연결·상태 확인 코드가 있으며, 기능별 Module·Service·Repository는 해당 기능을 구현할 때 추가합니다.

프론트는 backend 코드나 DB schema를 직접 공유하지 않고 생성된 API client를 사용합니다. Phase 2에는 큐 작업을 실행하는 `apps/worker`를 추가하고, API와 worker가 backend의 공개 모듈을 사용하도록 구성할 예정입니다.

상세 경계는 [모노레포 ADR](docs/adr/0001-monorepo-and-package-boundaries.md)과 [모듈 소유권 ADR](docs/adr/0002-modular-monolith-domain-ownership.md)에 기록했습니다.

## 로컬 실행

### 준비 사항

- Node.js `24.20.0`
- pnpm `12.4.1`
- 실행 중인 Docker Engine과 Docker Compose plugin

현재 단계의 실행에는 Google OAuth 설정이나 AI API key가 필요하지 않습니다. PostgreSQL은 Docker에서, web·API는 호스트에서 실행합니다.

### 실행 순서

저장소 루트에서 의존성을 설치합니다.

```sh
pnpm install --frozen-lockfile
```

루트 [`.env.example`](.env.example)을 참고해 `.env`를 작성합니다. 이미 `.env`가 있다면 덮어쓰지 말고 필요한 설정만 확인합니다. 예시 DB 계정은 로컬 개발용이며 운영 환경에 사용하지 않습니다.

PostgreSQL을 시작한 뒤, 적용할 SQL과 대상 DB를 확인하고 migration을 실행합니다.

```sh
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev
```

- 웹: <http://127.0.0.1:3000/login>
- API: <http://127.0.0.1:8000>
- PostgreSQL: `127.0.0.1:55432`

`pnpm dev`는 루트 `.env`를 읽어 앱에 전달합니다. API 포트는 `PORT`로 설정하고, 현재 로그인 진입 화면은 API 호출 없이 표시합니다. DB migration은 앱 시작이나 build 시 자동 실행되지 않습니다.

Pino 애플리케이션 로그는 `LOG_LEVEL`로 출력 기준을 정하며 기본값은 `info`입니다. 허용값은 `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`이고 잘못된 값은 기동 시 거부합니다. `pnpm dev`도 이 설정을 앱에 전달합니다. `time`은 호스트 시간대와 무관하게 한국 표준시 ISO 형식(`2026-09-15T23:00:00.000+09:00`)으로 기록하며, OS·DB 시간대와 Nest 기본 기동 로그의 형식은 바꾸지 않습니다.

Pino의 `redact`로 `req`, `res`, `err`, `password`, `accessToken`, `refreshToken` 경로를 제거합니다. 이는 보조 방어이며 임의의 중첩 필드나 메시지 문자열을 자동 정제하지 않으므로 원본 요청·예외·비밀값을 logger에 넘기지 않는 규칙은 유지합니다.

Migration 실행기는 연결 5초·잠금 대기 2초·SQL 실행 30초·질의 응답 대기 35초·전체 실행 60초 상한을 둡니다. 실패 시 원본 SQL·parameter·연결 URL 대신 안전한 오류 분류만 출력합니다. 시간 초과나 연결 단절 뒤에는 자동 재시도하지 말고 DB 상태와 적용 기록을 확인하세요. 긴 migration이 필요하면 적용 전에 잠금 영향과 실행 상한을 함께 검토해야 합니다.

pnpm이 설치되지 않았다면 `pnpm ...` 대신 `npm exec --yes --package=pnpm@12.4.1 -- pnpm ...`을 사용할 수 있습니다.

### 상태 확인

- `GET /api/v1/health/live`: DB와 무관한 프로세스 상태 확인.
- `GET /api/v1/health/ready`: 기존 DB 연결의 `SELECT 1` 확인. 성공 시 200, 연결·쿼리 실패/timeout 시 503입니다. migration 적용 여부까지 검증하지는 않습니다.

Health 성공은 `{ success: true, data: { status: "ok" } }`, 오류는 일반 API와 같은 `{ success: false, error, message }` 형식입니다. `live`는 즉시 응답하고 `ready`의 DB 검사에만 Terminus 기본 API를 사용합니다. 별도 probe 응답 모델이나 전용 예외 필터는 두지 않습니다. Health OpenAPI는 상태 코드·설명을 제공하고 본문은 실제 HTTP 테스트로 확인합니다. 로그에는 요청 본문·SQL·토큰·원본 DB 오류를 기록하지 않습니다.

개발 DB는 named volume `devfootnote_postgres_data`에 저장됩니다. `docker compose stop postgres`는 데이터를 보존하며, 일반적인 중지·재시작에 volume 삭제 옵션을 사용하지 않습니다. 제품·workspace·개발 DB 이름은 `devfootnote`로 통일하며, 과거 검증 기록의 실행 결과는 보존합니다.

## 검증

의존성 설치 후 루트에서 실행합니다. 전체 build를 먼저 수행하고, 변경 범위에 필요한 검사를 선택합니다.

| 명령                    | 범위                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `pnpm build`            | DB 연결 없이 web·API·backend·api-client 빌드                          |
| `pnpm typecheck`        | workspace와 테스트의 strict TypeScript 검사                           |
| `pnpm lint`             | 생성물·빌드 산출물을 제외한 lint                                      |
| `pnpm test`             | 실제 Nest HTTP 계약·패키지 경계·색상 대비                             |
| `pnpm test:integration` | 격리 PostgreSQL의 migration·timeout·probe 복구·Pool 종료              |
| `pnpm openapi:check`    | OpenAPI·SDK 재생성 일치 검사. 차이가 있으면 생성 파일을 갱신하고 실패 |
| `pnpm test:browser`     | 빌드된 앱의 320px·1280px 로그인 진입 화면 smoke                       |

DB 통합 테스트는 Docker가 필요하며 개발 DB 대신 별도 Testcontainers를 사용합니다. macOS에서 Docker socket을 찾지 못하면 현재 Docker context의 socket을 `DOCKER_HOST`로 지정합니다.

브라우저 테스트 전에는 `pnpm exec playwright install chromium`과 `pnpm build`가 필요합니다. 현재 로그인 진입 화면 smoke는 별도 web `33000` 포트만 실행하며 API나 개발 서버를 재사용하지 않습니다. 실행 결과 JSON과 스크린샷은 `test-results/`에 남으며, `docs/evidence/`는 검증 시점에 의도적으로 보존한 기록이라 테스트가 덮어쓰지 않습니다. 이 화면 검사는 실제 Google 인증 검증과는 다릅니다.

위 명령은 [CI 워크플로](.github/workflows/ci.yml)에서도 같은 순서로 실행합니다. CI는 registry push나 클라우드 자격 증명을 사용하지 않습니다.

API 계약을 수정했다면 `pnpm openapi:generate`로 명세와 client를 함께 재생성합니다. 명세는 실제 `AppModule`을 그대로 기동해 만들므로 라우트가 늘어나도 별도 갱신이 필요 없습니다. 생성 코드는 직접 수정하지 않습니다.

DB schema 변경 시 사용하는 `pnpm db:generate`와 `pnpm db:migrate`는 조회가 아닌 명시적인 변경 작업입니다. `db:generate`는 `drizzle-kit`으로 SQL과 metadata만 만들고, `db:migrate`는 검토된 파일을 `drizzle-orm`의 migrator로 적용합니다. 실행기는 `DATABASE_URL`을 명시적으로 요구하고 advisory lock으로 동시 실행을 거부하며, 앱 시작·build는 migration을 자동 적용하지 않습니다.

## 문서

README는 프로젝트의 입구이며, 상세 요구사항과 기술 결정은 아래 문서에서 관리합니다.

- [기획](기획.md): 해결할 문제, 사용자, 제품 범위
- [제품 명세](docs/spec.md): 기능 요구사항과 수용 기준
- [개발 계획](docs/plan.md): 구현 순서와 단계별 검증
- [ADR](docs/adr/): 아키텍처·인증·검색·AI·운영 관련 의사결정
- [디자인 기준](DESIGN.md): 화면의 정보 위계와 시각 문법을 위한 참고 자료
- [Phase 0 검증 기록](docs/evidence/phase0/README.md): 실행 환경, 검사 결과와 한계
- [저장소 작업 지침](AGENTS.md): 코드 경계, YAGNI, 검증·Git 작업 규칙

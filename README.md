# devfootnote

> 나의 기록에, 나의 각주를

개발하며 남긴 메모와 참고한 원문을 함께 저장하고, 기억나는 단서로 다시 찾는 개인 자료함입니다. 흩어진 북마크를 모으는 데서 그치지 않고, **무엇을 읽었는지와 왜 저장했는지**를 함께 남깁니다.

Google 로그인, 자료 CRUD, 키워드 검색과 Gemini 기반 의미 검색·근거 답변을 제공합니다. 답변과 화면 복구 흐름은 구현·격리 검증 및 실제 모델의 소량 확인을 마쳤으며, 종합 품질 평가와 배포는 남아 있습니다.

## 주요 기능

- **개인 자료함** — Google 계정으로 로그인하고 계정별로 분리된 자료를 관리합니다.
- **자료 저장·편집** — 원문에 제목, 메모, 사용 맥락, 출처 URL을 덧붙입니다.
- **키워드 검색** — 한국어와 영어 기술 용어로 자료를 찾고 일치한 본문 구간을 확인합니다.
- **선택적 의미 검색** — 전송에 동의한 공개 학습 자료의 본문을 준비한 뒤 vector 또는 hybrid로 검색합니다. 준비되지 않았거나 AI를 사용할 수 없으면 이유와 함께 키워드 결과를 제공합니다.
- **원문 읽기** — 개인 메모와 저장 원문을 구분해 보고 Markdown으로 읽습니다.
- **변경 충돌 처리** — 중복 저장을 방지하고, 다른 탭에서 수정한 내용을 덮어쓰지 않도록 충돌을 알립니다.

로그인 이후 화면은 자료함 `/library`, 검색 `/search`, 자료 읽기 `/documents/[materialId]`로 구성합니다. 팀·공유 기능은 제공하지 않습니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 언어·모노레포 | TypeScript, pnpm workspace, Turborepo |
| 프론트엔드 | Next.js, React, Tailwind CSS, Radix UI, TanStack Query, React Hook Form |
| 백엔드 | NestJS, Passport, JWT, class-validator, Zod |
| 데이터베이스 | PostgreSQL 17, pgvector, Drizzle ORM |
| 임베딩 | Google Gemini API, `gemini-embedding-2` · 1,536차원 |
| 비동기 작업 기반 | Redis 7, BullMQ, NestJS worker |
| API 계약 | OpenAPI, `@hey-api/openapi-ts` |
| 테스트 | Vitest, Supertest, Testcontainers, Playwright, axe |
| 실행·CI | Docker Compose, GitHub Actions |

의미 검색은 Gemini 무료 등급을 기준으로 연결합니다. 무료 서비스의 입력·출력이 Google 제품 개선과 사람의 검토에 사용될 수 있으므로 민감·기밀·개인정보는 보내지 않습니다. 키를 설정해도 계정별 화면 동의 전에는 전송하지 않습니다. 구현과 실제 검증 범위는 [개발 계획](docs/plan.md#phase-2--ai-도입-gate-embedding과-hybrid-검색)을 따릅니다.

## 폴더 구조

```text
devfootnote/
├── apps/
│   ├── api/
│   │   ├── src/modules/       # auth · materials · search · health · indexing · usage-retention
│   │   ├── src/common/        # 공통 envelope·검증·pagination
│   │   ├── src/http/          # 앱 수준 HTTP 오류 조립
│   │   ├── src/infrastructure/ # DB 연결·로깅
│   │   └── openapi.json       # API 소유의 생성 명세
│   ├── worker/src/            # consumer·실행 상태·복구, 기능별 fence 확인
│   └── web/
│       └── src/
│           ├── app/           # 페이지·라우팅
│           ├── features/      # 기능별 화면·상태·API 연동
│           ├── components/    # 공통 UI
│           └── lib/           # HTTP client·provider
├── packages/
│   ├── ai/                    # API·worker의 Gemini 전송·승인 설정
│   ├── api-client/            # OpenAPI 생성 SDK·타입
│   ├── db/                    # 전체 schema·migration·연결 팩토리
│   └── queue/                 # queue/job 이름·work ID 계약
├── tests/                     # HTTP·DB 통합·브라우저 검사
├── scripts/                   # 환경 파일 로딩·API 생성 도구
├── docs/                      # 명세·개발 계획·설계 결정
└── docker-compose.yml
```

## 아키텍처

```text
Next.js ── 생성 API client ──▶ NestJS ── Drizzle ──▶ PostgreSQL
```

- **기능별 모듈러 모놀리스**: 인증·자료·검색을 Nest 모듈로 분리합니다. Controller는 HTTP, Service는 업무 흐름, Repository는 SQL과 트랜잭션을 담당합니다.
- **필요한 곳만 계층화**: auth/search/health는 레이어드, 자료의 revision·원자 저장을 다루는 materials는 라이트 헥사고날 구조를 사용합니다. 모듈 간 접근은 공개 진입점으로 제한하고 dependency-cruiser로 검사합니다.
- **API 계약 공유**: 프론트는 백엔드 소스를 직접 가져오지 않고 OpenAPI에서 생성한 SDK를 사용합니다.
- **저장 정합성**: 자료·revision·검색 데이터를 같은 트랜잭션에서 저장합니다. 멱등 요청과 revision 비교로 중복 저장·수정 충돌을 처리합니다.
- **비동기 경계**: API는 commit 뒤 큐에 전달하고 worker만 소비합니다. worker는 호출 시도를 DB에 확정한 뒤 transaction 밖에서 Gemini를 호출하고, 현재 자료·동의·lease를 다시 확인해 벡터와 비용을 확정합니다. Redis의 완료 상태가 아닌 PostgreSQL을 기준으로 복구합니다.

상세 구조와 선택 이유는 [패키지 경계](docs/adr/0001-monorepo-and-package-boundaries.md), [모듈 책임](docs/adr/0002-modular-monolith-domain-ownership.md), [DB·검색 설계](docs/adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md)에 정리했습니다.

## 로컬 실행

### 준비 사항

- Node.js `24.20.0`, pnpm `12.4.1`
- Docker Engine과 Docker Compose
- Google OAuth 웹 애플리케이션 클라이언트

### 환경변수

아래 파일을 직접 만듭니다. 실제 환경 파일은 Git에 포함하지 않습니다.

**`apps/api/.env.dev`**

```dotenv
DATABASE_URL=postgresql://devfootnote:devfootnote_local_only@127.0.0.1:55432/devfootnote
REDIS_URL=redis://127.0.0.1:56379
APP_ORIGIN=http://127.0.0.1:3000
GOOGLE_CLIENT_ID=<Google 클라이언트 ID>
GOOGLE_CLIENT_SECRET=<Google 클라이언트 secret>
JWT_ACCESS_SECRET=<access 서명 키>
JWT_REFRESH_SECRET=<refresh 서명 키>
CSRF_SECRET=<CSRF 서명 키>
```

서명 키 세 개는 각각 서로 다른 32바이트 이상의 난수로 생성해 hex/base64 문자열로 설정합니다. Google OAuth의 승인된 redirect URI에는 `http://127.0.0.1:3000/api/v1/auth/google/callback`을 등록합니다. OAuth 앱이 테스트 모드라면 사용할 Google 계정도 테스트 사용자로 등록합니다.

**`apps/web/.env.dev`**

```dotenv
API_UPSTREAM_URL=http://127.0.0.1:8000
```

**`apps/worker/.env.dev`**

```dotenv
DATABASE_URL=postgresql://devfootnote:devfootnote_local_only@127.0.0.1:55432/devfootnote
REDIS_URL=redis://127.0.0.1:56379
```

API의 `REDIS_URL`은 선택 사항이며 worker에서는 필수입니다. worker에는 Google OAuth/JWT secret을 넣지 않습니다.

의미 검색·답변을 사용할 때만 **API와 worker 각각**의 환경 파일에 `GEMINI_API_KEY=<Gemini API 키>`를 추가합니다. 같은 Gemini Free 프로젝트의 키를 사용합니다. API는 검색어, worker는 선택한 자료의 본문을 임베딩하고 요청된 답변을 생성합니다. 웹에는 키를 넣지 않습니다. 키가 없으면 해당 앱의 AI 설정은 비활성이며 저장·키워드 검색·읽기는 유지됩니다.

자료함의 의미 검색 패널에서 무료 데이터 조건과 **화면에 표시된 이번 준비 범위(최대 20개)가 모두 공개 가능한 자료인지** 확인한 뒤 동의·활성화합니다. 현재 화면은 자료별 선택 checkbox가 아니라 표시된 범위의 준비 가능한 자료를 함께 처리합니다. 이 범위와 활성화 이후 새로 저장·수정한 자료가 대상이며, 범위 밖 과거 자료를 자동 전송하지 않습니다. 제목·메모·맥락·출처 URL은 전송 대상이 아닙니다. 검색어는 의미/hybrid 검색 버튼을 눌렀을 때만 전송합니다. 검색 결과는 상위 50개까지이며 다음 페이지는 제공하지 않습니다. 무료 한도 오류(429)는 자동 재시도하지 않습니다.

무료 여부와 별도로 표준 단가 기준의 서비스 전체 월 참고 예산 $0.90과 목적별 상한(임베딩 $0.45·답변 $0.45)을 함께 제한합니다. 월 예산은 예약할 때 DB의 UTC 시각으로 선택하므로 월이 바뀌어도 기존 동의·벡터가 무효화되지 않습니다. 다만 2026-10-06 fingerprint 분리 이전 설치는 API·worker를 함께 갱신하고 한 번 재동의·활성화해야 합니다. 이전 설정 벡터는 정리 대상이므로 재처리 비용이 발생할 수 있습니다. 자동 유료 전환이나 다른 제공자로의 fallback은 없습니다. 상세 비용·보존 조건은 [AI 정책](docs/adr/0008-ai-provider-consent-budget-grounding-and-retention.md)을 참고하세요.

답변 기능은 검색 화면에서 별도 동의 후 준비된 현재 자료를 근거로 선택해 질문하는 방식입니다. 키가 있는 API·worker에 승인된 답변 정책을 구성하지만, 화면 동의·질문 요청 없이 답변을 자동 생성하지 않습니다. 원문·메모를 지우는 기능이 아니며 AI 답변·인용만 7일, 내용 없는 중복 호출 방지·비용 기록은 90일 보관합니다. 구현·격리 검증과 실제 합성 3건 확인의 결과·한계는 [Phase 3~4 작업 기록](docs/plans/2026-10-06-phase3-4-completion.md)을 따릅니다.

API·worker의 Pino 로그는 선택 설정 `LOG_LEVEL`로 조절합니다. 기본값은 `info`이며 `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`를 지원합니다.

`dev` 명령은 각 앱의 `.env.dev`, `start`는 `.env.prod`를 읽습니다. `NODE_ENV`는 명령에서 설정하므로 파일에 넣지 않습니다. 인증 설정의 상세 기준은 [인증 설계](docs/adr/0005-google-login-and-sessions.md)를 참고하세요.

### 실행 순서

저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres redis
pnpm db:migrate
pnpm dev
```

`pnpm dev`는 공유 패키지를 먼저 빌드합니다. 앱의 개발 서버는 각 앱 소스를 감시하며 공유 패키지를 따로 watch하지 않으므로 DB·queue·AI 소스 변경 후에는 다시 실행합니다. 기존 자료 기능만 실행하려면 `pnpm build:api` 뒤 worker 없이 API·웹의 `dev` 명령을 각각 사용해도 됩니다.

앱은 `Ctrl+C`로 종료합니다. 진행 중 worker 작업은 종료 유예를 거치므로 잠시 기다릴 수 있으며, Docker의 개발 DB·Redis는 그대로 유지됩니다. Redis가 없는 상태로 시작했더라도 앱 종료가 재연결을 무한히 기다리지는 않아야 합니다.

| 서비스 | 주소 |
| --- | --- |
| 웹 | http://127.0.0.1:3000/login |
| API | http://127.0.0.1:8000 |
| PostgreSQL | `127.0.0.1:55432` |
| Redis | `127.0.0.1:56379` |

브라우저도 `127.0.0.1`로 접속합니다. OAuth와 cookie 설정이 일치하도록 `localhost`와 섞지 않습니다. 브라우저의 API 요청은 Next.js rewrite를 거쳐 백엔드로 전달됩니다.

기존 환경을 갱신할 때는 **API·worker 중지 → 대상 DB 확인·migration → 새 앱 시작** 순서를 따릅니다. migration은 `packages/db/migrations` 하나로 관리하고 API의 환경 파일을 선택해 명시적으로 적용합니다. 앱 시작 시 자동 적용되지 않습니다. 의존성 중지는 `docker compose stop postgres redis`를 사용하며, `down -v`는 저장 데이터를 삭제하므로 주의하세요.

### 로컬 기능 확인 순서

무료 AI에는 공개 가능한 샘플만 사용합니다. 처음에는 짧은 원문 2~3개로 시작하고, 개인정보·회사 자료·키는 넣지 않습니다.

1. **로그인·저장·읽기:** 로그인한 뒤 원문과 메모를 따로 등록하고 자료함·읽기 화면에서 확인합니다.
2. **키워드 검색·수정·삭제:** 저장한 단어로 검색하고 수정된 내용이 반영되는지, 삭제한 자료가 목록·검색에서 사라지는지 확인합니다.
3. **의미 검색 준비:** 자료함 패널에 표시된 준비 범위가 모두 공개 가능한 자료인지 확인한 뒤 동의·활성화합니다. worker가 실행 중이어야 하며 준비 완료를 기다립니다. 이전 fingerprint 설치는 재동의·활성화가 한 번 필요합니다.
4. **의미 검색:** `/search`에서 의미 또는 혼합 검색을 직접 실행합니다. 무료 한도 오류가 나면 반복 클릭하지 말고 키워드 검색으로 확인합니다.
5. **답변:** 별도 답변 동의 후 준비된 현재 자료를 근거로 선택하고 질문합니다. 답변·인용 링크를 확인합니다. worker의 처리 회차 때문에 잠시 대기할 수 있습니다.
6. **차단·복구:** 근거 자료를 수정하거나 답변 동의를 철회한 뒤 이전 답변이 숨겨지는지, 로그아웃하면 보호 화면에서 나오는지 확인합니다. AI가 차단되어도 저장·키워드 검색·원문 읽기는 유지되어야 합니다.

### 빌드된 앱 실행

개발 중에는 DB·Redis를 Docker로 띄우고 `pnpm dev`를 사용합니다. API·웹·worker까지 이미지로 확인하려면 migration을 적용하고 호스트 앱을 종료한 뒤 실행합니다.

```sh
docker compose --profile app up -d --build --wait
```

접속 주소는 동일합니다. 종료는 `docker compose --profile app stop`입니다. 이 구성은 로컬 실행용이며 운영 배포 구성은 아닙니다.

## 검증

의존성 설치 후 필요한 검사를 선택해 실행합니다.

| 명령 | 용도 |
| --- | --- |
| `pnpm build` | 전체 앱·패키지 빌드 |
| `pnpm typecheck` | 타입 생성·TypeScript 검사 |
| `pnpm lint` | ESLint·Prettier·아키텍처 경계 검사 |
| `pnpm format` | 코드 형식 자동 수정 |
| `pnpm test` | 단위·HTTP 계약·인증 transport 검사 |
| `pnpm test:integration` | 실제 PostgreSQL·Redis의 인증·자료·검색·활성화·실행/복구 검사 |
| `pnpm test:browser` | 로그인·CRUD·검색·오류 복구·접근성 여정 |
| `pnpm test:images` | 앱 이미지의 HTTPS 인증·worker 기동·Redis 중단·DB 복구 |
| `pnpm openapi:check` | OpenAPI·생성 SDK 재생성 및 변경 여부 검사 |

DB 통합·브라우저·이미지 검사는 실행 중인 Docker가 필요하며 개발 DB 대신 격리된 DB를 사용합니다. 브라우저·이미지 검사 전에는 `pnpm build`와 `pnpm exec playwright install chromium`을 실행합니다. 이미지 검사는 Docker Compose 2.24.4 이상과 OpenSSL도 필요합니다. 자동 인증 검사는 Google 응답 fixture를 사용하므로 실제 Google 비밀값이 필요하지 않습니다.

`openapi:check`는 생성 파일을 변경할 수 있습니다. API 계약을 변경했다면 `pnpm openapi:generate`로 명세와 SDK를 함께 갱신합니다. 테스트 결과는 Git에서 제외한 `test-results/`에 저장합니다. 테스트 선택 기준과 검색 벤치마크는 [검증 설계](docs/adr/0009-verification-observability-and-search-evaluation.md), CI 실행 항목은 [워크플로](.github/workflows/ci.yml)를 참고하세요.

임베딩 후보의 실제 평가는 일반 테스트·CI와 분리합니다. `pnpm build:backend` 후 `node tests/evaluations/embedding.mjs --check`로 격리 DB와 실행기만 점검할 수 있습니다(외부 AI 호출 없음). 현재 Gemini 무료 등급의 합성 자료만 평가하며 실제 개인 자료는 전송하지 않습니다. 승인 예산·수동 실행 명령·중복 호출 차단·현재 제한 사항은 [임베딩 제공자 평가](docs/plans/2026-09-30-phase2-provider-gate.md)를 따릅니다.

답변의 소량 확인도 별도 수동 평가입니다. `node tests/evaluations/answers.mjs --check`는 외부 호출 없이 예약·정산 경로를 검사합니다. 실제 3건 평가 결과와 호출 명령·재실행 차단은 [답변 작업 기록](docs/plans/2026-10-06-phase3-4-completion.md#2026-10-07-실제-답변-소량-평가-승인)을 참고하세요. 소량 확인을 종합 품질 평가로 해석하지 않습니다.

## 배포

현재 미배포 상태입니다. API·웹의 Docker 이미지는 준비되어 있으며, 배포 환경과 공개 주소는 추후 확정합니다.

웹의 `API_UPSTREAM_URL`은 rewrite에 사용되므로 **빌드 시점에 주입**해야 합니다. `pnpm build`는 `.env.prod`를 자동으로 읽지 않으며, 실행 시점에만 주소를 바꿔도 기존 빌드에는 반영되지 않습니다.

## 관련 문서

- [기획](기획.md) — 해결하려는 문제와 제품 범위
- [제품 명세](docs/spec.md) — 기능 요구사항과 수용 기준
- [개발 계획](docs/plan.md) — 이후 개발 범위와 검증 기록
- [설계 결정](docs/adr/) — 아키텍처·인증·검색·디자인의 선택 근거
- [검색 측정 기록](docs/benchmarks/keyword-search.md) — keyword·snippet의 변경 전후 측정과 한계
- [기여·작업 지침](AGENTS.md) — 코드 작성과 변경·검증 규칙

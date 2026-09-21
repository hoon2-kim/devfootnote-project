# devfootnote

> 나의 기록에, 나의 각주를

개발하며 남긴 메모와 참고한 원문을 함께 저장하고, 기억나는 단서로 다시 찾는 개인 자료함입니다. 흩어진 북마크를 모으는 데서 그치지 않고, **무엇을 읽었는지와 왜 저장했는지**를 함께 남깁니다.

현재 Google 로그인, 자료 CRUD, 키워드 검색을 구현했습니다. 의미 검색과 저장 자료 기반 AI 답변은 개발 예정이며, 아직 배포하지 않았습니다.

## 주요 기능

- **개인 자료함** — Google 계정으로 로그인하고 계정별로 분리된 자료를 관리합니다.
- **자료 저장·편집** — 원문에 제목, 메모, 사용 맥락, 출처 URL을 덧붙입니다.
- **키워드 검색** — 한국어와 영어 기술 용어로 자료를 찾고 일치한 본문 구간을 확인합니다.
- **원문 읽기** — 개인 메모와 저장 원문을 구분해 보고 Markdown으로 읽습니다.
- **변경 충돌 처리** — 중복 저장을 방지하고, 다른 탭에서 수정한 내용을 덮어쓰지 않도록 충돌을 알립니다.

로그인 이후 화면은 자료함 `/library`, 검색 `/search`, 자료 읽기 `/documents/[materialId]`로 구성합니다. 팀·공유 기능은 제공하지 않습니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 언어·모노레포 | TypeScript, pnpm workspace, Turborepo |
| 프론트엔드 | Next.js, React, Tailwind CSS, Radix UI, TanStack Query, React Hook Form |
| 백엔드 | NestJS, Passport, JWT, class-validator, Zod |
| 데이터베이스 | PostgreSQL 17, Drizzle ORM |
| API 계약 | OpenAPI, `@hey-api/openapi-ts` |
| 테스트 | Vitest, Supertest, Testcontainers, Playwright, axe |
| 실행·CI | Docker Compose, GitHub Actions |

pgvector는 DB 확장만 설치된 상태입니다. Redis·BullMQ와 AI 모델 연동은 아직 도입하지 않았습니다.

## 폴더 구조

```text
devfootnote/
├── apps/
│   ├── api/
│   │   ├── src/modules/       # auth · materials · search · health
│   │   ├── src/common/        # 공통 envelope·검증·pagination
│   │   ├── src/http/          # 앱 수준 HTTP 오류 조립
│   │   ├── src/infrastructure/ # DB 연결·로깅
│   │   ├── drizzle/           # migration SQL·metadata
│   │   └── openapi.json       # API 소유의 생성 명세
│   └── web/
│       └── src/
│           ├── app/           # 페이지·라우팅
│           ├── features/      # 기능별 화면·상태·API 연동
│           ├── components/    # 공통 UI
│           └── lib/           # HTTP client·provider
├── packages/api-client/       # OpenAPI 생성 SDK·타입
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

`dev` 명령은 각 앱의 `.env.dev`, `start`는 `.env.prod`를 읽습니다. `NODE_ENV`는 명령에서 설정하므로 파일에 넣지 않습니다. 인증 설정의 상세 기준은 [인증 설계](docs/adr/0005-google-login-and-sessions.md)를 참고하세요.

### 실행 순서

저장소 루트에서 실행합니다.

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev
```

| 서비스 | 주소 |
| --- | --- |
| 웹 | http://127.0.0.1:3000/login |
| API | http://127.0.0.1:8000 |
| PostgreSQL | `127.0.0.1:55432` |

브라우저도 `127.0.0.1`로 접속합니다. OAuth와 cookie 설정이 일치하도록 `localhost`와 섞지 않습니다. 브라우저의 API 요청은 Next.js rewrite를 거쳐 백엔드로 전달됩니다.

기존 환경을 갱신할 때는 **API 중지 → 대상 DB 확인·migration → 새 API 시작** 순서를 따릅니다. migration은 앱 시작 시 자동 적용되지 않습니다. DB 중지는 `docker compose stop postgres`를 사용하며, `down -v`는 저장 데이터를 삭제하므로 주의하세요.

### 빌드된 앱 실행

개발 중에는 DB만 Docker로 띄우고 `pnpm dev`를 사용합니다. API·웹까지 이미지로 확인하려면 migration을 적용하고 호스트 앱을 종료한 뒤 실행합니다.

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
| `pnpm test:integration` | 실제 PostgreSQL의 인증·자료·검색·트랜잭션 검사 |
| `pnpm test:browser` | 로그인·CRUD·검색·오류 복구·접근성 여정 |
| `pnpm test:images` | 앱 이미지의 HTTPS 인증·재시작·DB 장애 복구 |
| `pnpm openapi:check` | OpenAPI·생성 SDK 재생성 및 변경 여부 검사 |

DB 통합·브라우저·이미지 검사는 실행 중인 Docker가 필요하며 개발 DB 대신 격리된 DB를 사용합니다. 브라우저·이미지 검사 전에는 `pnpm build`와 `pnpm exec playwright install chromium`을 실행합니다. 이미지 검사는 Docker Compose 2.24.4 이상과 OpenSSL도 필요합니다. 자동 인증 검사는 Google 응답 fixture를 사용하므로 실제 Google 비밀값이 필요하지 않습니다.

`openapi:check`는 생성 파일을 변경할 수 있습니다. API 계약을 변경했다면 `pnpm openapi:generate`로 명세와 SDK를 함께 갱신합니다. 테스트 결과는 Git에서 제외한 `test-results/`에 저장합니다. 테스트 선택 기준과 검색 벤치마크는 [검증 설계](docs/adr/0009-verification-observability-and-search-evaluation.md), CI 실행 항목은 [워크플로](.github/workflows/ci.yml)를 참고하세요.

## 배포

현재 미배포 상태입니다. API·웹의 Docker 이미지는 준비되어 있으며, 배포 환경과 공개 주소는 추후 확정합니다.

웹의 `API_UPSTREAM_URL`은 rewrite에 사용되므로 **빌드 시점에 주입**해야 합니다. `pnpm build`는 `.env.prod`를 자동으로 읽지 않으며, 실행 시점에만 주소를 바꿔도 기존 빌드에는 반영되지 않습니다.

## 관련 문서

- [기획](기획.md) — 해결하려는 문제와 제품 범위
- [제품 명세](docs/spec.md) — 기능 요구사항과 수용 기준
- [개발 계획](docs/plan.md) — 이후 개발 범위와 검증 기록
- [설계 결정](docs/adr/) — 아키텍처·인증·검색·디자인의 선택 근거
- [기여·작업 지침](AGENTS.md) — 코드 작성과 변경·검증 규칙

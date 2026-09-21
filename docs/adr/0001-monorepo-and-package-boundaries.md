# ADR-0001: devfootnote 모노레포와 패키지 경계

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-18 — API 내부 기능 모듈 통합·선택적 라이트 헥사고날·worker 공유 기준
- Canonical owner: workspace 구조, 패키지 의존성 DAG, import 경계와 로컬 개발 실행 구성

## Context

devfootnote는 Next.js 웹, NestJS API와 NestJS worker를 한 저장소에서 개발하는 단일 제품이다. API와 worker는 같은 도메인 규칙을 사용하지만 실행 수명주기는 다르고, 웹은 HTTP 계약만 알아야 한다. 작은 단일 운영자 제품에 마이크로서비스나 미리 만든 공용 계층을 도입하지 않으면서도 private 구현 접근과 순환 의존을 구조적으로 막아야 한다.

## Decision

pnpm workspace로 앱과 라이브러리의 의존성을 관리하고, Phase 0부터 Turborepo로 실제로 존재하는 개발·빌드·검사 작업의 실행 순서를 관리한다. Turbo는 모노레포 작업 도구이며 backend 아키텍처나 배포 도구가 아니다. Node.js는 scaffold 시점의 지원 LTS를 사용하고 의존성은 호환 가능한 stable 조합으로 exact pin한다. DB는 `pg` Pool, `drizzle-orm/node-postgres` adapter와 Drizzle Kit를 사용한다. 별도 ORM이나 DB client 생성 단계를 추가하지 않는다. 원격 cache와 Nx는 도입하지 않는다.

초기 Turbo 설정은 해당 phase의 실제 package script와 build 의존성만 포함한다. build/typecheck/lint 같은 결정적 작업은 실제 입력·출력·환경변수·도구 버전을 반영해 로컬 cache를 사용하고, 계속 실행되는 dev 작업과 DB·큐 통합 테스트·브라우저 E2E·migration·seed는 cache로 건너뛰지 않는다. Docker 이미지 실행의 성공이나 DB 상태를 build cache hit로 대신하지 않는다. 아직 없는 worker의 task나 범용 task generator를 미리 만들지 않는다.

루트 `tsconfig.json`·`.nvmrc`는 Turbo globalDependencies에 포함한다. root에서 직접 실행하는 통합·브라우저·migration 명령을 사용되지 않는 Turbo task로 중복 선언하지 않는다. `pnpm typecheck`는 compiled API를 참조하는 테스트 타입 검사를 위해 API build를 먼저 수행하고, web은 `next typegen && tsc --noEmit`을 실행한다. 생성 타입 재생성이 생략되지 않도록 web typecheck만 cache를 끈다.

Next가 관리하는 `next-env.d.ts`는 Git/Docker context에서 제외하고 수동 수정하지 않는다. 일반 `.next`와 브라우저 검증 `.next-playwright` 출력은 분리하되 next-env의 내용이 고정이라고 가정하지 않는다. typegen이 검사 직전에 현재 설정의 참조를 생성한다. 의존성 설치 뒤 기존 Next/API 생성물이 없는 상태에서도 root typecheck를 실행할 수 있어야 한다. 일반 build와 브라우저 테스트의 실행만으로 추적 파일을 변경하지 않는지 확인한다.

Drizzle schema는 backend TypeScript 소스와 함께 빌드한다. Drizzle Kit의 SQL migration 생성·검토·적용은 명시적인 DB 변경 작업이며 일반 build의 선행 작업이나 숨은 부수 효과로 실행하지 않는다. DB 연결이나 실제 credential 없이 backend와 이를 사용하는 API/worker를 빌드할 수 있어야 한다.

현재 백엔드 업무 코드의 소비자는 API 하나다. 기존 `packages/backend`를 제거하고 HTTP·업무·저장을 `apps/api/src/modules`의 같은 기능 안에 배치한다. 모노레포라는 이유로 앱 전용 코드를 packages로 분리하지 않는다.

```text
apps/
  web/src/
    app/                       # 라우팅·페이지 조립
    features/                  # 화면별 상태·폼·컴포넌트
    components/ui/             # 웹 UI
    lib/                       # 생성 API client 연결
  api/
    drizzle/                   # 모든 SQL·snapshot·journal: 단일 migration 이력
    drizzle.config.ts
    scripts/migrate.mjs
    src/
      main.ts
      app.module.ts
      config/                  # Nest Config·Zod
      common/                  # feature를 모르는 envelope·검증 오류·pagination
      http/filters/            # 앱 수준 업무 오류 → HTTP 조립
      infrastructure/
        database/              # singleton Pool·Drizzle 주입·종료
        logging/logger.ts      # 한 번 설정한 Pino
      modules/
        auth/                  # 레이어드
          index.ts
          auth.module.ts
          auth.controller.ts
          auth.schema.ts
          dto/response/
          guards/
          strategies/
          decorators/
          services/
          repositories/
        materials/             # 라이트 헥사고날
          index.ts
          materials.module.ts
          presentation/
            materials.controller.ts
            dto/request/
            dto/response/
          application/
            materials.service.ts
            materials.types.ts
            ports/materials.repository.ts
          domain/              # Nest·ORM 없는 본문 규칙·값·오류
          infrastructure/      # Drizzle 저장 구현·schema
        search/                # 레이어드; materials 공개 조회 사용
          index.ts
          search.module.ts
          search.controller.ts
          search.service.ts
          dto/
        health/                # 기술 모듈; 기존 DB로 ready 확인
          index.ts
          health.module.ts
          health.controller.ts
          health.service.ts
packages/
  api-client/                  # OpenAPI 생성 SDK·타입
tests/                         # HTTP·실제 DB·브라우저 흐름
```

현재 workspace edge는 `apps/web → packages/api-client` 하나다. API 업무 코드는 API 내부에 있으며 앱 사이 import는 금지한다. 웹은 Nest DTO·Service·DB schema를 import하지 않는다. `api-client`의 공개 entry는 `@devfootnote/api-client`와 `@devfootnote/api-client/client`만 유지한다. OpenAPI가 HTTP 계약이고 별도 contracts/zod 공유 패키지를 중복 도입하지 않는다.

다른 기능은 `modules/<feature>/index.ts`에서 공개한 Module·Service·값/오류 타입만 import한다. Nest Module의 exports와 소스 import 경계를 모두 지킨다. Repository·schema·DB handle은 공개하지 않는다. feature 내부는 자기 index를 거치지 않는 직접 import로 순환을 피한다. 실제 HTTP에 필요한 auth의 Public decorator·요청 타입·CSRF 연결 공개는 업무 DAG와 구분한다. 공통 filter는 공개 업무 오류를 HTTP로 변환할 수 있다.

auth/search/health는 레이어드, materials만 application의 좁은 저장 포트와 infrastructure 구현을 구분한다. 전달만 하는 UseCase·BaseRepository·범용 mapper를 추가하지 않는다. root infrastructure는 연결·로그의 기술 구성을 제공하며 업무 정책을 import하지 않는다. materials의 infrastructure는 같은 모듈 application 포트를 구현하므로 이를 root infrastructure와 혼동하지 않는다. 자세한 owner·transaction 규칙은 [ADR-0002](0002-modular-monolith-domain-ownership.md)를 따른다.

### Worker 도입 시 공유 범위

`apps/worker`는 Phase 2에서 실제 실행 기능과 함께 만든다. 같은 DB를 사용하게 되면 **전체 schema·migration 이력·Kit 설정·커넥션 팩토리를 한 번에 `packages/db`로 이동**한다. 일부 schema만 분리하거나 API/worker별 migration stream을 만들지 않는다.

- DDL 정의·런타임 schema 객체는 공유하지만 테이블 접근은 해당 owner의 Repository로 제한한다.
- Pool은 공유 프로세스 객체가 아니다. API/worker 각각 bounded Pool을 생성·종료하며 연결 수를 합산한다.
- migration 적용 주체는 하나이며 앱 startup에서 자동 실행하지 않는다.
- job 이름·payload는 API producer와 worker consumer가 실제로 생길 때 `packages/queue`로 분리한다. consumer·processor·scheduler 등록은 worker만 소유한다.
- 업무 코드는 양쪽에 실제 동일 책임이 있을 때만 별도 패키지로 승격한다. worker가 저장된 immutable chunk를 읽는다면 청킹 규칙을 공유하거나 복사할 필요가 없다.
- API/worker가 자기 작업용 저장 구현을 별도로 갖더라도 테이블 write owner와 publication fence를 우회하지 않는다. 필요한 공개 협력 코드는 그 slice에서 승격하며 앱 간 소스 import로 연결하지 않는다.

이 단계의 예상 edge는 web→api-client, API/worker→db·queue이며 추가 업무 패키지 edge는 실제 필요와 함께 결정한다. 미래 디렉터리·빈 placeholder는 지금 만들지 않는다.

### 로컬 개발 실행 구성

일상 개발의 외부 의존성은 루트 `docker-compose.yml`의 **Docker Compose**로 실행한다. Next.js web, NestJS API와 worker는 호스트에서 Turbo가 실제 pnpm 개발 script를 실행하게 해 코드 변경 반영과 디버깅을 쉽게 한다. 별도 개발용 오케스트레이터나 소스 bind mount 기반의 앱 컨테이너 개발 환경은 만들지 않는다.

파일명은 `docker-compose.yml`을 사용하되 CLI는 현재 Docker Compose plugin의 `docker compose`를 기준으로 한다. 파일명 선택이 legacy `docker-compose` 실행 파일 사용을 뜻하지 않으며 구체 명령은 구현된 설정에 맞춰 기록한다.

- 호스트 개발 주소는 web `http://127.0.0.1:3000`, API `http://127.0.0.1:8000`이다. Next rewrite가 `/api/v1/:path*`를 API의 같은 경로로 전달해 브라우저는 상대 경로만 사용한다. 이 고정 개발 주소를 위한 추가 환경 옵션이나 별도 proxy 제품은 도입하지 않는다. same-origin cookie 계약과 ADR-0005의 localhost HTTP 개발 예외를 적용하며 운영 HTTPS·컨테이너 proxy는 해당 후속 slice에서 검증한다.
- 일상 개발의 기본 의존성은 Phase 0·1부터 pgvector를 지원하는 PostgreSQL 컨테이너다. 이미지 지원과 벡터 기능 사용은 구분하며, vector column·차원·의미 검색은 Phase 2의 AI 도입 gate 뒤에만 추가한다. Phase 2에서 Redis 서비스를 추가하고, 그때 도입하는 worker도 호스트에서 실행한다. Phase 1부터의 선택 `app` profile은 아래 이미지 검증 구성으로 구분한다. Redis나 worker 없이 첫 저장·keyword 검색·읽기 여정이 동작해야 한다.
- 이미지의 PostgreSQL·pgvector·Redis 버전은 해당 도입 단계에 호환성을 확인해 고정한다. 개발용 공개 포트는 loopback에만 바인딩하고 운영 credential을 사용하지 않는다. 앱의 연결 설정은 호스트에 공개된 주소·포트를 사용한다.
- PostgreSQL 개발 데이터는 named volume으로 유지한다. 일반적인 중지·재시작과 volume 삭제·DB 초기화를 구분하고 개발 데이터를 자동으로 지우지 않는다. healthcheck와 실제 연결로 필수 PostgreSQL의 준비 상태를 확인한다. Phase 2 이후에도 Redis 전체 성공을 API 기동 조건으로 묶지 않으며, Redis 장애는 큐 기능만 저하시키고 저장·keyword 검색·읽기는 유지한다.
- Compose 실행을 schema 적용으로 간주하지 않는다. 검토된 Drizzle Kit SQL migration은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)에 따라 명시적으로 적용하며, DB 생성만으로 migration 완료를 주장하거나 앱 시작 시 자동 적용하지 않는다.
- 자동화된 DB·큐 통합 테스트는 개발 Compose와 별도의 Testcontainers 환경을 사용한다. 격리와 cleanup은 [ADR-0009](0009-verification-observability-and-search-evaluation.md)를 따른다.

### 앱 이미지와 선택적 통합 실행

Docker는 DB 실행뿐 아니라 빌드 산출물과 실행 환경을 검증하는 데도 사용한다. Phase 1에 `apps/web/Dockerfile`·`apps/api/Dockerfile`, Phase 2에 `apps/worker/Dockerfile`을 추가하는 계획으로 한다. 각 Dockerfile은 monorepo root를 build context로 사용하며 필요한 workspace 의존성까지 빌드한다. multi-stage build로 빌드 도구와 runtime 산출물을 분리하고, runtime은 non-root로 실행한다. root `.dockerignore`로 실제 secret·환경 파일·불필요한 산출물을 제외하며 build argument·image layer에 credential을 넣지 않는다.

API·web 빌드는 root/workspace manifest·lockfile·catalog 설정을 먼저 복사해 `pnpm install --frozen-lockfile`을 실행하고, 그 뒤 소스를 복사·빌드한다. 소스만 변경하면 설치 레이어를 재사용한다. workspace나 설치에 영향을 주는 설정·hook을 추가할 때는 소스 복사 이후가 아니라 이 의존성 레이어의 입력에 포함한다. 2026-09-19 로컬 API·web 재빌드에서 install 단계의 `CACHED`와 실제 HTTPS 이미지 여정 통과를 확인했다. migration target의 경량화·registry push는 이번 변경에 포함하지 않았다.

backend를 포함하는 이미지 build는 TypeScript schema와 backend/app 소스를 빌드하며 DB 연결·DB client 생성·SQL migration 생성/적용을 선행 조건으로 삼지 않는다. runtime에는 해당 앱에 필요한 `pg`·Drizzle runtime 의존성과 컴파일된 backend를 포함한다. 명시적인 migration 단계에는 Drizzle Kit 설정·도구와 검토된 SQL migration 산출물을 준비하며, 이를 모든 앱의 runtime image에 일률적으로 넣거나 build/API/worker startup에서 실행하지 않는다. 대상 DB 주소 확인과 단일 migration 실행 주체는 ADR-0003의 계약을 따른다.

루트 Compose의 선택적 `app` profile은 해당 phase에 존재하는 앱의 **빌드된 runtime 이미지**를 DB 및 필요한 Redis와 함께 실행해 시작·연결·종료와 대표 HTTP 여정을 확인한다. 호스트 Turbo 개발 모드와 동시에 같은 포트를 쓰도록 실행하지 않는다. 앱 내부 연결은 Compose service 주소를 사용하지만, 브라우저에는 하나의 origin과 `/api/v1` 경로를 제공한다. cookie·CSRF·HTTPS 및 환경별 callback 계약은 ADR-0005/0007을 유지한다. 이를 연결하는 구체 proxy 제품은 이 결정에서 고정하지 않는다.

이미지 통합 모드에서도 PostgreSQL은 필수이고 Redis 장애는 선택 기능만 저하시킨다. API가 Redis health를 필수 `depends_on` 조건으로 기다리거나 consumer 초기화 때문에 기동하지 못하는 구성을 만들지 않는다. migration은 검토한 SQL을 명시적으로 적용하며 앱 이미지 시작에 숨기지 않는다. 개발 named volume의 보존과 Testcontainers의 격리는 실행 모드가 바뀌어도 유지한다.

앱 이미지가 도입된 phase의 CI에는 이미지 build와 임시 환경의 최소 runtime smoke 검증을 연결한다. 이는 제품 통합 테스트를 대체하지 않으며 개발 데이터나 운영 credential을 사용하지 않는다. 로컬 Docker 이미지 규칙은 production container runtime이나 배포 topology의 선택이 아니다. registry push, cloud resource, image delivery와 배포는 [ADR-0010](0010-aws-terraform-decision-gate.md)의 Phase 6 별도 결정·승인까지 유예한다.

문서 반영만 요청된 작업에서는 `docker-compose.yml`, Dockerfile, `.dockerignore`, Turbo/환경 설정·script를 만들거나 Docker를 실행하지 않는다. 승인된 scaffold/구현 작업에서는 해당 phase에 실제 존재하는 구성과 실행 명령을 일치하게 기록하고 문서 갱신과 제품 검증 완료를 구분한다.

## Ownership

| 경계 | 소유자 | 책임 |
|---|---|---|
| workspace와 root package 정책 | repository composition | pnpm workspace, 최소 Turbo task graph, exact dependency, export map |
| 로컬 개발·이미지 검증 | repository composition | 루트 Docker Compose, 단계별 DB·Redis와 앱 이미지, 개발 데이터 보존 |
| 웹 route/layout composition | `apps/web` | `/login`, `/library`, `/search`, `/documents/[materialId]` 조립 |
| HTTP/Passport 연결 | `apps/api` | backend public port 호출과 Google·JWT protocol mapping |
| queue/scheduler adapter | `apps/worker` | backend public port 호출과 process lifecycle |
| API client | `packages/api-client` | OpenAPI 생성 client/type, JWT cookie 인증·재발급 transport option |
| 도메인 규칙과 상태 전이 | `apps/api/src/modules`의 각 feature | ADR-0002의 단일 owner와 public port |
| DB/queue/AI/관측 기계장치 | `apps/api/src/infrastructure` | policy-free adapter |

## Consequences

- 현재 API 전용 코드를 패키지로 분리하지 않으며, worker와 실제로 공유하는 계약만 나중에 승격한다.
- 웹과 backend 배포를 분리해도 compile-time coupling이 생기지 않는다.
- export map과 DAG 검증을 유지해야 하며, 작은 기능도 편의를 위한 deep import를 허용할 수 없다.
- 추가 공용 workspace package를 만들기 전 독립 계약과 두 caller를 입증하므로 초기에는 다소 긴 로컬 경로를 감수한다. 생성 HTTP 계약인 `api-client`에는 두 caller를 요구하지 않는다.
- 익숙한 Nest Module/Service 조립을 사용하되 공개 업무 메서드와 private 저장소의 경계를 검사해야 한다.
- Turbo와 Docker 설정은 실제 작업·이미지 산출물에 맞춰 유지한다. 로컬 cache와 이미지 smoke 성공은 상태 기반 정합성 검증이나 배포 승인을 뜻하지 않는다.
- 현재 실행 앱은 web/API이며 worker는 후속 단계다. 하나의 제품·DB 경계이고 분산 transaction을 주장하지 않는다.

## Verification

- `pnpm lint:architecture`의 dependency-cruiser가 모듈 공개 진입점·private 저장소·계층 방향·순환 의존을 검사한다. 전용 import graph parser를 테스트 코드로 다시 만들지 않는다.
- `pnpm typecheck`와 `pnpm openapi:check`로 앱·생성 SDK 계약을 확인하고 실제 JSON은 HTTP 통합으로 검증한다.
- DB 연결·실제 secret 없이 빌드하며 migration이 build/startup에 포함되지 않는지 검토한다.
- 실제 PostgreSQL에서 원자 저장·CAS·Pool 종료를 검증한다. import 검사만으로 같은 tx 사용을 증명했다고 주장하지 않는다.
- 앱 이미지·same-origin·non-root·개발 volume 보존은 별도 실행 검증이며 결과를 로컬 HTTP/Testcontainers 검사와 구분한다.

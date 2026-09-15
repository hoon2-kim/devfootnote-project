# ADR-0001: devfootnote 모노레포와 패키지 경계

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-15 — package DAG와 로컬 포트를 유지하고 공유 Pino logger의 공개 경계 및 Phase 0 API ping 설정 제거 반영
- Canonical owner: workspace 구조, 패키지 의존성 DAG, import 경계와 로컬 개발 실행 구성

## Context

devfootnote는 Next.js 웹, NestJS API와 NestJS worker를 한 저장소에서 개발하는 단일 제품이다. API와 worker는 같은 도메인 규칙을 사용하지만 실행 수명주기는 다르고, 웹은 HTTP 계약만 알아야 한다. 작은 단일 운영자 제품에 마이크로서비스나 미리 만든 공용 계층을 도입하지 않으면서도 private 구현 접근과 순환 의존을 구조적으로 막아야 한다.

## Decision

pnpm workspace로 앱과 라이브러리의 의존성을 관리하고, Phase 0부터 Turborepo로 실제로 존재하는 개발·빌드·검사 작업의 실행 순서를 관리한다. Turbo는 모노레포 작업 도구이며 backend 아키텍처나 배포 도구가 아니다. Node.js는 scaffold 시점의 지원 LTS를 사용하고 의존성은 호환 가능한 stable 조합으로 exact pin한다. DB는 `pg` Pool, `drizzle-orm/node-postgres` adapter와 Drizzle Kit를 사용한다. 별도 ORM이나 DB client 생성 단계를 추가하지 않는다. 원격 cache와 Nx는 도입하지 않는다.

초기 Turbo 설정은 해당 phase의 실제 package script와 build 의존성만 포함한다. build/typecheck/lint 같은 결정적 작업은 실제 입력·출력·환경변수·도구 버전을 반영해 로컬 cache를 사용하고, 계속 실행되는 dev 작업과 DB·큐 통합 테스트·브라우저 E2E·migration·seed는 cache로 건너뛰지 않는다. Docker 이미지 실행의 성공이나 DB 상태를 build cache hit로 대신하지 않는다. 아직 없는 worker의 task나 범용 task generator를 미리 만들지 않는다.

Drizzle schema는 backend TypeScript 소스와 함께 빌드한다. Drizzle Kit의 SQL migration 생성·검토·적용은 명시적인 DB 변경 작업이며 일반 build의 선행 작업이나 숨은 부수 효과로 실행하지 않는다. DB 연결이나 실제 credential 없이 backend와 이를 사용하는 API/worker를 빌드할 수 있어야 한다.

최종 workspace의 허용 목표 구조는 다음과 같다. 단계별 구현은 현재 vertical slice에 필요한 node만 갖는 이 구조의 부분집합이며, 아직 caller가 없는 app·feature·package를 빈 placeholder로 만들지 않는다.

```text
docker-compose.yml             # 로컬 DB·Redis와 선택적 앱 이미지 실행
.dockerignore                  # 이미지 빌드에서 secret·불필요한 파일 제외
turbo.json                     # 실제 package script의 작업 순서와 로컬 cache
pnpm-workspace.yaml            # apps·packages workspace 선언
pnpm-lock.yaml                 # 승인된 의존성 버전 고정
package.json                   # 루트 작업 진입점
docs/                          # 요구사항·구현 계획·기술 결정
apps/
  web/
    Dockerfile                 # Phase 1부터 로컬·CI에서 검증할 실행 이미지
    src/
      app/                     # 페이지·레이아웃·provider 조립
      features/                # 화면별 컴포넌트·폼·서버 상태 연결
      components/              # UI 기본 컴포넌트
      lib/                     # API client 설정 등 웹 내부 보조 코드
  api/
    Dockerfile                 # Phase 1부터 검증할 API 실행 이미지
    src/
      main.ts                  # HTTP 서버 시작·종료
      app.module.ts            # 기능 모듈과 공통 HTTP 처리 조립
      auth/                    # Google·JWT Strategy/Guard와 인증 HTTP 처리
      materials/               # 자료 controller와 요청·응답 DTO
      search/                  # 검색 controller와 요청·응답 DTO
      answers/                 # 답변 controller와 요청·응답 DTO
      health/                  # 프로세스·필수 DB·선택 기능 상태 확인
      common/
        decorators/            # 인증·응답 등 실제 재사용하는 HTTP metadata
        filters/               # 공통 오류 응답 변환
        interceptors/          # 성공 응답 envelope 적용
  worker/
    Dockerfile                 # Phase 2부터 검증할 worker 실행 이미지
    src/
      main.ts                  # worker 프로세스 시작·종료
      worker.module.ts         # worker 전용 consumer·scheduler 조립
      processors/              # BullMQ 작업 수신과 backend 서비스 호출
      schedulers/              # 복구·보존 작업의 실행 시점 연결
packages/
  api-client/                  # 보존한 OpenAPI에서 생성한 client·type
  backend/
    drizzle.config.ts          # feature schema 수집과 SQL migration 경로
    src/
      index.ts                 # 앱이 사용하는 공개 Module·Service·계약 진입점
      identity/                # owner와 JWT 발급·refresh 상태
      materials/               # 자료·revision·chunk·keyword 저장
      indexing/                # 임베딩 작업·lease·재시도·게시
      search/                  # 검색 계획·랭킹·결과 조합
      answers/                 # 근거 답변 생성·검증·게시
      usage-retention/         # 동의·예산·사용량·보존 규칙
      infrastructure/
        database/
          database.module.ts   # 내부 singleton DB 주입과 Pool 종료 연결
          database.provider.ts # pg.Pool·Drizzle factory와 주입 token
          migrations/          # 검토해서 순서대로 적용하는 단일 SQL migration stream
        queue/                 # 큐 연결·전달 기계장치
        ai/                    # 외부 AI 호출 adapter
        observability/         # 로그·trace 정제와 관측 연결
```

workspace package 사이의 **최종 완전한 허용 DAG**는 아래 세 edge뿐이다. 화살표는 compile/runtime import 방향이다. 구현 중간 phase에서는 실제 존재하는 node와 edge가 이 graph의 부분집합이어야 하며, 해당 node가 도입된 뒤에만 그 edge의 존재를 요구한다.

```text
apps/web    ──> packages/api-client
apps/api    ──> packages/backend (root public exports only)
apps/worker ──> packages/backend (root public exports only)
```

`packages/api-client`와 `packages/backend` 사이에는 edge가 없다. `apps/web`은 backend runtime, database type 또는 backend DTO를 import하지 않고 생성 client를 통해 HTTP만 호출한다. `apps/api`와 `apps/worker`는 서로 또는 `apps/web`을 import하지 않는다. 앱은 transport, dependency composition, process lifecycle만 소유하며 도메인 규칙이나 schema를 소유하지 않는다.

`packages/backend` 내부의 여섯 feature owner와 허용 public-port edge는 [ADR-0002](0002-modular-monolith-domain-ownership.md)가 단독으로 정의한다. feature는 Module·Service·Repository를 책임에 맞게 배치하는 간단한 계층형 구조를 사용하며 모든 기능에 Clean/Hexagonal 계층이나 UseCase·interface를 강제하지 않는다. 앱이 사용할 Nest Module과 명명된 업무 메서드를 가진 Service, 입력·결과·error type을 root에서 공개할 수 있다. 여기서 public port는 그 명시적인 업무 API를 뜻하며 별도 interface 또는 command class의 존재를 뜻하지 않는다. Repository, Drizzle table/relation schema와 추론한 row type, DB Module/provider/token, 내부 adapter는 공개하지 않는다. API와 backend가 같은 설정으로 로그를 남기도록 한 번 설정한 Pino logger 인스턴스는 root에서 공유할 수 있다. 이 작은 공유를 위해 wrapper·별도 observability package를 만들거나 DB/queue/provider handle의 공개까지 확대하지 않는다.

infrastructure는 Drizzle/pg, queue, provider, telemetry의 정책 없는 기계장치를 제공한다. 같은 feature의 Service가 자기 Repository 또는 주입받은 Drizzle DB로 자기 소유 table을 직접 조회·저장하는 것은 허용하되, 다른 feature의 table이나 private 구현에 접근하지 않는다. 각 feature Module은 내부 `DatabaseModule`을 import하며, token 기반 factory provider가 API/worker 프로세스마다 하나의 bounded `pg.Pool`과 Drizzle 인스턴스를 만든다. 이 모듈은 연결·주입·종료 lifecycle만 관리하고 CRUD를 다시 감싸는 범용 DB Service나 request-scoped Pool은 만들지 않는다. 앱 종료 시 Pool을 닫는 lifecycle은 ADR-0003을 따른다. controller나 worker processor가 별도 Pool/DB를 만들거나 DB Module·token·DB/Repository handle을 backend root에서 공개하지 않는다. 외부 AI처럼 실패를 격리하고 fake provider로 검증해야 하는 구간에는 좁은 호출 계약을 둔다. 라이브러리를 바꿀 가상의 가능성만으로 모든 접근에 interface·adapter 쌍을 만들지 않는다.

기능 내부 예시는 다음과 같다. 실제 책임이 없는 파일은 만들지 않으며, 작은 기능의 직접 Drizzle 사용 여부는 ADR-0002를 따른다.

```text
materials/
  materials.module.ts          # 주입 구성과 공개 Service 지정
  materials.service.ts         # 저장·수정 흐름과 transaction 소유
  materials.repository.ts      # 해당 기능 소유 table의 Drizzle 조회·저장
  materials.schema.ts          # 해당 기능이 소유하는 table·relation 정의
  materials.policy.ts          # 필요할 때만 순수 판정 규칙 분리
```

table·relation은 각 feature의 private `*.schema.ts`에 선언한다. `packages/backend/drizzle.config.ts`는 실제로 도입된 feature schema를 수집하고 SQL migration·metadata는 `packages/backend/src/infrastructure/database/migrations`의 단일 ordered stream으로 관리한다. 이 수집은 Drizzle Kit의 DDL 생성용 metadata이며 feature 간 조회·쓰기 권한을 합치지 않는다. Drizzle schema·추론한 row type은 HTTP 요청·응답 DTO나 frontend 공유 타입으로 사용하지 않는다. 상세 schema 수집·migration·검색 SQL 규칙은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)을 따른다.

공개 backend Module을 API가 import했다는 이유만으로 BullMQ consumer나 scheduler가 시작되어서는 안 된다. consumer·scheduler의 등록과 실행 수명주기는 `apps/worker`에만 둔다. backend는 처리 규칙·명시적으로 호출하는 작업 메서드를 제공하고 API는 필요한 producer 기능만 사용한다. 공유 module의 초기화에서 Redis 또는 외부 AI의 준비를 전체 API 기동 조건으로 만들지 않는다.

다음 edge와 우회는 금지한다.

- 어떤 workspace package의 private path 또는 `src/**` deep import
- frontend에서 backend runtime/schema import 또는 backend에서 frontend/api-client import
- 앱 사이 import, feature dependency cycle, infrastructure에서 feature로 향하는 runtime 정책 의존; outbound 계약 구현에 필요한 `import type`은 ADR-0002의 제한을 따른다
- 다른 feature의 repository/table schema 접근 또는 DB/pool/query-builder/repository handle을 public port로 노출
- package export map을 상대 경로·path alias로 우회
- 두 실제 caller와 독립 계약이 없는 `shared`, `common`, `config`, `test-support` package
- 범용 workflow engine이나 모든 module을 우회하는 coordinator

OpenAPI 문서는 API 계약의 생성 원본이고 `packages/api-client`는 그 결과물이다. backend 내부 type을 client 계약으로 재사용하지 않는다. 새로운 package나 edge는 실제 요구, owner, 허용 방향과 architecture 검증을 먼저 문서화한 뒤 추가한다.

`apps`는 독립 실행 진입점이고 `packages`는 독립된 라이브러리 또는 계약 경계다. package를 반드시 frontend와 backend가 함께 사용해야 하는 것은 아니다. `api-client`는 웹 하나가 사용해도 생성 HTTP 계약을 분리하기 위해 존재한다. 두 caller 조건은 목적 없는 추가 공용 package 승격을 막는 기준이며 위 다섯 workspace node를 부정하지 않는다.

### 로컬 개발 실행 구성

일상 개발의 외부 의존성은 루트 `docker-compose.yml`의 **Docker Compose**로 실행한다. Next.js web, NestJS API와 worker는 호스트에서 Turbo가 실제 pnpm 개발 script를 실행하게 해 코드 변경 반영과 디버깅을 쉽게 한다. 별도 개발용 오케스트레이터나 소스 bind mount 기반의 앱 컨테이너 개발 환경은 만들지 않는다.

파일명은 `docker-compose.yml`을 사용하되 CLI는 현재 Docker Compose plugin의 `docker compose`를 기준으로 한다. 파일명 선택이 legacy `docker-compose` 실행 파일 사용을 뜻하지 않으며 구체 명령은 구현된 설정에 맞춰 기록한다.

- 호스트 개발의 기본 주소는 web `http://127.0.0.1:3000`, API `http://127.0.0.1:8000`이다. web의 dev/start script와 API의 기본 listen port·환경 예시를 맞춘다. Phase 0의 로그인 진입 화면은 API를 호출하지 않으므로 `API_URL` 같은 미사용 통신 설정을 요구하지 않는다. Phase 1에서 실제 제품 API를 연결할 때 호출·프록시 설정을 함께 맞추며, 브라우저에는 same-origin HTTPS·cookie 계약을 제공한다. 로컬 내부 API 주소를 브라우저에 공개하는 근거로 사용하지 않는다.
- 일상 개발의 기본 의존성은 Phase 0·1부터 pgvector를 지원하는 PostgreSQL 컨테이너다. 이미지 지원과 벡터 기능 사용은 구분하며, vector column·차원·의미 검색은 Phase 2의 AI 도입 gate 뒤에만 추가한다. Phase 2에서 Redis 서비스를 추가하고, 그때 도입하는 worker도 호스트에서 실행한다. Phase 1부터의 선택 `app` profile은 아래 이미지 검증 구성으로 구분한다. Redis나 worker 없이 첫 저장·keyword 검색·읽기 여정이 동작해야 한다.
- 이미지의 PostgreSQL·pgvector·Redis 버전은 해당 도입 단계에 호환성을 확인해 고정한다. 개발용 공개 포트는 loopback에만 바인딩하고 운영 credential을 사용하지 않는다. 앱의 연결 설정은 호스트에 공개된 주소·포트를 사용한다.
- PostgreSQL 개발 데이터는 named volume으로 유지한다. 일반적인 중지·재시작과 volume 삭제·DB 초기화를 구분하고 개발 데이터를 자동으로 지우지 않는다. healthcheck와 실제 연결로 필수 PostgreSQL의 준비 상태를 확인한다. Phase 2 이후에도 Redis 전체 성공을 API 기동 조건으로 묶지 않으며, Redis 장애는 큐 기능만 저하시키고 저장·keyword 검색·읽기는 유지한다.
- Compose 실행을 schema 적용으로 간주하지 않는다. 검토된 Drizzle Kit SQL migration은 [ADR-0003](0003-postgresql-pgvector-drizzle-revisions-and-search.md)에 따라 명시적으로 적용하며, DB 생성만으로 migration 완료를 주장하거나 앱 시작 시 자동 적용하지 않는다.
- 자동화된 DB·큐 통합 테스트는 개발 Compose와 별도의 Testcontainers 환경을 사용한다. 격리와 cleanup은 [ADR-0009](0009-verification-observability-and-search-evaluation.md)를 따른다.

### 앱 이미지와 선택적 통합 실행

Docker는 DB 실행뿐 아니라 빌드 산출물과 실행 환경을 검증하는 데도 사용한다. Phase 1에 `apps/web/Dockerfile`·`apps/api/Dockerfile`, Phase 2에 `apps/worker/Dockerfile`을 추가하는 계획으로 한다. 각 Dockerfile은 monorepo root를 build context로 사용하며 필요한 workspace 의존성까지 빌드한다. multi-stage build로 빌드 도구와 runtime 산출물을 분리하고, runtime은 non-root로 실행한다. root `.dockerignore`로 실제 secret·환경 파일·불필요한 산출물을 제외하며 build argument·image layer에 credential을 넣지 않는다.

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
| HTTP/OIDC adapter | `apps/api` | backend public port 호출과 protocol mapping |
| queue/scheduler adapter | `apps/worker` | backend public port 호출과 process lifecycle |
| API client | `packages/api-client` | OpenAPI 생성 client/type, JWT cookie 인증·재발급 transport option |
| 도메인 규칙과 상태 전이 | `packages/backend`의 각 feature | ADR-0002의 단일 owner와 public port |
| DB/queue/AI/관측 기계장치 | `packages/backend/src/infrastructure` | policy-free adapter |

## Consequences

- API와 worker가 규칙을 복제하지 않고 같은 backend public port를 사용한다.
- 웹과 backend 배포를 분리해도 compile-time coupling이 생기지 않는다.
- export map과 DAG 검증을 유지해야 하며, 작은 기능도 편의를 위한 deep import를 허용할 수 없다.
- 추가 공용 workspace package를 만들기 전 독립 계약과 두 caller를 입증하므로 초기에는 다소 긴 로컬 경로를 감수한다. 생성 HTTP 계약인 `api-client`에는 두 caller를 요구하지 않는다.
- 익숙한 Nest Module/Service 조립을 사용하되 공개 업무 메서드와 private 저장소의 경계를 검사해야 한다.
- Turbo와 Docker 설정은 실제 작업·이미지 산출물에 맞춰 유지한다. 로컬 cache와 이미지 smoke 성공은 상태 기반 정합성 검증이나 배포 승인을 뜻하지 않는다.
- 실행 단위는 셋이지만 제품과 데이터 모델은 모듈러 모놀리스 하나이며 분산 transaction을 주장하지 않는다.

## Verification

- phase-aware architecture test가 현재 존재하는 workspace node·edge를 열거해 위 graph의 부분집합이고 cycle이 0건인지 검사한다. 최종 목표 구조가 모두 도입된 phase에서만 위 세 edge와 정확히 일치해야 한다.
- export-map test가 앱의 deep import, web→backend, backend→api-client/frontend, 앱 간 import를 거부한다.
- backend boundary test가 Repository·Drizzle schema/row type·DB Module/provider/token·concrete adapter의 root public export와 feature-private import를 거부한다. 위에서 허용한 설정된 Pino logger 공유는 저장소·네트워크 handle 공개와 구분한다.
- 공개 Nest Module/Service가 선언한 업무 API로만 협력하고, API bootstrap에서 worker consumer/scheduler가 등록되지 않는지 확인한다.
- OpenAPI generation check가 `packages/api-client`가 backend runtime 없이 typecheck 가능한지 확인한다.
- 구현 승인 후 해당 phase의 Turbo task가 실제 package script와 일치하고, 상태 기반 통합 검사·migration이 cache hit로 생략되지 않는지 확인한다.
- DB 연결이나 실제 secret 없이 backend/app build가 동작하고, migration 생성·적용이 그 과정에 포함되지 않는지 확인한다. API와 worker 각각 Pool/Drizzle 인스턴스가 하나이며 transport가 별도 Pool/DB를 직접 생성·사용하지 않고 종료 시 Pool이 닫히는지도 검증한다.
- 해당 phase의 Compose 구성·healthcheck·loopback 포트와 호스트 앱 연결을 확인한다. 일반 재시작 뒤 개발 데이터가 유지되고, 테스트 환경의 정리가 개발 volume에 영향을 주지 않아야 한다.
- 앱 이미지 도입 후 non-root runtime, secret 미포함, root context workspace build와 선택적 `app` profile의 same-origin 여정을 검증한다. Redis가 없는 조건에서도 API bootstrap과 core 여정을 확인하며, 결과는 host/Testcontainers 검증과 구분해 기록한다.
- 문서 검증은 이 ADR의 workspace DAG와 ADR-0002의 여섯 owner graph를 별도로 비교하고 모든 링크가 final ADR path를 가리키는지 확인한다.

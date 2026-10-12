# Phase 2 — 0~1단계: 경계와 claim 실행 경로

상태: 0~1단계 구현·검증 기록. 아래 미구현 목록은 당시 기준이다. 이후 [2단계](2026-09-22-phase2-activation.md)와 [3단계](2026-09-22-phase2-recovery.md)를 별도로 진행한다. 최신 상태와 승인 범위는 [plan](../plan.md#현재-상태)을 따른다.

## 범위

사용자 승인 범위는 DB 공유·실제 Redis/BullMQ 전달·worker의 PostgreSQL claim까지다. 외부 AI 호출, 사용자 작업 활성화 API, 동의·예산, vector schema·게시, 자동 재시도/repair는 후속 slice다. 개발 DB migration·실제 env 열람·commit/push는 하지 않는다.

## 0단계 결정

- 임베딩 입력은 기존 immutable chunk의 본문 text다. 제목·메모·맥락·출처는 keyword 검색에 유지하고 embedding 입력에는 넣지 않는다. 현행 줄바꿈 정규화·UTF-16 chunk 구성을 입력 처리 버전으로 식별한다. provider 입력 재사용은 chunk text와 입력 처리 버전, 승인된 provider/model/version/dimension 조합이 같을 때 같은 owner의 유효한 결과에 한해 후속 단계에서 구현한다.
- work는 revision/config/consent/generation 단위다. 한 revision의 chunk 처리를 조율하고 완전히 준비된 revision만 게시한다. 개별 provider 호출의 비용 노출과 attempt는 후속 단계에서 따로 기록한다. 이번 claim은 provider attempt를 증가시키지 않는다.
- 전체 DDL·기존 migration 이력·Kit 설정·연결 팩토리는 `packages/db`가 소유한다. 연결 풀은 API와 worker 각각 생성한다. Nest Module·로그 정책·업무 Repository는 db 패키지로 옮기지 않는다.
- `packages/queue`는 큐 이름·job 이름·work ID payload만 소유한다. API의 indexing은 producer, worker의 indexing은 claim SQL을 소유한다. 같은 기능 소유권 안에서 서로 다른 경로이며 private 앱 소스를 서로 import하지 않는다. 실제 공유 업무 규칙이 생기기 전에는 공용 backend/indexing 패키지를 만들지 않는다.
- worker가 다음 단계에서 자료 fence/chunk 조회를 필요로 할 때 해당 materials 공개 협력 코드만 함께 추출한다. 공유 schema를 이유로 worker의 indexing이 materials 테이블을 직접 조회하는 예외는 만들지 않는다.
- 동의·예약·work 생성이 함께 쓰이는 2단계에는 동일 PostgreSQL scoped transaction으로 묶는다. DB handle을 공개 port에 노출하거나 메서드마다 별도 commit하지 않는다. 구체적인 전파 구현은 첫 다중 저장 작업에서 고르며 이번에는 CLS를 설치하지 않는다.
- ADR-0002의 업무 DAG에 `indexing → usage-retention`, `search → usage-retention`을 명시한다. 1단계에는 아직 해당 모듈을 생성하지 않는다.

## 1단계 실행 경계

큐의 `claim-embedding-work` 메시지는 임베딩 실행 완료가 아니라 **claim 전달**이다. 저장된 work ID만 받으며 PostgreSQL 조건부 갱신으로 `PENDING → LEASED`, DB clock 만료 시각과 새 lease token을 확정한다. 재전달은 유효한 lease를 덮지 않는다. 큐 결과에는 token·원문·사용자 정보가 없다.

이번 단계의 claim 전달 완료를 `PUBLISHED`나 AI 성공으로 반환하지 않는다. 동의·설정·예산 admission과 실행 processor가 아직 없으므로 제품의 work 생성 경로와 자동 enqueue는 열지 않는다. 실제 DB/Redis 테스트만 격리 fixture로 이미 commit된 작업을 만든다. 임의 work 삽입용 API·CLI·환경 우회 옵션은 만들지 않는다.

LEASED 이후 호출·게시·만료 복구는 아직 연결되지 않는다. 따라서 이 중간 상태를 운영 가능한 임베딩 worker라고 소개하지 않는다. 전체 임베딩 실행 job의 성공 ack는 ADR-0004대로 publication 이후에만 허용하며 후속 구현에서 claim 전달과 실행 완료의 관계를 다시 연결한다.

## 구현·검증 순서

1. 기존 SQL·snapshot·journal의 바이트를 보존해 DB 패키지로 이동하고 기존 API·테스트·Docker 경로를 연결한다.
2. 작업 schema와 새 migration을 별도 추가한다. 기존 migration은 변경하지 않는다.
3. API의 lazy producer와 worker-only consumer·claim 저장소를 연결한다.
4. 실제 PostgreSQL·Redis에서 전달·중복/동시 claim·만료/없는 작업·Redis 장애를 검증한다. API 기동·자료 저장·keyword·읽기는 계속 통과해야 한다.
5. build/typecheck/lint·OpenAPI drift·기존 회귀와 이미지 검증을 실행하고 실제 결과를 기록한다.

## 미구현 후속 단계

2. 동의·예산·사용자 활성화
3. retry·lease 만료·repair·철회/삭제 fence
4. provider 승인·vector schema·fenced publication·chunk 결과 재사용
5. query embedding·hybrid 검색·기존 화면 연결
6. 삭제/철회 정리와 Phase 2 종료 검증

## 0~1단계 리뷰 보완 — 2026-09-22

- worker에도 API와 같은 Pino `LOG_LEVEL` 검증·적용과 민감 필드 제거를 적용했다. 앱별 인스턴스를 유지하며 새 로그 패키지나 wrapper는 만들지 않았다.
- API DB provider는 검증된 `databaseUrl`을 ConfigService로 주입받는다. worker 기동 실패도 잘못된 설정 키만 안내한다. 두 앱의 DB URL은 형식 검증을 통과한 뒤 DB 이름을 검사해 검증 중 `new URL()`이 원본 입력을 담은 예외를 던지지 않게 했다.
- DB 전달 가능 여부 조회와 큐 전달의 실패 메시지를 구분했다. 두 실패 모두 durable work를 변경하지 않고 `false`를 반환하는 기존 계약은 유지한다.
- skill 원본은 `.agents/skills`에 유지하고 `.claude/skills`에 skill별 상대 심볼릭 링크를 추가했다. 파일 연결 검증과 Claude Code의 실제 세션 내 발견·자동 선택은 별개다.
- 다음 구현은 2단계 동의·예산·명시적 활성화와 work 생성이다. transaction rollback 시 work·전달 0건, commit 뒤 Redis 전달, Redis 장애 시 committed work 보존을 검증한다. commit 직후 전달 전 종료에 대한 repair는 3단계에 연결하며 그 전에는 전체 복구 완료로 주장하지 않는다. 이번 보완에 활성화 API·provider 호출·자동 repair는 포함하지 않았다.
- 검증: 기존 빌드에서 worker 로그·설정 실패 5건을 재현한 뒤 `pnpm build:backend`와 `pnpm exec vitest run tests/logging.test.ts tests/configuration.test.ts tests/worker.integration.test.ts tests/database.integration.test.ts`로 수정 후 39개 통과를 확인했다. `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`, `git diff --check`도 통과했다. sandbox 내 pnpm의 registry 서명 확인이 네트워크 제한으로 실패해 승인된 sandbox 밖 실행으로 검증했다.
- skill 링크 2개가 원본과 같은 파일을 가리키고 로컬 참조 10개가 존재함을 확인했다. Claude Code의 실제 새 세션 skill 목록·자동 선택 및 변경한 AGENTS 로딩은 미검증이다. 화면·HTTP 계약·이미지는 변경하지 않아 브라우저·HTTPS 이미지·OpenAPI 전체 검사는 재실행하지 않았다. 개발 DB·실제 env·외부 AI·commit/push는 건드리지 않았다.

## 구현과 검증 결과 — 2026-09-21

- 공유 패키지는 Nest 없이 CJS·declaration으로 빌드하고 앱별 Pool 수명주기는 각 Nest DatabaseModule에 남겼다. 비어 있던 Phase 0 baseline schema 진입점은 제거했다. 기존 API의 저장·검색 SQL과 HTTP 계약은 바꾸지 않았다.
- 기존 SQL·snapshot 20개를 Git 원본과 바이트 단위로 대조했다. 이동 과정의 EOF 줄바꿈만 원래 형식으로 복원했고 journal의 이전 항목·순서는 그대로다. `0010`의 새 work table과 관련 제약만 추가했다. `pnpm db:generate` 재실행은 추가 schema 변경 없음으로 끝났다.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`: 통과. build와 lint를 동시에 실행해 dist 재생성 중 발생한 unresolved import는 빌드 완료 후 재검사해 해소했다. 새 통합 테스트의 strict null 검사도 수정 후 전체 typecheck로 확인했다.
- `pnpm test`: 66개 통과. `pnpm test:integration`: 기존 88개와 새 worker 검사 6개, 총 94개 통과.
- 새 검사는 실제 Redis/BullMQ 전달·API consumer 미등록·owner 조건·중복 job/claim·두 DB 연결의 row-lock 경쟁·미래 예약/terminal/만료 lease 거부·FK/active unique·DB 오류 원문 비노출·Redis 중단 중 core 유지와 Redis가 없는 시작을 확인한다. 자료 저장은 work를 자동 생성하지 않는다. DB 장애 테스트의 PENDING은 보존되며 자동 repair 완료로 해석하지 않는다.
- `pnpm test:browser`: 기존 로그인·자료·검색·접근성 여정 42개 통과. 프론트 화면·생성 SDK 기능 변경은 없다.
- `pnpm test:images`: 최종 migration 이력을 포함한 API·웹·worker·migration 이미지를 빌드해 HTTPS 여정 1개 통과(약 1.5분). worker non-root 기동, Redis 중단 뒤 core 기능, 앱/DB 재시작·장애 복구를 확인했다. idle 이미지 기동을 provider 실행이나 lease 복구 검증으로 대신하지 않는다.
- `pnpm openapi:check`: API 명세·생성 SDK drift 없음. 공개 문서 상대 링크 대상 확인과 `git diff --check` 통과.
- 개발 DB migration·실제 Google 계정·실제 AI·Redis 복구/lease 재획득·provider publication·검색 품질 평가는 이번에 실행하지 않았다. 자동 검사는 격리 DB/Redis와 Google fixture만 사용한다. `AGENTS.md`를 갱신했지만 새 Codex/Claude 세션의 지침 로딩은 검증하지 않았다. commit/push는 하지 않았고 개인용 `docs/code-and-data-guide.md`는 ignored 상태를 유지했다.

참고한 연결 계약: [BullMQ connections](https://docs.bullmq.io/guide/connections), [job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [worker 종료](https://docs.bullmq.io/guide/workers/graceful-shutdown). 전체 실행·복구 보장은 후속 단계의 실제 장애 검증으로 판단한다.

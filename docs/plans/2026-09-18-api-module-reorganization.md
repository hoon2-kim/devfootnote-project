# API 기능 모듈 개편

## 승인 범위

API·backend에 나뉜 기능을 `apps/api/src/modules`로 통합한다. auth/search/health는 기본 레이어드, materials는 순수 규칙·업무 서비스·저장 port·Drizzle 구현·HTTP 경계를 구분한다. 기능별 공개 진입점과 자동 의존성 검사를 적용하고 응답 envelope 선언을 통일한다. OpenAPI 생성 SDK·인증·자료 API·SQL 동작은 유지한다.

기준: ADR-0001/0002/0003/0007/0009. 기존 migration SQL·snapshot·journal 내용은 변경하지 않고 단일 이력 전체를 `apps/api/drizzle`로 이동한다. 개발 DB migration, Git commit/push, worker·AI·cloud 실행은 범위 밖이다.

## 순서와 검증

1. 기존 변경을 보존하고 현재 빌드·단위/HTTP 검사를 실행한다.
2. 소스·migration·실행 스크립트 이동과 import·manifest·Docker 경로를 변경한다.
3. materials 저장 계약, 공개 index, 공통 응답 선언과 의존성 검사를 정리한다.
4. 테스트를 새 경로에 연결하고 source unit discovery를 분리한다. DB·HTTP 통합은 실제 격리 PostgreSQL로 검증한다.
5. OpenAPI·생성 SDK·문서·CI를 맞추고 build/typecheck/lint/test/integration/browser 및 이미지 빌드를 확인한다.

완료 기준은 공개 HTTP 계약 보존, migration 내용 동일, owner/current/deleted·CAS·전체 rollback 유지, 금지 import 검사다. 조회 성능은 패키지 배치로 보장하지 않으며 측정하지 않은 결과를 주장하지 않는다.

## 후속 worker 원칙

worker 도입 시 전체 DB schema·migration·생성 설정·연결 팩토리를 `packages/db` 한 곳으로 이동한다. pool은 프로세스마다 별도로 생성/종료하고 migration 실행 주체는 하나다. job 계약은 실제 두 consumer가 생길 때 공유하고 업무 규칙은 복사하지 않는다. API가 생성한 immutable chunk를 worker가 임의 재생성하지 않는다. CLS·추가 공유 업무 패키지는 실제 협력 범위를 확인한 뒤 선택한다.

## 실행 결과

- API 전용 backend를 기능 모듈로 통합했다. auth/search/health 레이어드·materials 저장 포트와 순수 domain·공개 index를 구성했다.
- 인증도 ApiEnvelope를 사용하도록 통일하고 OpenAPI/SDK를 재생성했다. 실제 성공/오류·204·redirect HTTP 계약은 유지한다.
- 테스트는 위험 중심으로 정리했다. 개편 전 비통합 77개 → 정리 후 42개. 제거/축소 사유와 대체 검증·잔여 한계는 ADR-0009에 기록했다. 핵심 DB·HTTP 테스트를 실패 은폐 목적으로 삭제하지 않았다.
- source unit은 본문 규칙만 소스 옆에 두고 Nest 통합은 dist를 읽는다. 추가하려던 SWC 변환 의존성은 현재 필요 없어 제거했다. Vitest가 빌드 CJS를 재변환하지 않게 해 동일 DI token/logger 인스턴스를 사용한다.
- 루트 build/typecheck/lint(의존 경계 포함)·openapi:check 통과. dependency-cruiser 167개 모듈·444개 의존에 위반 0건. 생성 SDK 내부 type-only 순환은 생성기 소유로 두고 수동 패치하지 않는다.
- 단위·HTTP 42개, 실제 PostgreSQL 통합 63개, Playwright 21개 통과. 통합 테스트는 개발 DB가 아닌 Testcontainers에서 실행했다.
- migration SQL·snapshot·journal 15개는 이동 전 SHA-256과 모두 일치한다. apply_patch 이동 과정의 EOF 줄바꿈 차이도 원래 바이트로 복원했다. 개발 DB migrate/seed/reset은 실행하지 않았다.
- API runtime Docker 이미지 `devfootnote-api:refactor-check` 빌드 및 이미지 내 AppModule 로딩·uid=1000 확인. 임시 컨테이너는 종료 후 자동 제거했다. 이 검사는 운영 HTTPS·전체 image journey 검증이나 배포 완료를 뜻하지 않는다.
- 이전 위치의 빈 소스 디렉터리 22개를 rmdir로 정리했다. 파일이 남은 ignored dist/node_modules·로컬 evidence·사용자 환경 파일은 지우지 않았다.
- NODE_ENV는 기존 dev/start 실행 명령이 development/production으로 설정한다. 실제 env 파일은 읽거나 변경하지 않았고 README/AGENTS에 파일 선택·주입 우선순위·Next 빌드 예외를 명시했다.
- README·spec·plan·ADR-0001/2/3/5/7/9·기획·AGENTS를 현재 경계와 테스트 정책에 맞췄다. 문서 17개에서 로컬 링크 119개의 파일 대상 존재를 확인했다. CLAUDE.md는 AGENTS import 진입점으로 유지했다. 새 세션의 지침 자동 로딩은 확인하지 않았다.

개편 시점에는 HTTPS·수정/삭제/검색의 브라우저 여정·이미지 통합 smoke/CI gate가 남아 있었다. 이후 같은 날 Phase 1 마무리 작업에서 격리 HTTPS 이미지 여정과 브라우저 검증을 완료했다. 최신 범위·결과는 [plan의 Phase 1 완료 기록](../plan.md#phase-1--로그인부터-저장keyword-검색읽기까지)을 따른다. Git commit/push·worker·AI·cloud 작업은 하지 않았다.

# Phase 2 — 3단계: attempt·재시도·lease 복구

## 승인 범위

현재 work에 호출 시작 기록, 재시도·최종 실패, lease 만료 복구와 수정·삭제·철회 fence를 연결한다. 실제 provider, vector schema·publication, 의미 검색 UI와 명시적 terminal 재시도 API는 다음 slice에 남긴다. 제품 AI 설정은 미설정 상태를 유지한다. 개발 DB·실제 환경 파일·클라우드·Git 변경은 포함하지 않는다.

## 책임과 구현 순서

- ADR-0001/0002에 따라 worker의 indexing이 실행 상태와 복구를 소유한다. worker materials는 현재 intent fence, usage-retention은 동의·예약 유효성과 노출·만료를 공개 Service로 제공한다. API의 CRUD/admission 구현과 다른 작업이므로 전체 backend를 공용 패키지로 옮기지 않는다.
- 기존 CLS Drizzle 구성을 worker에도 사용하되 `worker` 이름으로 API transaction과 구분한다. work의 미잠금 snapshot을 읽은 뒤 consent → material → budget → reservation → work 순서로 잠그고, 같은 transaction에서 attempt와 예약 노출을 기록한다. API의 새 예약과 worker 노출 기록이 같은 budget 행에서 조정된다. 외부 호출·Redis I/O는 commit 뒤다.
- 새 migration은 work의 attempt 수·정제 실패·repair 순회 시각, content-free attempt와 예약 노출 시각만 추가한다. 과거 migration은 변경하지 않는다.
- 호출 전 LEASED 만료는 attempt 증가 없이 회수하고, CALLING 만료는 결과 불명 기록을 남긴다. 재시도는 ADR-0004의 5회 상한과 DB 시각을 따른다. terminal work와 과거 lease 결과는 되살리지 않는다.
- 한 예약을 여러 work가 공유한다. 개별 work 실패로 전체 예약을 해제하지 않으며 호출 노출이 있으면 만료 뒤에도 예산에서 제외하지 않는다. 실제 금액·보수 정산은 provider 정책 승인 뒤에 연결한다.
- repair는 짧은 SKIP LOCKED batch 점유를 commit하고 owner fence·재전달을 수행한다. 보존된 BullMQ completed/failed job은 라이브러리의 원자적 retry로 재전달하며 active job은 지우지 않는다. 개별 work의 DB 오류는 격리하고 Redis 장애는 회차를 중단한다. timer와 consumer는 worker만 소유한다.
- provider 없는 단계이므로 제품 consumer는 claim 전달을 유지한다. 실행 상태 메서드는 테스트의 fake caller로 검증하고 가짜 성공 provider나 PUBLISHED 전이를 제품에 넣지 않는다.

## 수용 기준과 검증

기준은 spec AC-05/07/08의 이번 단계 subset과 ADR-0003/0004/0008/0009다.

- 실제 PostgreSQL에서 start attempt·예약 노출 all-or-none, duplicate·wrong token·late 결과 거부, retry 상한·미래 시각 차단과 terminal 비부활을 확인한다.
- 수정·삭제·철회·설정 불일치·예약 만료에서 새 attempt를 막고 호출 중 변경 뒤에도 늦은 결과를 차단한다. 노출 예약은 보존하고 미노출 만료만 정리한다.
- 실제 Redis/BullMQ에서 commit 후 전달 누락, 보존된 완료 job, 큐 데이터 유실과 만료 lease를 복구한다. 두 scanner의 bounded 점유와 별도 DB 연결의 commit 관찰을 확인한다.
- 기존 저장·keyword·읽기, API 기동과 ready는 Redis 장애·미설정에도 유지한다. worker 종료는 제한된 유예와 강제 연결 종료를 구분한다.
- root가 build → 좁은 단위/통합 → 타입·lint·아키텍처 → 영향받는 회귀·이미지 순으로 조율한다. 실제 AI·의미 품질·vector 게시 성공은 이번 검증에 포함하지 않는다.

## 실행 결과

2026-09-30에 기존 구현의 검증을 마무리했다. 이번 실행에서 제품 코드는 추가 변경하지 않았고, 아래 통과는 **provider-free 3단계**의 완료 근거다.

| 실제 실행 | 결과 |
|---|---|
| `pnpm build:backend` | db·queue·API·worker 4개 task 통과. Turbo cache hit이며 새 컴파일 실행으로 표현하지 않음 |
| `pnpm exec vitest run tests/embedding-execution.integration.test.ts tests/embedding-recovery.integration.test.ts` | 33개 통과: 원자 STARTED/노출, retry·lease·fence, retained job·큐 유실·bounded repair |
| `pnpm exec vitest run tests/embedding-activation.integration.test.ts tests/worker.integration.test.ts` | 26개 통과: admission/예산·commit 이후 전달·실제 claim·종료 유예·Redis 장애 격리 |
| `pnpm typecheck` | workspace·web typegen·루트 테스트 타입 통과 |
| `pnpm lint` | ESLint·Prettier·dependency-cruiser 통과, 229개 module·693개 dependency |
| `pnpm test` | 10개 파일, 96개 검사 통과 |
| `pnpm test:integration` | 8개 파일, 150개 검사 통과. 위 좁은 검사를 포함한 합계이며 중복 합산하지 않음 |
| `pnpm test:images` | 1개 통과: API/web/worker/migration 이미지, HTTPS 인증·저장·재시작·DB 복구·Redis 중단 core 유지 |

DB/Redis는 Testcontainers, 이미지는 고유 Compose 프로젝트·임시 볼륨으로 격리했다. 실제 사용자 환경 파일·개발 DB를 읽거나 migration하지 않았으며 실제 AI 호출은 없다. 오류 주입 검사에서 나온 정제된 오류·경고 로그를 정상 서비스 장애로 해석하지 않는다.

브라우저 전체 suite와 검색 benchmark는 이번에 재실행하지 않았다. 이미지 여정 통과는 브라우저 전체 회귀나 worker의 성공 publication 증거가 아니다. 실제 provider·vector publication·비용 정산·terminal 명시 재시도·hybrid UI·파생 자료 retention은 미완료다. 따라서 `AC-05`/`V-06` 전체 또는 Phase 2 전체 완료로 표시하지 않는다.

다음 경계는 [제공자 선정안](2026-09-30-phase2-provider-gate.md)의 모델·비용·보존·평가 기준 승인이다. 승인 전에는 제품 설정의 `null` gate와 claim-only consumer를 유지한다.

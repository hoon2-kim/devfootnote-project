---
name: devfootnote-concurrency-check
description: devfootnote의 DB·큐 동시성 및 원자성 테스트를 작성하거나 검토한다. refresh CAS, 자료 수정·삭제 경쟁, 멱등 receipt, worker claim·lease·fence의 정합성 검증이 요청되거나 구현에 필요할 때 사용한다. 일반 CRUD·DTO·스타일 수정만으로는 적용하지 않는다.
---

# DB·큐 정합성 검증

경쟁 요청의 반환값뿐 아니라 PostgreSQL에 확정된 결과와 남으면 안 되는 부분 저장을 확인한다. 일반 작업·승인 규칙은 [AGENTS.md](../../../AGENTS.md)를 따르고 여기서 다시 정의하지 않는다. 리뷰 요청을 제품·테스트 수정 승인으로 확대하지 않는다.

## 계약과 기존 검사 선택

아래 경로는 저장소 루트 기준이다. 명령은 루트에서 실행하고 상대 링크는 이 파일 기준으로 해석한다. [plan](../../../docs/plan.md)에서 현재 승인된 구현 범위를 먼저 확인한다. 예정된 상태 전이를 이미 구현한 것으로 가정하지 않는다.

- 인증 경쟁: [ADR-0005](../../../docs/adr/0005-google-login-and-sessions.md), `tests/auth.integration.test.ts`, `tests/auth-harness.ts`.
- 자료 저장·멱등성·revision 경쟁: [ADR-0003](../../../docs/adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md), `tests/materials.integration.test.ts`, `tests/material-changes.integration.test.ts`.
- 큐 전달·claim·lease·publication: [ADR-0004](../../../docs/adr/0004-bullmq-embedding-delivery-retry-and-fencing.md), `tests/worker.integration.test.ts`. 동의·비용까지 관련되면 [ADR-0008](../../../docs/adr/0008-ai-provider-consent-budget-grounding-and-retention.md)도 확인한다.
- 격리·실패 주입·검증 정책: [ADR-0009](../../../docs/adr/0009-verification-observability-and-search-evaluation.md). 연결 종료·DB 장애는 `tests/database.integration.test.ts`를 참고한다.

관련 코드와 검사만 읽는다. 경로가 바뀌었으면 `rg --files`로 실제 위치를 찾고 새 하네스를 만들기 전에 기존 구현을 확인한다.

## 검증 절차

1. **승패가 결정되는 지점을 찾는다.** 대상 owner·행·현재 revision·멱등 key·lease token 중 이번 작업에 관련된 조건을 고르고, transaction·UNIQUE·조건부 UPDATE 중 무엇이 경쟁을 판정하는지 확인한다. 기대 결과는 ADR에서 정한다. 같은 멱등 요청은 둘 다 같은 성공 결과를 받을 수도 있으므로 모든 경쟁을 무조건 한 성공·한 실패로 정하지 않는다.
2. **기존 실제 연결 경로를 재사용한다.** 현재 manifest·Vitest 설정을 확인해 API·worker와 의존 패키지를 빌드한다. Nest compiled module의 클래스·DI token을 source import와 섞지 않는다. 실제 commit과 여러 연결의 경쟁은 테스트 바깥 rollback transaction 하나로 감싸지 않는다.
3. **경쟁 지점을 관찰한다.** 독립 DB 연결로 해당 행·테이블의 blocker를 잡고 요청을 시작한다. 대상 작업이 실제 lock 대기에 도달했는지 유한한 대기로 관찰한 뒤 blocker를 푼다. 관찰 쿼리는 해당 테스트의 DB·연결·작업을 식별해야 한다. `Promise.all`, 고정 sleep, worker 객체 개수만으로 경쟁을 증명하지 않는다. 여러 프로세스의 경쟁을 주장하려면 각 프로세스가 참여했다는 근거도 확인한다.
4. **최종 effect를 대조한다.** 응답과 함께 current pointer·본문/삭제 상태·refresh hash 또는 lease token 등 관련 상태를 확인한다. 자료 원자성은 revision·chunk·keyword·intent·receipt의 관계와 패자의 잔여 행을 확인하고 필요한 read/search 노출도 검사한다. 단순 총 행 수 상한만으로 all-or-none을 결론 내리지 않는다. 동일 receipt 재전달은 두 응답보다 실제 효과가 한 번인지를 본다.
5. **실패 경로에서도 다음 검사를 오염시키지 않는다.** barrier 관찰 실패를 보존한 채 blocker 해제 → 시작한 요청 `allSettled` → consumer/app/pool·테스트 자원 정리 순서로 마무리한다. 정리 실패가 다른 정리를 생략하거나 원래 실패를 숨기지 않게 한다. lease expiry는 가능한 DB 시각·통제된 fixture로 다루고, Node fake clock이 PostgreSQL 시각도 바꾼다고 가정하지 않는다.

큐 검사는 Redis 전달 결과와 업무 완료를 나눠 판정한다. claim 메시지 완료만으로 임베딩 게시·복구 성공을 주장하지 않는다. provider 호출·게시·비용 전이가 아직 승인되지 않았다면 해당 검사를 만들기 위해 실행 경로를 추가하지 않는다.

## 실행과 종료

현재 루트 명령을 확인한 뒤 `pnpm build:backend`와 대상 파일의 `pnpm exec vitest run tests/<대상>.integration.test.ts`부터 선택한다. 빌드가 dist를 지우고 재생성하는 동안 이를 읽는 검사·아키텍처 검사를 동시에 실행하지 않는다. 관련 회귀만 넓히고 매 작업 전체 이미지 검사를 강제하지 않는다.

구현 수정이 승인된 버그는 가능한 가장 좁은 재현 실패 → 수정 → 통과를 확인한다. Docker·fixture·권한 때문에 실행할 수 없으면 정적 판단과 미검증을 구분하며 mock 성공이나 timeout 확대만으로 대체하지 않는다.

결과에는 검사한 불변식, 실제 관찰한 경쟁 지점, 최종 DB effect, 실행 명령·결과, 미검증 경계를 짧게 남긴다. 승인된 수용 기준이 충족되면 종료하며 범용 barrier framework·추가 재시도 정책으로 확장하지 않는다.

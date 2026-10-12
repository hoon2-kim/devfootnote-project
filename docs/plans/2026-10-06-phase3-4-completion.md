# Phase 2 리뷰 보완과 Phase 3~4 구현

- 상태: 2026-10-07 코드·격리 검증, 실제 답변 소량 smoke와 승인된 제품 설정 활성화 완료. 개발 DB 적용·사용자 수동 확인과 Phase 5 종합 품질 평가는 별도다.
- 범위: 사용자 승인에 따라 리뷰의 확인된 문제를 보완하고 명시적 근거 답변·기존 화면 복구를 연결한다. 배포·개발 DB 적용·Git stage/commit/push는 제외한다.
- 기준: spec AC-06/07/08/10, plan V-07/08/10/12, ADR-0002/0003/0004/0006/0007/0008/0009.

## 확인한 리뷰와 결정

- 월별 예산·가격을 config fingerprint에 포함해 월 변경만으로 동의·벡터를 무효화하는 문제를 재현했다. 벡터 공간·전송 동의 식별자를 별도로 계산하고 두 식별자의 조합을 기존 게시 fence로 사용한다. 예산 기간·가격은 이 조합에 넣지 않고 예약 ledger/snapshot으로 관리한다.
- API·worker의 예산 admission SQL은 usage-retention 전용 공유 함수로 모은다. 두 앱의 예외/null 반환 방식은 transport·업무 흐름의 차이로 유지한다. 예약 기간은 DB 현재 UTC 월로 선택하고 budget 잠금 뒤 시각으로 기간·유효 예약을 검사한다.
- 공유 월 상한은 $0.90, 목적별 상한은 embedding $0.45·grounded-answer $0.45다. **같은 예산 행**에서 전체·목적별 합계를 함께 검사한다. 이전 정책으로 이미 사용한 금액도 남겨 월 중 전환이 총상한을 늘리지 않게 한다. 무료 등급 실제 청구액이 아닌 참고 사용량 상한이다.
- work의 `(owner_id, reservation_id)` 인덱스와 `access_denied` 실패 분류를 추가한다. 인덱스 유무와 지연 측정은 구분하며 측정 전 개선 수치를 주장하지 않는다.
- worker의 lease/fence/실패 분기를 순수 정책으로 분리하고 boolean 위치 인자를 옵션 객체로 바꾼다. DB CHECK·worker 타입·최대 시도 수의 정적 계약을 공유한다.
- 앱별 Pool/CLS composition은 유지한다. `worker` 연결 이름은 같은 프로세스의 API/worker 통합 검사에서 transaction host 충돌을 막는다. 메서드마다 독립 commit 여부가 달라 단순 파일 모양을 맞추려고 모든 transaction을 일괄 변환하지 않는다.
- heartbeat는 기존 승인된 공개 복구 계약·실제 DB 회귀가 있으므로 사용 빈도만으로 제거하지 않는다. provider shape 검증과 publication의 chunk identity/float32 검사도 다른 신뢰 경계라 유지한다.
- `.agents/`와 `.claude/`의 미추적 상태는 확인했지만 이 요청에 stage·commit 승인은 없으므로 Git index를 변경하지 않는다.

## 답변 구현 결정

- 사용자 승인: Gemini 3.5 Flash-Lite 무료 등급, 공개 가능한 질문·근거 본문에 대한 별도 미선택 동의, 답변·인용 7일, 내용 없는 dedupe/비용 기록 90일.
- 첫 실제 호출에는 별도 합성 평가 승인이 필요하다. 구현·fake-provider 검증 중에는 실제 AI를 호출하지 않고 제품 답변 설정은 비활성으로 유지한다.
- 질문은 실행·복구에 필요한 10분 유효 창에만 저장하고 terminal 전이 때 지운다. 답변 근거 snapshot은 ID/hash/locator를 보존하며 원문 사본을 장기 저장하지 않는다.
- API의 요청/snapshot/예약 commit → worker STARTED·노출 commit → transaction 밖 provider → 재검증된 게시·비용 정산 순서를 지킨다.
- 같은 owner/request ID의 응답 유실 재요청은 결과·처리 상태만 반환한다. 다른 입력은 충돌이며 같은 요청을 자동 재호출하지 않는다. 수정·삭제·철회·만료 시 답변 접근을 차단한다.
- 검색 화면에만 질문·동의·답변·인용·상태 복구를 연결한다. 새 기록/settings 화면은 만들지 않는다. Phase 4는 기존 화면의 접근성·오류/재시도·반응형·인증 복구와 함께 검사한다.

## 순서와 검증

1. 정책 회귀 실패 확인, 리뷰 수정과 migration SQL/metadata 검토.
2. API·worker 답변 기능, 생성 OpenAPI/SDK, 검색 화면 연결.
3. 순수 정책 → 실제 PostgreSQL 예산 경쟁·게시/철회/수정/삭제/중복/만료·보존 회귀 → 브라우저·이미지 → 타입/lint/생성물 일치.
4. 실제 provider 품질 평가는 fake-provider 성공과 분리하고 미승인·미실행 gate를 남긴다.

## 실행 기록

- 수정 전 월 경계 단위 회귀 실패를 확인했다. 수정 후 식별자 정책 2개와 worker 순수 정책 18개는 통과했다.
- 중간 빌드는 공유 transaction 타입·동시 작성 중인 export 문제로 실패했고 수정 뒤 backend 5개 task와 전체 타입 검사가 통과했다. 브라우저 첫 실행의 dist 삭제 경합은 빌드/검사 순서를 분리해 해소했다.
- `pnpm exec vitest run --exclude '**/*.integration.test.ts'`: 단위·HTTP 163개 통과. sandbox의 localhost listen 제한으로 실패한 최초 실행과 승인 환경의 재실행을 구분한다.
- DB/queue 통합 12개 파일을 네 묶음으로 실행해 **229개** 통과했다: 예산 7, 답변 17, embedding/semantic/worker 111, auth/database/materials 94. 모두 Testcontainers의 합성 자료이며 사용자 DB를 사용하지 않았다.
- 예산 검사는 실제 row-lock 경쟁, 잠금 후 기간 만료, DB 현재 월 선택, 기존 지출 보존과 전체/목적별 상한을 확인했다. 답변 검사는 STARTED 전 rollback, 중복 요청·worker의 단일 호출/정산, 수정·철회·TTL fence, 내용 정리와 90일 receipt 정리를 확인했다. concurrency skill의 경쟁 지점 관찰·최종 effect·정리 순서를 적용했다.
- provider fake-fetch 29개는 위 단위 163개에 포함된다. 후보 envelope가 잘못되어도 검증 가능한 usage를 보존하고, 게시 허용 여부와 정산을 분리하는 회귀를 추가했다. 실제 Google 응답/품질 증거는 아니다.
- `pnpm test:browser`: 전체 **57개** 통과. 최종 버튼 간격 수정 뒤 답변 7개를 재실행해 통과했고 320/1280px 스크린샷·axe·가로 overflow를 확인했다. 마지막 부분 실행이 browser JSON을 덮어쓰므로 전체 57개 근거는 직전 실행 출력이다. 실패했던 전역 status locator와 visibilitychange trigger는 기대 동작을 유지하면서 범위를 바로잡았다.
- `pnpm test:images`: **1개** 통과. 격리 production 이미지의 HTTPS/Secure cookie/CSRF/refresh, Redis 중단 중 저장, 재시작·DB 장애 복구·로그아웃을 확인했다.
- `pnpm typecheck`: 11개 task 및 테스트 타입 검사 통과. `pnpm lint`: ESLint·포맷 통과, dependency-cruiser **271개 module/917개 의존, 위반 0건**. `pnpm openapi:check`: 명세/SDK drift 없음.
- `pnpm build`: 전체 7개 task 통과(6개 cache, web production build 신규 실행).

## 남은 승인·미실행 범위

### 2026-10-07 실제 답변 소량 평가 승인

사용자는 공개 합성 자료의 실제 답변 평가를 승인했다. `tests/evaluations/answers.mjs`에서 단일 근거·복수 근거·근거 부족 3건만 실행한다. 자동 재시도·대체 모델·제품 설정 활성화는 포함하지 않는다. 동일 모델/정책의 실제 adapter, 격리 PostgreSQL과 공유 예약 SQL을 사용하며 제품 게시 전체 경로 검증이나 Phase 5 동결 품질 평가를 대신하지 않는다.

요청별 최대 참고 비용 $0.01952, 3건 최대 $0.05856이다. 이전 평가의 실제/불명 노출액 $0.0038934도 포함해 평가 상한 $0.10을 넘지 않는지 사전 확인한다. 무료 프로젝트의 실제 청구액이 아니다. `--check`는 합성 반환값으로 예약·정산·실행기를 확인하며 외부 호출은 0건이다. 실제 실행은 배타적 시작 기록으로 재실행을 차단하고 첫 오류에서 멈춘다. 결과 파일에는 case ID·판정·토큰·금액·시간만 기록하고 원문·질문·답변·provider body·키를 쓰지 않는다.

사전 검사: `node tests/evaluations/answers.mjs --check`. 실제 실행: `node scripts/run-env.mjs worker dev tests/evaluations/answers.mjs --gemini-free`. 기존 실행기가 키를 주입하며 환경 파일 내용은 열람·출력하지 않는다. 결과는 실행 후 아래에 기록한다.

#### 실제 결과 — 2026-10-07 KST

- 위 두 명령은 exit 0이었다. 사전 검사는 외부 0-call, 실제 실행은 승인 모델에 정확히 3회 호출했고 자동 재시도·fallback은 없었다. 대상 script ESLint·Prettier와 `git diff --check`도 통과했다.
- 단일 근거 1개 사실, 복수 근거 2개 사실의 숫자·단위와 대응 citation 검사 3/3 통과. 근거 부족 1/1은 `insufficientEvidence=true`, claim 0개였다. JSON schema·출처 allowlist·안전한 텍스트 검사는 실제 adapter를 통과했다.
- 입력 506·출력 195토큰, 참고 정산 합계 **$0.0006393**. 기존 평가 노출액까지 합하면 $0.0045327이며 평가 상한 $0.10 이내다. 이는 표준 단가 환산액이지 Free 프로젝트의 청구액 확인이 아니다.
- 각 호출과 정산을 포함한 관찰 시간은 1,283/1,522/1,120ms다. 표본 3개이므로 percentile·SLO를 주장하지 않는다.
- 고정 합성 자료의 제한된 사실/인용 검사다. 임의 답변의 의미적 근거성·환각률을 전수 판정한 것이 아니며 Phase 5의 20-case 개발/40-case 동결 평가를 대신하지 않는다. 질문·답변·원문·provider body는 출력하거나 결과 파일에 저장하지 않았다.
- 실행기만 추가했고 제품 코드·키·개발 DB·migration 적용·Git index는 변경하지 않았다. API/worker `answerPolicy` 활성화는 이 평가 승인과 구분해 남긴다.

### 남은 범위

- 후속 승인으로 키가 있는 API/worker에 같은 `answerPolicy`를 연결했다. 계정의 화면 동의·명시적 질문·공유 예산 gate는 유지한다. Phase 5의 동결 corpus 종합 품질 평가는 미실행이다.
- migration 0017~0020은 SQL/metadata 생성·검토와 격리 DB forward 검증만 수행했다. 개발 DB 적용과 기존 설치의 한 번 재동의/활성화는 별도다. 최초 fingerprint 전환 때 기존 벡터 정리·재임베딩 가능성을 README/ADR-0008에 명시했다.
- work 예약 조회 인덱스의 실제 운영 지연/EXPLAIN 비교는 측정하지 않았다. 성능 개선 수치를 주장하지 않는다.
- config 객체 통합, API/worker 파일 모양 통일, 기존 heartbeat 제거와 큰 catch/transaction 일괄 정리는 이번에 하지 않았다. 업무 경계·독립 commit·장애 정제 계약을 바꾸는 정리를 기능 검증에 섞지 않았다.
- 기존 구현·격리 검사 때는 실제 AI를 호출하지 않았고 이번 후속 승인에서만 합성 자료 3회를 전송했다. 유료 전환·개발 데이터 변경·Git stage/commit/push·배포는 수행하지 않았다. Phase 5~6은 이번 완료 범위가 아니다.

### 2026-10-07 제품 답변 설정 활성화

- 사용자는 답변 활성화 후 로컬에서 직접 기능을 확인하도록 요청했다. API와 worker의 환경 검증 결과에 동일한 승인 `geminiFreeAnswerPolicy()`를 연결했다. 키가 없거나 빈 값/공백이면 `null`이다. 환경 변수·동의·예산을 우회하는 옵션은 추가하지 않았다.
- 설정 회귀 4개가 변경 전 실패하고 변경 후 통과했다. 이후 설정 전체 12개와 답변 통합 17개, 합계 29개가 통과했다. backend build 5개 task, 대상 ESLint·Prettier와 테스트 타입 검사도 통과했다.
- 기존 답변 화면·API 계약·provider 코드는 변경하지 않아 브라우저·이미지 전체 검사는 재실행하지 않았다. 이번 활성화 작업에서는 실제 AI를 추가 호출하거나 사용자 환경 파일·개발 DB를 변경하지 않았다.
- 로컬 준비는 API·worker 중지 → DB·Redis 실행 → 개발 DB 대상으로 명시적 migration → `pnpm dev` 재시작이다. API·worker 각각의 서버 환경에 Gemini 키가 필요하며 키 값은 공개하지 않는다. 수동 기능 확인 순서는 README에 추가했다.

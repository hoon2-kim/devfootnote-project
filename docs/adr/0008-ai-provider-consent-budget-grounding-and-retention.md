# ADR-0008: AI provider 동의, 예산, grounding과 보존

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-10-01 — Gemini Free 승인·query 정산·90일 상세 정리와 최소 중복 방지 기록
- Updated: 2026-09-22 — embedding STARTED 노출과 만료 예약의 예산 보존
- Canonical owner: 외부 AI 호출 admission, 답변 choreography, 비용 정산, citation과 AI 데이터 보존

## Context

devfootnote의 embedding과 근거 답변은 선택 기능이다. 사용자의 원문과 메모를 외부 provider에 전송할 수 있으므로 명시적 동의와 비용 상한이 선행되어야 한다. network call을 DB transaction 안에서 수행하면 lock과 재시도 위험이 커지고, 반대로 호출 전후의 durable 상태가 없으면 consent 철회, revision 변경, 삭제, timeout과 중복 delivery 사이에서 stale 답변 게시 또는 이중 과금이 생긴다.

자료 저장, 현재 keyword 검색과 원문 읽기는 provider, consent, Redis와 무관하게 동작한다. embedding은 indexing owner의 비동기 기능이며, 이 ADR은 `answers`가 `usage-retention`과 협력하는 답변 workflow 및 두 AI 기능에 공통인 provider/privacy gate를 정한다. provider, model, model version, embedding dimension과 가격은 도입 직전 평가까지 선택하지 않는다.

## Decision Drivers

1. 동의하지 않았거나 예산이 없는 경우 외부 호출을 0건으로 만든다.
2. provider latency 중 DB transaction을 열어 두지 않는다.
3. 현재 owner/revision/evidence에 grounded된 답변만 citation과 함께 게시한다.
4. duplicate, late result, crash와 철회 경쟁에서 게시·정산을 exactly-once 효과로 만든다.
5. content와 provider payload를 telemetry에서 배제하고 보존·삭제를 실행 가능하게 한다.

## Decision

### 기능과 provider 경계

AI는 두 가지 좁은 port만 가진다.

- embedding port: 현재 revision의 승인된 chunk 또는 사용자가 방금 입력한 검색 질의를 벡터로 변환한다. chunk vector publication과 fence는 indexing module이 소유한다. query embedding은 `search`가 owner-scoped query command 안에서 요청하지만 consent·budget admission과 settlement는 `usage-retention` public port를 통과하며 질의 원문은 durable usage나 telemetry에 저장하지 않는다.
- grounded generation port: committed evidence snapshot과 제한된 instruction으로 answer candidate를 반환한다.

2026-09-21 입력 경계 결정: chunk embedding에는 저장된 immutable chunk의 본문 text만 사용한다. 제목·메모·맥락·출처 URL은 keyword 검색에 남기고 이 embedding 입력에는 넣지 않는다. 본문 줄바꿈 정규화와 chunk 구성은 입력 처리 버전으로 식별한다. 결과 재사용은 같은 owner 안에서 chunk text·처리 버전·승인된 provider/model/version/dimension이 모두 일치하고 삭제·철회·config fence를 통과한 결과에만 허용한다. 메타데이터만 수정해도 revision은 보존하되 같은 embedding 입력의 외부 재호출은 줄인다. 0~3단계에서 유예했던 실제 재사용은 4단계에서 같은 material의 현재 본문 전체가 일치하는 범위부터 연결한다.

provider adapter는 domain entity, repository 또는 transaction handle을 받지 않는다. 호출 입력은 최소한의 normalized content, request/model configuration, timeout/cancellation 정보뿐이다. provider가 반환한 자유형 citation이나 URL을 권위로 사용하지 않는다. exact provider/model/version/dimension은 문서 단계에서는 선택하지 않지만 **첫 실제 chunk/query embedding 또는 answer 호출 전에** 품질·privacy·단위 가격 evidence와 별도 승인을 거쳐 고정한다. 승인된 fingerprint, purpose consent와 budget reservation이 없으면 호출은 0건이며 기본 fallback provider를 두지 않는다.

### 동의

외부 전송은 기본 off다. `usage-retention`은 owner별, purpose(`embedding` 또는 `grounded-answer`), policy version, consent epoch, granted/revoked timestamp를 소유한다. UI는 전송 범주·목적·provider를 짧게 알리고 affirmative action을 받는다. 보존·철회 영향은 펼쳐 보는 안내에 제공하며 내부 예산 숫자는 일반 작업 화면에서 노출하지 않는다. bundle consent, pre-checked control과 저장만으로 묵시적 동의를 얻지 않는다.

2026-10-11 사용자 요청으로 별도 동의 checkbox·동의 버튼을 없애고 각 기능의 첫 실행 버튼이 승인을 겸한다. 2026-10-13 후속 승인에서는 `AI 검색 사용하기`가 기존 자료와 이후 새 저장/수정 본문의 자동 준비 및 명시적 검색어 전송을, 자료 상세의 첫 답변 실행이 질문·해당 자료 본문·제한된 이전 대화 전송을 승인한다. 첫 실행 전 “현재 이 서비스는 Gemini API 무료 등급을 사용합니다”로 시작해 전송 범주와 Google의 서비스 개선·사람 검토 가능성, 개인정보·회사 기밀 금지를 짧게 알린다. 검색 방식·처리 흐름은 ⓘ 도움말에 두되 첫 전송 고지를 도움말 안에만 숨기지 않는다. 전체 provider 고지와 보존·철회 설명은 `AI 사용 안내`에서 제공하며 고지 fingerprint를 화면 문구 변경만으로 바꾸지 않는다. 답변 승인은 생성보다 먼저 저장하고 실패하면 생성 POST를 보내지 않는다. 화면 mount·펼치기·URL 복원은 동의/생성 요청을 만들지 않는다. purpose별 동의·epoch fence·사용량 상한·멱등성과 `AI 검색/답변 끄기`의 기존 철회 API는 유지한다.

기존 자료 전체의 자동 준비는 활성화 명령의 `includeExisting=true`로 명시한다. 빈 targets로도 승인할 수 있고 worker가 current revision을 bounded batch로 예약·처리한다. 기존 `includeExisting=false` 활성화에 과거 자료 전송 권한을 소급 부여하지 않는다. 상태 preview의 `automatic`, `includeExisting`으로 범위를 구별하고 확장은 새 명시 동작으로만 수행한다. 실패 terminal work의 자동 부활은 허용하지 않으며 새 generation 재시도는 별도 사용자 동작이다.

모든 pre-call admission은 현재 consent와 동일한 `consentEpoch`를 durable request/reservation에 기록한다. 철회는 epoch를 증가시키고 새 예약·호출을 막으며 queued-but-not-started work를 취소 대상으로 만든다. 이미 network로 전송된 데이터를 회수할 수 없다는 사실은 UI에 설명하되, 늦은 결과의 publication은 fence로 차단한다. 재동의는 새 epoch이며 과거 work를 되살리지 않는다.

### 예산

`usage-retention`은 configuration별 월/기간 비용 한도와 reservation ledger를 소유한다. 사용자별 동의·예약을 유지하되 사용자 수만큼 서비스 예산이 늘어난다고 가정하지 않는다. 첫 실제 AI 호출 gate에서 서비스 전체 비용 상한과 집계·admission 범위를 확정하며 현재 인증 변경에 별도 전역 quota 플랫폼을 추가하지 않는다. budget 계산은 settled usage와 유효 예약, 호출 노출 후 아직 정산하지 않은 예약의 보수적 최대 비용을 포함한다. 노출 예약은 기한이 지났다는 이유만으로 비용을 비우지 않는다. 단순 client counter나 provider dashboard는 admission authority가 아니다.

예약은 `reservationId`, owner, purpose, request fingerprint, consent epoch, pricing snapshot/version, reserved maximum, currency/base unit, `expiresAt`, 상태(`reserved|settled|released|expired`)를 갖는다. 동일 owner·purpose·request identity의 fingerprint/idempotency key 반복은 기존 예약을 반환하거나 하나만 만들며 다른 사용자의 예약과 합치지 않는다. unique constraint와 transaction으로 `spent + active reservations + requestedMax <= configuredBudget`를 보장한다. 예산 부족, 미동의, 가격 정보 없음은 provider 호출 전에 종료하므로 provider call count는 0이다.

정산은 provider의 검증 가능한 usage를 pricing snapshot에 적용하되 reservation 상한 초과 정책을 사전에 고정한다. 신뢰 가능한 usage가 없으면 예약 상한을 정산하는 보수적 정책 또는 실패 처리 중 하나를 provider 도입 ADR에서 선택해야 한다. credit/free tier는 budget 여유로 간주하지 않는다. duplicate settlement는 reservation identity의 unique terminal transition으로 비용을 한 번만 반영한다.

### Phase 2의 embedding admission 구현 범위

2단계의 `usage-retention`은 embedding 전용 consent·budget·reservation table을 소유한다. 서버 승인 설정의 budget ID는 기간별 서비스 공유 한도이며 모든 owner가 같은 행을 잠근 뒤 정산액과 유효 예약을 합산한다. 사용자 수만큼 한도가 늘어나지 않는다. 같은 기간의 설정 변경으로 budget ID를 새로 만들어 한도를 우회하지 않도록 실제 provider 승인 때 기간 ID와 총 한도 관리도 확정한다. 비용은 부동소수점 대신 통화·단위 배율이 명시된 정수 문자열/DB bigint로 다룬다. chunk당 최대 비용은 허용된 재시도까지 포함한 승인 상한이어야 하며 기본 추정 가격은 없다.

동의·current revision 확인·예약·work·활성화 receipt는 동일 transaction이고 큐 전달은 commit 이후다. 철회는 epoch를 증가시키지만 이미 노출되었을 수 있는 비용을 임의로 지우지 않는다. 2~3단계에서는 제품 설정을 `null`로 유지했으며, 현재는 아래 승인된 Gemini Free 정책을 키가 있는 앱에만 구성한다. 키 존재는 사용자 동의를 대신하지 않고 합성 정책은 격리 테스트에만 주입한다.

3단계는 호출 전 유효 예약 재확인과 STARTED·`exposure_started_at`의 같은 commit, 미노출 만료 예약 정리까지 추가한다. 이 시각은 실제 과금 증명이 아니라 **호출 가능성을 배제할 수 없는 경계**다. provider 호출은 commit 뒤에만 가능하며 lease 만료·철회·삭제·실행 실패로 노출 시각을 지우지 않는다. 여러 work가 공유한 예약은 한 work의 종료만으로 release/settle하지 않는다.

새 예약을 계산하는 API와 노출을 기록하는 worker 모두 같은 budget 행을 먼저 잠근다. API는 `reserved` 중 `expires_at > now()` 또는 노출 시각이 있는 예약을 합산한다. worker는 잠금 대기 뒤 현재 DB 시각으로 예약을 재검사하고, 새 attempt는 노출 여부와 무관하게 아직 유효한 예약이 있어야 한다. 만료 정리는 `reserved`이면서 기한이 지났고 노출 시각이 없는 행만 bounded `SKIP LOCKED`로 `expired` 처리한다. 노출 예약은 비용 근거를 보존한 채 아래 정산 절차를 거치며 만료만으로 budget 점유를 해제하지 않는다.

2026-10-01의 embedding 4-a는 내용 없는 `usage_embedding_call_receipts`를 attempt별 비용 근거로 추가한다. indexing이 동일 예약의 모든 work가 terminal인지 확인한 뒤 usage public 메서드에 전체 attempt identity를 넘긴다. usage는 검증된 사용량 합계를 정산하며 receipt 누락·사용량 불명 시도가 있으면 예약 전체 상한을 보존한다. 이미 노출됐는데 시도 근거가 없는 경우도 0으로 처리하지 않는다. 예약 상태의 CAS로 중복 정산을 막고 미노출/무시도 종료만 0으로 닫을 수 있다. 이 정산은 게시 거부와 독립적으로 판정하되 같은 업무 transaction에 참여한다. 당시 유료 등급 전제는 아래 Free 후속 승인으로 대체하며, 개별 동의 전 호출 금지는 유지한다. 과거 검증과 현재 범위는 [선정·게시 기록](../plans/2026-09-30-phase2-provider-gate.md)에서 구분한다.

호출의 단가는 현재 설정이 아니라 예약의 `pricing_snapshot.pricePerToken`을 사용한다. 가격·예산 기간은 벡터 호환성·전송 동의 fingerprint와 분리한다. provider-free 단계의 합성 설정은 단가를 생략할 수 있지만 실제 사용량 정산에서는 단가 누락을 허용하지 않는다. 가격·통화·단위 배율 검사를 통과하지 못하면 게시/정산 transaction을 rollback한다.

### Gemini 무료 등급의 제품 설정 — 2026-10-01

사용자는 Gemini Free로 Phase 2를 마무리하도록 승인했다. 이 결정은 이전 개인 자료용 유료 등급 선택을 대체한다. 무료 서비스의 입력·출력이 Google 제품 개선 및 사람의 검토에 사용될 수 있음을 안내하고 **공개 가능한 학습 자료만** 대상으로 한다. 민감·기밀·개인정보는 보내지 않는다. 로컬 철회로 이미 전송한 데이터를 회수하거나 provider의 삭제를 보장하지 않는다. 무료 등급 여부는 운영자가 확인하며 키 문자열로 결제 상태를 판정하지 않는다. 조건을 바꾸는 유료 전환은 별도 결정이다.

- 승인 모델은 `gemini-embedding-2`, 1,536차원, 내부 모델 설정 `gemini-embedding-2-config-v1`, 입력 처리 `body-utf16-1200-gemini2-retrieval-v1`, 동의 정책 `gemini-free-public-only-v1`이다. 모델 ID를 고정 가중치 snapshot이라고 주장하지 않는다.
- API와 worker가 `packages/ai`의 같은 설정과 Gemini 전송 코드를 사용한다. 키가 없으면 설정은 `null`이며 저장·keyword·읽기는 유지한다. 키가 있어도 명시적 계정 동의·현재 설정·예산 예약이 모두 있어야 호출한다.
- chunk에는 immutable 본문 text만, query에는 사용자가 명시적으로 실행한 검색어만 보낸다. 제목·메모·맥락·출처 URL은 chunk 입력에서 제외한다. query 원문과 vector는 DB·로그에 저장하지 않고 요청 처리 중에만 사용한다.
- 무료 사용량도 텍스트 표준 단가 $0.20/100만 토큰을 **참고 예산**으로 계산한다. `USD`, 단위 배율 `1,000,000,000`, 토큰당 `200`을 pricing snapshot에 고정한다. chunk당 8,192토큰과 최대 5회 시도를 포함한 예약 상한은 `8,192,000` 단위다. 무료 프로젝트의 실제 청구액이 아니다.
- UTC 월별 서비스 전체 $1 참고 상한 중 평가용 $0.10을 제외한 제품 상한은 $0.90이다. 2026-10-06 사용자 승인에 따라 chunk/query 합계는 $0.45, 답변은 $0.45로 나눈다. 같은 월 예산 행 잠금 아래에서 서비스 전체 합계와 목적별 합계를 모두 검사한다. 월 중 전환 전 사용액도 보존하므로 두 목적을 다른 예산 ID로 나눠 총상한을 늘리지 않는다. 임베딩 예약 유효 시간은 1시간이다.
- 무료 429·접근 거부·잘못된 응답은 자동 재시도하지 않는다. 일시적 network/5xx의 worker 재시도도 같은 예약·attempt 상한 안에서 수행한다. query 호출에는 자동 재시도를 넣지 않는다.
- query는 owner·request ID와 salted input fingerprint를 예약에 연결한다. 동일 요청은 추가 호출하지 않으며 새 검색은 새 request ID로 명시적으로 실행한다. 노출 commit 뒤 provider를 transaction 밖에서 호출하고, 검증된 usage 또는 예약 상한으로 정산한 뒤 현재 동의·설정·자료를 재검사한다. crash로 만료된 노출 query 예약도 worker가 상한 정산해 비용을 없애지 않는다.

위 provider 조건과 실제 소규모 품질 평가의 근거·한계는 [선정 기록](../plans/2026-09-30-phase2-provider-gate.md#2026-10-01-gemini-무료-평가-전환)에 있다. fake-provider 회귀 검사를 실제 검색 품질 근거로 사용하지 않는다.

### 2026-10-06 — 식별자와 예산 기간 분리

이전 구현은 월 예산 ID·시작/종료·가격까지 fingerprint에 포함했다. 월 변경 뒤 재기동하면 기존 동의·activation·vector가 config 불일치가 되어 검색에서 제외되고 worker cleanup에서 벡터를 삭제할 수 있었다. 재동의·활성화에는 재임베딩 비용도 들었다. 재기동하지 않으면 지난 기간으로 admission이 거부되는 문제도 있었다.

수정된 설정은 provider/model/version/dimension/inputVersion의 `vectorFingerprint`, provider/policyVersion/전송·보존 고지의 `consentFingerprint`를 별도로 계산한다. 기존 work·동의·게시 fence의 `configFingerprint`는 두 식별자를 합친 호환성 키다. 월·가격·예산은 이 키에 넣지 않는다. 동의 조건을 바꾸었는데 벡터 공간만 같다는 이유로 기존 동의·결과를 계속 사용하지는 않는다.

월 예산은 API·worker가 공유하는 usage-retention 저장 함수에서 DB 시각으로 선택한다. 잠금 취득 뒤 시각으로 기간을 다시 확인하고, 만료되지 않은 예약과 만료됐어도 호출 노출이 있는 예약을 합산한다. API의 업무 오류와 worker의 처리 보류 결과는 각각 유지한다. 월 경계에 걸쳐 기다리던 admission은 종료된 기간으로 예약하지 않고 다음 요청/회차에서 새 기간을 선택한다.

fingerprint 알고리즘 자체의 첫 업그레이드는 이전 fingerprint를 동의 없이 새 값으로 바꾸지 않는다. **기존 설치는 한 번 재동의·활성화가 필요하며 이전 벡터는 기존 config cleanup 대상이다.** 그 이후에는 월 변경이나 가격 변경만으로 재동의·벡터 삭제·재임베딩을 하지 않는다. 개발 DB 적용과 앱 전환은 별도이며 API/worker를 함께 갱신한다.

### Phase 3 무료 답변 설정 — 소량 평가 후 제품 활성화 승인

사용자는 Gemini `gemini-3.5-flash-lite` 무료 모델 구현, 별도 명시적 답변 동의, 답변·인용 7일 및 content-free receipt/비용 기록 90일을 승인했다. 임베딩 동의는 답변 동의를 대신하지 않는다. 공개 가능한 질문과 선택한 근거 본문만 전송하고 도구·외부 검색·유료 모델 fallback은 사용하지 않는다. 무료 입력·출력의 제품 개선 사용 조건은 [공식 모델 안내](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)와 [요금 안내](https://ai.google.dev/gemini-api/docs/pricing)를 기준으로 확인했다.

참고 정산은 입력 $0.30/100만 토큰, 출력 $2.50/100만 토큰의 정수 단가를 예약 snapshot에 기록한다. 실제 무료 청구액으로 표현하지 않는다. 요청당 입력·출력 상한을 먼저 예약하며 검증 가능한 usage가 없으면 상한으로 정산한다. worker의 호출 가능 창은 10분이고 질문 원문은 terminal 전이·만료 정리 때 지운다. 원문 자료/메모의 보존 기간은 바꾸지 않는다.

2026-10-07 후속 승인으로 실제 모델의 합성 자료 3건 smoke를 수행했다. 단일·복수 근거의 제한된 사실/인용과 근거 부족 응답을 확인했으며 종합 한국어 답변 품질 통과로 표현하지 않는다. 이후 사용자의 제품 활성화 승인에 따라 API·worker는 `GEMINI_API_KEY`가 있을 때 같은 `geminiFreeAnswerPolicy()`를 구성한다. 키 누락·빈 문자열·공백이면 답변 설정은 `null`이다. 키 존재는 계정의 별도 답변 동의·명시적 질문·예산 예약을 대신하지 않는다. 격리 회귀의 fake provider와 실제 소량 호출 근거·사용량은 [작업 기록](../plans/2026-10-06-phase3-4-completion.md)에서 구분한다.

### Phase 2 embedding 보존 결정

사용자는 90일 상세 기록 정리 뒤에도 **최소 중복 방지 기록을 자료가 남아 있는 동안 유지**하도록 승인했다. 이는 본문·검색어·벡터의 추가 보관 승인이 아니다.

- 유효한 현재 vector는 자료·동의·설정이 유효한 동안 유지한다. 이전 revision의 동일 chunk 입력 결과는 같은 owner·material·config·consent에서 현재 본문 재사용이 가능한 경우에만 보존한다. 삭제·철회·설정 변경 또는 현재 본문과 불일치한 vector는 즉시 검색·재사용에서 제외하고 worker가 bounded batch로 물리 정리한다. 24시간 정리 목표에는 worker 가동이 필요하며 중단 시간까지 삭제 완료로 주장하지 않는다.
- 상세 정리는 예약이 `settled/released/expired`로 종료된 지 90일, 연결된 모든 work의 terminal 전이와 모든 attempt 종료가 각각 90일을 넘었고 해당 예산 기간도 끝난 경우에만 수행한다. 동일 transaction에서 attempt·호출 비용 receipt·예약을 삭제하고 terminal work의 `reservationId`만 비운다. 활성·미정산 예약, 비종료 work·attempt와 연결된 기록은 기한만으로 삭제하지 않는다. 기간별 예산 집계는 월 종료 후 90일 및 연결된 예약 정리 이후에 삭제한다.
- 최소 work ID·intent/generation·config fingerprint·consent epoch·terminal 상태는 남긴다. 상세 기록이 없어졌다는 이유로 scanner가 이미 끝난 intent를 새 작업으로 만들지 않으며 terminal 상태를 `PENDING`으로 되돌리지 않는다. 명시적 재시도는 새 generation이다.
- activation receipt의 과거 응답에 포함된 예약 상한은 멱등 응답을 위해 유지하며 실제 사용량 ledger로 표현하지 않는다. 정리는 15초 회차에서 예약 최대 100개·vector 최대 100개를 선점하고 잠긴 행을 건너뛴다. 키가 없어도 정리 주기는 유지하며 원문 revision 보존 정책은 바꾸지 않는다. `0016_embedding_retention`은 종료·정리 시각을 추가하고 과거 종료 행의 시각을 추정하지 않아 업그레이드 뒤 90일을 더 보존한다. 실제 검사 결과는 마무리 기록에 남긴다.

### 답변 transaction choreography

`answers` application workflow 하나가 public port만 호출하며 다른 module의 private repository에 접근하지 않는다.

answer request의 authoritative state machine은 다음 하나다.

```text
REQUESTED -> RESERVED -> RUNNING -> PUBLISHED | NO_ANSWER | FAILED | EXPIRED | INVALIDATED
```

`REQUESTED → RESERVED`는 snapshot+reservation commit, `RESERVED → RUNNING`은 call-attempt `STARTED` commit이다. Provider 호출과 게시 시도는 `RUNNING`에서만 가능하고 `PUBLISHED`/`NO_ANSWER`는 `RUNNING`에서만 전이한다. 모든 terminal state는 CAS 이후 되돌리지 않으며 retry는 같은 logical request 안에 새 call-attempt만 추가한다.

#### 1. Pre-call committed phase

짧은 application-owned transaction에서 다음을 모두 성공시키거나 모두 실패시킨다.

1. access JWT로 검증한 owner와 명시적 answer command/idempotency를 검증한다. `auth`의 private 저장소에 접근하거나 provider 호출 중 refresh 상태를 재검사하지 않는다.
2. 현재 material/revision과 삭제 여부를 검사해 명시 근거의 chunk를 선택한다. 자료 상세의 단일 자료 대화는 임베딩 준비를 선행 조건으로 요구하지 않는다.
3. evidence ID, material ID, revision ID, immutable content hash와 인용 가능한 locator의 snapshot을 answer request에 저장한다.
4. current consent epoch를 확인한다.
5. 같은 request identity와 epoch로 budget reservation을 만든다.
6. request를 `RESERVED`로 표시하고 expiry/fingerprint를 기록한다.

여러 module의 상태는 `answers`에 노출된 snapshot port와 `usage-retention` reservation port를 통해 협력한다. repository handle 공유나 storage trigger가 workflow를 소유하지 않는다. 분산 transaction으로 가장하지 않으며, application transaction manager가 참여 port의 PostgreSQL transaction을 명시적으로 조합한다. 어느 단계든 실패하면 request와 reservation의 부분 상태를 남기지 않는다.

#### 2. Provider claim과 call phase

pre-call commit 뒤 worker는 짧은 claim transaction에서 `RESERVED → RUNNING`을 CAS하고 `callAttemptId`, attempt number, provider request fingerprint, pricing snapshot, DB-clock `startedAt`, 상태 `STARTED`를 immutable하게 기록한다. 이 commit 전 장애는 호출 전 실패로 확정할 수 있다. commit 뒤 provider를 호출하며 이 동안 PostgreSQL transaction이나 row lock을 열어 두지 않는다. DB commit과 외부 network 수신은 원자화할 수 없으므로 `RUNNING/STARTED` 뒤 crash·timeout은 실제 호출 또는 비용 발생 가능성이 있는 불명 상태로 취급한다.

input은 committed snapshot의 필요한 evidence만 포함하고 request ID와 secret은 provider prompt에 넣지 않는다. timeout, cancellation, 429와 malformed response는 bounded retry 정책을 따르되 각 실제 시도는 별도 call-attempt와 비용 exposure로 기록한다. retry가 새 reservation이나 새 logical request를 만들지 않는다.

현재 무료 답변 구현의 자동 재시도 상한은 **0회**다. 한 request에 하나의 call-attempt만 허용하는 DB unique 제약으로 중복 실행을 막는다. 실패 후 같은 요청을 다시 보내면 상태만 반환하며, 사용자가 별도로 새 질문 요청을 실행하기 전에는 다시 호출하지 않는다. worker 실행에 필요한 질문은 제품 request 행에만 최대 10분 유효 창으로 저장하고 terminal/만료 정리에서 제거한다. 이는 raw prompt·provider request를 debug artifact나 usage ledger에 보관하는 허가가 아니다.

#### 3. Fenced publish phase

provider candidate를 받은 뒤 새 짧은 transaction에서 다음 fence를 모두 다시 검증한다.

- owner와 answer request/reservation identity 일치
- request가 아직 publish 가능한 `RUNNING` 상태이고 만료되지 않음
- reservation이 active이고 같은 consent epoch이며 미정산
- 현재 consent가 철회/epoch 변경되지 않음
- 모든 evidence material이 삭제되지 않았고 snapshot revision이 여전히 current
- content hash와 locator가 snapshot과 일치
- candidate citation이 snapshot evidence allowlist에만 매핑되고 answer의 사실 claim이 citation 없는 임의 근거를 만들지 않음

publication과 settlement는 서로 다른 판정이다.

1. publication fence가 모두 통과하면 answer와 server-generated citation mapping을 게시하고 request를 `PUBLISHED` 또는 `NO_ANSWER`로 전이한다. 실패하면 answer를 게시하지 않고 `INVALIDATED`, `EXPIRED` 또는 `FAILED`로 전이한다.
2. `usage-retention`은 publication 결과와 무관하게 call-attempt exposure를 판정한다. provider가 수신하지 않았음이 확정된 호출 전 실패만 reservation을 release한다. 검증 가능한 usage는 실제 금액으로, `RUNNING/STARTED` 뒤 결과 불명은 사전 승인된 provider별 보수 정책으로 정산한다.
3. request terminal CAS와 reservation terminal CAS는 각각 exactly-once이며 동일 result 재전달은 저장된 결과를 반환하고 answer/citation/usage를 중복 생성하지 않는다.

PostgreSQL commit만 publication 및 settlement effect의 증거다. provider 성공이나 BullMQ completion은 증거가 아니다.

### Abandonment, crash와 compensation

- pre-call commit 전 crash: durable request/reservation 없음, provider 호출 없음.
- pre-call commit 뒤 `RESERVED`이고 call-attempt가 없는 상태의 crash: expiry sweeper가 reservation을 release하고 request를 `EXPIRED`로 만든다.
- claim commit으로 `RUNNING/STARTED`가 된 뒤 network 호출 전·중 crash 또는 timeout/결과 불명: 호출 가능성을 부정할 수 없으므로 attempt evidence를 유지하고 provider별 보수 정산 정책을 적용한다. 무조건 무료로 release하지 않는다.
- provider 성공 후 publish 전 crash: 동일 request/reservation으로 재개하거나 만료 compensation한다. 새 logical 호출은 fence와 정책 없이 만들지 않는다.
- consent 철회, material edit/delete, evidence expiry와 late result: publication은 거부하되, 이미 발생했거나 `RUNNING/STARTED` 때문에 발생 가능성을 배제할 수 없는 비용은 provider별 exposure 정책으로 exactly-once 정산한다.
- duplicate worker/result: terminal compare-and-set에서 no-op; 추가 charge 없음.

sweeper는 `expiresAt`과 DB server time을 기준으로 barrier 이후 claim하고 `SKIP LOCKED`/lease와 terminal CAS를 사용한다. sleep 순서에 기대지 않는다. cleanup 자체도 idempotent하다.

### Grounding과 citation

answer는 snapshot의 evidence만 사용하며 citation 없는 일반 지식 답변을 허용하지 않는다. 최소 근거가 없거나 서로 충돌해 안전하게 답할 수 없으면 `insufficient-evidence` 결과를 게시하고 생성형 답변을 꾸미지 않는다. citation은 answer span/claim에서 `evidenceId`로 연결되며 material/revision/chunk/locator와 content hash를 server가 매핑한다. UI에서 citation은 [자료 읽기](0006-frontend-information-architecture-and-design.md)의 현재 근거로 이동한다.

2026-10-13 자료별 대화는 현재 자료 한 개로 근거를 제한한다. 최근 게시 답변 최대 3개의 ID와 화면에 남아 있는 이전 질문을 후속 요청에 포함할 수 있다. 서버는 이전 요청의 owner·단일 자료·현재 revision·동의·보존 기한·게시 상태를 검증하고 저장된 답변 claim을 읽는다. 브라우저가 제공한 이전 질문도 신뢰할 수 없는 문맥이며 사실의 근거는 항상 현재 evidence다. 이전 답변이 있다고 새로운 자료 접근·도구 실행 권한을 주지 않는다. history는 요청 fingerprint에 포함하고 입력 상한 안에서만 사용한다.

자료와 무관한 질문·시스템 지시 공개 요구·근거 부족에는 `NO_ANSWER`가 되도록 provider 지시를 제한한다. 본문·질문·history의 역할 변경·규칙 무시 명령은 지시가 아닌 데이터로 취급한다. 이 프롬프트와 citation 검증은 실제 모델의 관련성 판단이나 prompt injection 차단을 100% 보장하지 않는다. schema·길이·근거 allowlist·owner fence는 서버가 강제하며 외부 도구·웹 검색·다른 자료 읽기는 제공하지 않는다.

SSE는 상태와 검증·DB 게시가 끝난 최종 답변을 전송한다. 검증 전 provider token을 곧바로 사용자에게 스트리밍하지 않으며 SSE 연결 자체는 provider 호출이 아니다. 조회 때마다 동의·revision·삭제·만료 방어를 적용한다. 대화 목록은 해당 자료 화면 메모리에만 유지하고 새 영구 채팅 이력 저장소는 만들지 않는다. 서버의 현재 미완료 질문·필요 문맥은 기존 최대 10분 실행 창과 terminal 정리, 게시 답변·인용은 7일, 내용 없는 중복 방지·비용 기록은 90일 계약을 그대로 따른다.

provider 출력은 untrusted input이다. schema, 최대 길이, citation allowlist, unsafe Markdown을 검증하고 sanitize한다. provider가 제안한 hidden instruction, URL, script, raw HTML 또는 snapshot 밖 source는 폐기한다. 품질 평가 계약은 [ADR-0009](0009-verification-observability-and-search-evaluation.md)이 소유한다.

### Idempotent 결과 재조회

answer request의 logical identity는 authenticated owner, client request ID와 canonical input fingerprint의 조합이다. 같은 owner·request ID·fingerprint가 재전송되면 새 reservation이나 provider call을 만들지 않는다. 저장된 `PUBLISHED`/`NO_ANSWER` 결과가 아직 접근 가능하고 snapshot revision이 current이며 material이 미삭제이고 consent epoch와 answer expiry가 유효하면 그 결과를 그대로 반환한다. 같은 request ID의 다른 fingerprint는 conflict다. 저장 결과가 stale, deleted, revoked 또는 expired면 본문을 노출하지 않고 해당 terminal 사유를 반환하며 같은 ID로 새 호출하지 않는다.

### 보존과 삭제

`usage-retention`은 consent/budget/usage의 최소 audit row를, `answers`는 request/evidence snapshot/answer/citation lifecycle을 소유한다. 구체적인 day 수는 각 AI purpose의 provider 조건과 운영 필요를 확인해 **그 purpose의 첫 실제 provider 통합·호출 전에** configuration으로 고정한다. 이 결정은 provider를 사용하지 않는 Phase 1 저장·keyword 검색·읽기 scaffold를 막지 않는다. 다음 원칙은 즉시 적용한다.

- raw provider request/response를 durable debug evidence로 보존하지 않는다.
- answer body와 citation은 사용자가 보는 제품 data이며 설정된 짧은 product retention 또는 material 삭제까지 보존한다.
- request fingerprint, terminal outcome, provider-call/settlement identity로 구성된 content-free dedupe receipt는 answer body보다 긴 별도 기간 유지해 응답 유실·만료 뒤 중복 호출과 이중 정산을 막는다. `dedupeExpiresAt`은 항상 `answerExpiresAt`보다 늦어야 하며, receipt가 남아 있는 동안 같은 ID의 같은 입력은 새 호출 없이 만료 결과를, 다른 입력은 conflict를 반환한다.
- evidence snapshot content는 publication/recovery에 필요한 최소 기간만 보존하고 가능하면 ID/hash/locator로 최소화한다.
- usage ledger는 원문·prompt 없이 purpose, model/pricing version, token/단위 count, 금액, timestamp와 outcome만 보존한다.
- material 삭제 또는 owner cleanup은 새 호출을 즉시 차단하고 queued work를 취소하며 answer/citation/snapshot을 dependency 순서로 삭제 또는 접근 불가 처리한다. 보존 의무가 있는 비용 row는 content linkage를 제거한다.
- provider-side retention/deletion capability와 private-data training 조건은 provider 선택 gate의 필수 evidence다.

### Telemetry exclusion

log, trace, metric, error reporting과 durable debug artifact에는 사용자 원문/메모/chunk, search query, prompt, answer text, citation excerpt, raw provider request/response, provider nested error body, cookie, token, Google profile·JWT claim, API key와 secret을 기록하지 않는다. metric label에는 owner/material/request/provider request ID를 넣지 않는다. bounded 값인 component, purpose, outcome, error class, model/pricing config version, retry count와 금액 bucket만 허용한다. correlation이 필요하면 별도 telemetry key로 만든 environment-scoped pseudonym을 structured log/trace에만 사용한다.

## Considered Options

1. **durable pre-call reservation/snapshot, transaction 밖 provider, fenced publish/settlement** — 선택.
2. provider 호출을 하나의 DB transaction 안에서 수행 — lock·timeout 때문에 기각.
3. 호출 뒤 비용을 best-effort 기록 — crash/중복에서 예산을 초과하므로 기각.
4. provider citation과 URL을 그대로 게시 — grounding 권위를 provider에 넘겨 기각.
5. AI를 저장·검색의 필수 경로로 둠 — graceful degradation을 깨므로 기각.

## Consequences

- 답변 경로는 pre-call, call-claim, post-call의 세 짧은 transaction과 그 사이의 transaction 밖 provider call 및 compensation 상태로 복잡해지지만 stale publication과 double charge를 막는다.
- 동의나 예산이 없을 때 core 제품은 계속 동작한다.
- provider/model을 지금 고르지 않아도 adapter, privacy와 evidence gate는 고정된다.
- exact retention 기간과 가격 정책은 provider 도입 전에 반드시 결정되어야 하며 조용한 기본값은 없다.

## Verification contract

실제 PostgreSQL integration에서 snapshot+reservation all-or-none, unique reservation, concurrent budget race, consent epoch race, edit/delete race, expiry/settlement CAS와 duplicate result를 deterministic barrier로 검증한다. fake provider는 timeout, 429, malformed schema, unknown outcome, citation escape와 crash window의 제어에만 사용하며 semantic 품질 증거로 쓰지 않는다. 미동의·budget exhausted·가격 없음에서는 provider spy가 0 call임을 검증한다. redaction fixture는 nested error를 포함해 금지 content가 log/trace/metric/debug artifact에 0건임을 검사한다.

## Revisit triggers

provider/model 도입, 법적 보존 조건 변경, 팀·공유·역할 또는 billing 도입, 혹은 PostgreSQL 단일 transaction으로 public ports를 조합할 수 없는 topology가 승인될 때 재검토한다.

# Phase 2 — 임베딩 제공자 선정안

- 상태: 2026-10-01 Gemini Free 승인 범위의 Phase 2 구현·종료 검증 완료. 합성 품질 평가와 worker 호출·재사용·검색·화면·보존의 검증 근거는 아래에서 구분한다. 이전 유료 등급 선택은 후속 Free 결정으로 대체했고 OpenAI 실행 코드는 제거했다. 개발 DB 적용과 사용자 환경의 수동 확인은 남겨 두었다.
- 조사일: 2026-09-30, Gemini 평가 설정 확인 2026-10-01
- 범위: Phase 2의 chunk/query 임베딩. Phase 3 답변 모델과 클라우드 배포는 제외한다.
- 상위 계약: [ADR-0008](../adr/0008-ai-provider-consent-budget-grounding-and-retention.md), [Phase 2 계획](../plan.md#phase-2--ai-도입-gate-embedding과-hybrid-검색)

## 최초 후보 비교 (2026-09-30)

첫 평가 후보는 **OpenAI `text-embedding-3-small`, 1,536차원**이다. 텍스트만 다루는 현재 제품에서 비용이 낮고 별도 모델 서버가 필요 없다는 판단이다. 한국어 개발 메모의 품질이 이미 검증됐다는 뜻은 아니다. 공개 벤치마크만으로 제품 적합성을 확정하지 않고 아래 평가 뒤 제품 설정을 확정한다.

| 후보 | 일반 동기 API 입력 100만 토큰 가격 | 판단 |
|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02 | 우선 평가. 기본 1,536차원 사용으로 초기 차원 축소 실험을 줄임 |
| OpenAI `text-embedding-3-large` | $0.13 | small이 한국어 검색 평가에 부족할 때 비교할 후보. 자동 fallback하지 않음 |
| Google `gemini-embedding-2` | 텍스트 $0.20 | 유료 API 대안. 현재 텍스트 범위에서는 멀티모달 기능을 사용하지 않음 |

가격은 세금·환율·DB/서버 비용을 포함하지 않으며 토큰은 글자 수와 다르다. 공급자별 tokenizer도 달라 같은 문서의 토큰 수가 같다고 가정하지 않는다. 예를 들어 small에 총 1,000만 입력 토큰을 보내면 표의 단가로 $0.20이며, 재시도·질의 입력도 합산해야 한다. 무료 credit은 예산 여유로 계산하지 않는다.

가격·차원 근거: [small 모델](https://developers.openai.com/api/docs/models/text-embedding-3-small), [large 모델](https://developers.openai.com/api/docs/models/text-embedding-3-large), [OpenAI 임베딩 가이드](https://developers.openai.com/api/docs/guides/embeddings), [Google 가격](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2).

## 개인정보 조건

OpenAI API는 명시적으로 데이터 공유에 참여하지 않는 한 입력을 모델 학습에 사용하지 않는다. `/v1/embeddings`의 애플리케이션 상태 보존은 없지만 악용 감시 로그는 기본 최대 30일이며 법적 의무 예외가 있다. **보존 0일로 안내하지 않는다.** Zero Data Retention은 별도 승인 조건이 있으므로 이 선정안의 전제로 삼지 않는다. [공식 데이터 정책](https://developers.openai.com/api/docs/guides/your-data)

Google 유료 서비스도 제품 개선에 입력·출력을 사용하지 않지만 악용 방지 목적으로 제한된 기간 보관한다. 무료와 유료 정책이 다르므로 무료 할당량만 보고 개인 자료의 기본 제공자로 선택하지 않는다. 이 조사에서는 Google 보관 기간의 정확한 일수까지 확정하지 않았다. [Google API 약관](https://ai.google.dev/gemini-api/terms#paid-services)

선정 후에도 서비스 운영자의 제공자 선택과 개별 사용자의 자료 전송 동의는 별개다. 동의 화면에는 chunk 본문과 검색 질의가 외부로 전송됨을 명시한다. 제목·개인 메모·맥락·출처 URL은 기존 계약대로 chunk 임베딩에서 제외한다. 질의는 호출 중에만 다루고 DB·로그·평가 산출물에 사용자 질의를 남기지 않는다. 이미 전송된 데이터가 로컬 철회·삭제와 동시에 제공자에서도 삭제된다고 약속하지 않는다.

## 최초 승인된 실행·비용·보존안 (OpenAI, 후속 전환 전)

1. small 1,536차원을 **평가 후보**로 승인한다. 합성 한국어·영문 개발 자료만 평가에 사용하며 사용자 자료는 전송하지 않는다. large 비교는 small의 실패 사례가 있을 때 같은 corpus로 수행한다. Google 호출은 이번 평가에서 제외한다.
2. 최초 평가 비용은 전체 $0.10 이내, 제품 chunk/query 임베딩은 서비스 전체 월 $1 이내로 제안한다. 평가 비용도 해당 월 합계에 포함한다. 달력상 UTC 월을 쓰고 모든 owner·chunk·질의·재시도를 합산한다. provider 대시보드 알림이 아니라 기존 DB 예산 admission으로 새 호출을 막는다. 이 금액은 애플리케이션의 임베딩 API 비용 상한 제안이지 전체 인프라 예산이나 결제 최소 충전액이 아니다.
3. 검증 가능한 usage는 승인 가격으로 정산한다. STARTED 뒤 timeout·응답 유실 등 결과 불명은 해당 시도의 예약 최대액으로 보수 정산하고, 재시도 비용도 예약에 포함한다. SDK 자체 재시도로 DB attempt를 우회하지 않는다. 여러 work의 공유 예약은 전체 effect를 확인한 뒤 한 번만 닫는다.
4. 유효한 벡터는 현재 자료·동의·설정 범위에서 사용한다. 수정으로 더 이상 사용하지 않는 파생 벡터 및 삭제·철회된 파생 자료는 즉시 검색/재사용에서 제외하고 24시간 안에 물리 정리한다. 원문 revision 보존 정책은 변경하지 않는다.
5. 원문 없는 terminal attempt·정산·중복 방지 기록은 terminal/정산 완료 중 더 늦은 시점부터 90일, 예산 집계는 해당 월 종료 후 90일 보존하는 안이다. 미정산·활성 예약은 기한만으로 삭제하지 않는다. 정리 후 과거 활성화가 자동 재실행되지 않도록 generation·receipt 관계와 명시적 재시도 계약을 함께 검증한다. raw provider 요청/응답은 저장하지 않는다.

사용자는 OpenAI 키 등록과 비례 과금 확인 후 위 실행을 승인했다. 품질 평가가 통과하기 전까지 제품의 `embeddingPolicy`와 worker 승인 fingerprint는 비워 둔다. 키를 채팅·문서·Git에 붙여 넣거나 원문을 출력하지 않는다.

평가는 개발 DB가 아닌 격리 PostgreSQL의 동의·예약 ledger에 호출 전 비용을 예약한다. 별도 실행기의 단일 실행 기록을 배타적으로 생성해 컨테이너 재생성으로 유료 평가가 반복되지 않게 한다. 최초 평가에는 합성 자료 40개와 질의 20개만 보내며 20개씩 최대 3회, 자동 재시도는 없다. 이번 UTC 월 제품 예산에서는 평가용 $0.10을 우선 제외해 격리 평가와 제품 호출의 합계가 $1을 넘지 않게 한다. 실제 정산액이 작더라도 남은 평가 예산을 자동으로 제품에 풀지 않는다.

## 품질 gate 제안과 남은 구현

- 개발용 20개 질의를 먼저 고정한다. 한국어 짧은 질의, 한영 혼합, 동의어·의미 일치, 정확한 기술명과 owner/current/deleted 제외를 포함한다. 검색 가능한 각 질의의 정답 material/chunk를 호출 전에 정한다.
- 초기 제안 기준은 정답이 있는 20개 질의에서 hybrid Hit@5 18/20 이상, 같은 corpus의 keyword Hit@5 이상, owner/current/deleted 위반 0건이다. 이는 승인할 개발 기준이며 운영 품질 보장이나 Phase 5의 동결 final 40-case 평가를 대체하지 않는다.
- 실제 호출 결과·토큰 수·비용·차원·정확한 요청 model ID와 입력 처리 버전을 기록한다. 문서상 날짜가 붙은 immutable embedding snapshot이 확인되지 않아 model ID를 고정 가중치 버전이라고 주장하지 않는다. 내부 설정 버전과 evaluation corpus/result를 별도로 고정한다.
- 평가 통과와 제품 설정 승인 뒤 vector migration·publication·비용 정산을 붙이고, 같은 owner의 유효한 동일 chunk 입력 재사용을 구현한다. query 임베딩·hybrid 조회와 기존 화면의 동의/활성화/실패 안내, terminal 명시 재시도, 삭제·철회 정리 순서로 이어간다.
- 실제 PostgreSQL/Redis/fake-provider 장애 테스트와 실제 모델 검색 품질 평가를 구분한다. 마지막에 Phase 1 여정, provider/Redis 장애 시 keyword 유지, 브라우저·이미지 검증까지 재실행해야 **Phase 2 전체 완료**다.

## 2026-09-30 실행 결과

- `node tests/evaluations/embedding.mjs --check`: 격리 PostgreSQL의 migration·자료 생성·실제 keyword Repository·후보 벡터 조회·제외 조건을 확인했다. 실제 AI 호출은 0건이며, 합성 숫자 벡터의 순위는 품질 근거가 아니다.
- `node scripts/run-env.mjs worker dev tests/evaluations/embedding.mjs`: 첫 20개 합성 본문 요청에서 HTTP 429가 반환되어 중단했다. 후속 두 배치와 자동 재시도는 실행하지 않았다. 반환 벡터·질의별 품질 결과는 없다.
- 첫 요청은 호출 전에 격리 DB에 $0.0032768 상한을 예약했다. 검증 가능한 usage를 받지 못해 실제 청구액을 단정하지 않고 로컬 기록에 노출 상한을 보존한다. DB·컨테이너는 종료했다. 키·원문 오류·응답 본문·벡터는 기록하지 않았다.
- 실행 당시 분류기는 `insufficient_quota` 이외의 429를 일시 제한으로 분류했다. 따라서 기록된 `rate_limited`만으로 실제 제한 종류를 확정할 수 없다. 공식 문서의 잔액·조직/프로젝트 한도 코드를 별도 분류하고 알 수 없는 429는 재시도 가능한 일시 제한으로 간주하지 않도록 보완했다. [OpenAI 오류 코드](https://developers.openai.com/api/docs/guides/error-codes)
- 다음 실제 호출 전 계정의 결제 잔액과 조직·프로젝트 제한 확인이 필요하다. 기존 배타적 실행 기록을 삭제하거나 실패 비용을 초기화해 자동 재호출하지 않는다. 재개 시 앞선 노출 상한을 포함한 승인 예산 안에서 별도 실행 기록을 유지한다.

Phase 2는 아직 미완료다. 품질 평가 통과, 제품 vector migration·게시·정산·검색·화면·정리 및 최종 회귀 검증이 남아 있다.

## 2026-10-01 Gemini 무료 평가 전환

사용자가 Gemini 키를 준비하고 Free 등급임을 확인했다. 이번 승인은 **합성 자료 평가만** 포함한다. 무료 서비스의 입력·출력은 Google 제품 개선에 사용될 수 있으므로 실제 개인 자료 전송이나 제품 기본 제공자 확정으로 확대하지 않는다. 유료 전환·결제 연결·OpenAI fallback은 하지 않는다. [Google 가격](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2), [무료 서비스 약관](https://ai.google.dev/gemini-api/terms#unpaid-services)

- 모델 `gemini-embedding-2`, 1,536차원, 입력 처리 `body-utf16-1200-gemini2-retrieval-v1`을 고정한다. 본문은 `title: none | text: …`, 질의는 `task: search result | query: …`로 보낸다. 실제 제목·메모·URL은 포함하지 않는다. Gemini 2가 지원하지 않는 `taskType` 대신 공식 검색용 접두사를 사용한다. [입력 형식](https://ai.google.dev/gemini-api/docs/embeddings#task-types-with-embeddings-2)
- 기존 corpus의 합성 본문 40개와 질의 20개를 변경하지 않고 20개씩 최대 3회 보낸다. 동기 `batchEmbedContents`만 사용하며 파일을 저장하는 비동기 Batch API는 사용하지 않는다. 429·네트워크 오류·잘못된 응답에서는 즉시 중단하고 자동 재시도하지 않는다. [API 계약](https://ai.google.dev/api/embeddings#method:-models.batchembedcontents)
- 무료 여부를 예산 여유로 계산하지 않는다. 텍스트 유료 표준 단가 $0.20/100만 토큰과 입력당 8,192토큰으로 호출 전 참고 비용을 예약한다. 최초 $0.10에서 앞선 OpenAI의 불명 노출 상한 $0.0032768을 빼서 새 실행의 상한은 $0.0967232다. 이는 무료 프로젝트의 실제 청구액이 아니다. 토큰 사용량이 없으면 해당 예약 최대액으로 보수 집계하며 남은 예산이 부족하면 후속 배치를 보내지 않는다.
- 전용 배타적 시작 기록을 사용해 앞선 실패 기록을 덮거나 실행을 반복하지 않는다. 새 결과에는 corpus hash와 별도로 모델·차원·입력 처리 버전을 포함한 config fingerprint를 남긴다. 본문·질의·키·응답 원문·벡터는 평가 산출물에 저장하지 않는다. 벡터와 합성 DB는 평가 종료 때 격리 컨테이너와 함께 제거하고, 내용 없는 비용·결과 요약은 위 보존 기준을 따른다.
- 변경 범위는 worker의 Gemini HTTP adapter, 기존 평가 실행기와 관련 테스트·문서다. 제품 consumer·`embeddingPolicy`·DB schema·화면은 변경하지 않는다. 품질 기준은 기존 hybrid Hit@5 18/20 이상·keyword 이상·제외 조건 위반 0건을 유지한다.

현재 검증 순서는 `pnpm build:backend`, `pnpm exec vitest run tests/gemini-embedding-provider.test.ts`, `node tests/evaluations/embedding.mjs --check`다. 사전 검사는 외부 AI를 호출하지 않는다. Free 등급 확인과 명시적 호출 승인 뒤에만 `node scripts/run-env.mjs worker dev tests/evaluations/embedding.mjs --gemini-free`로 실행한다. 키는 `apps/worker/.env.dev`의 `GEMINI_API_KEY`에서 읽으며 값은 출력하지 않는다. `--gemini-free`는 운영자의 확인 표시이지 API 프로젝트의 결제 등급을 기술적으로 검증하는 기능은 아니다.

### 실행 결과

- `pnpm build:backend` 통과. provider HTTP 테스트는 OpenAI 23개·Gemini 16개, 총 39개 통과했다. 이 테스트 자체의 실제 외부 호출은 0건이다.
- 테스트 TypeScript 검사, 변경 파일 ESLint·Prettier 검사, `pnpm lint:architecture`가 통과했다.
- `--check`는 격리 PostgreSQL에서 20개 질의·필터를 점검했고 외부 호출 0건이었다. 가짜 벡터의 순위 수치는 의미 품질 근거가 아니다.
- 실제 Gemini 평가는 20개씩 3회 성공했다. 합성 본문 40개와 질의 20개, 입력 토큰은 각각 1,361·1,286·436개로 총 **3,083토큰**이다. 자동 재시도·OpenAI 호출은 없었다.
- 정답 material 기준 **vector Hit@5 20/20, hybrid Hit@5 20/20**, owner/current/deleted 위반 **0건**으로 사전에 정한 개발 gate를 통과했다. 같은 corpus의 keyword Hit@5는 0/20이었다. 자연어형 질의와 현재 keyword 조건의 조합에서 나온 결과로, 이를 일반적인 keyword 검색 품질이나 의미 검색의 보편적인 개선 폭으로 확대 해석하지 않는다. 후보 수가 작은 합성 평가이며 고정 final 평가·실제 사용자 품질 검증을 대체하지 않는다.
- 유료 표준 단가를 적용한 참고 집계액은 $0.0006166이며, 앞선 OpenAI의 불명 노출 상한까지 합쳐 $0.0038934다. Free 프로젝트의 실제 청구액을 이 금액으로 주장하지 않는다. 격리 DB·벡터는 실행 후 컨테이너와 함께 정리했고 원문 없는 요약만 로컬 평가 기록에 남겼다.

이번 결과는 제공자 후보의 소규모 품질 평가 완료다. 제품 worker 호출·vector migration/게시·동일 본문 재사용·query 검색·화면·삭제/철회 정리와 전체 회귀 검사는 미실행이다. **Phase 2 전체 완료가 아니다.** 무료 서비스의 데이터 이용 조건을 고려한 제품 제공자·전송 동의 정책을 확정한 뒤 제품 연결을 진행한다.

### Gemini 단일 제공자로 정리

후속 사용자 요청에 따라 OpenAI 전용 adapter와 전용 테스트를 제거했다. 두 제공자가 공유하던 오류 타입도 Gemini adapter 안으로 합쳐 쓰지 않는 추상화를 남기지 않는다. 이전 OpenAI 429 결과·비용 노출 기록과 위 39개 테스트의 과거 실행 기록은 유지하며 현재 검사 명령은 Gemini 테스트만 가리킨다. 사용자 환경 파일·API 키는 수정하지 않는다.

사용자는 후속 질문에서 **개인 자료용 Gemini 유료 등급의 조건 확인 후 연결**을 선택했다. 유료 API는 입력·응답을 제품 개선에 사용하지 않지만 악용 방지 목적의 제한적 보관이 있으므로 보존 0일로 안내하지 않는다. 무료 약관의 민감·기밀·개인정보 전송 제한을 동의 체크박스로 해소하려 하지 않는다. 실제 프로젝트의 유료 전환 확인과 개별 전송 동의 전에는 제품 호출을 켜지 않는다. 키·결제 연결·사용자 env를 이 작업에서 변경하지 않는다. [Google 데이터 조건](https://ai.google.dev/gemini-api/terms#paid-services)

### 4-a: Gemini 결과 게시·공유 예약 정산

유료 등급 선택 후 다음 구현 단위를 벡터 게시와 정산으로 제한한다. consumer의 실제 HTTP 실행·재사용·query embedding·화면 연결은 후속 단위다. 추가 실제 AI 호출 없이 격리 DB와 합성 응답으로 검증한다.

- `0013_embedding_publication`은 1,536차원 vector, owner/work와 owner/material/revision/chunk FK, work/chunk PK, 영벡터 차단을 추가한다. `material_chunks`의 참조 unique를 FK보다 먼저 생성하도록 생성 SQL 순서를 검토했다. `SUCCEEDED` attempt와 내용 없는 호출 비용 receipt도 추가한다. 과거 migration은 수정하지 않으며 개발 DB 적용은 아직 하지 않는다.
- `EmbeddingExecutionService.completeAttempt`가 동일 transaction에서 owner/current/consent/config/reservation/attempt/lease를 재검사하고, 빠짐·중복 없이 ordinal 순서와 일치하는 chunk 벡터만 게시한다. PostgreSQL의 work `PUBLISHED`, attempt `SUCCEEDED`, vector 전체와 비용 기록을 함께 확정한다. 중간 SQL 실패는 모두 rollback한다.
- Gemini 표준 텍스트 단가 $0.20/100만 토큰을 nano-USD로 집계하도록 예약 snapshot에 토큰 단가를 보존한다. 정산은 현재 코드/설정의 가격이 아니라 이 snapshot을 사용하며 단가도 config fingerprint에 포함한다. 사용량과 게시 가능 여부는 별개다. 수정·삭제·철회로 게시하지 못해도 유효한 사용량을 기록한다. 사용량 없는 응답·이전 실패/불명 시도가 하나라도 있으면 예약 전체 상한으로 보수 정산한다. 차원 오류 등으로 벡터를 폐기해도 검증된 사용량은 비용이다.
- 같은 예약의 **모든 work가 terminal**인 경우에만 모든 attempt를 합산해 한 번 정산한다. 한 work 성공으로 다른 work의 예산을 풀지 않는다. 종료된 예약/attempt의 중복 응답은 추가 정산·게시를 만들지 않는다. 재시도·복구도 마지막 terminal 전이에서 같은 정산 규칙을 적용한다.
- 실제 호출 코드 연결 전에는 Gemini 가격·1,536차원·입력 버전·최대 5회 시도를 반영한 활성화 정책을 확정하고 예약 상한이 맞는지 검증해야 한다. 이번 단위는 제품 설정을 활성화하지 않는다.

검증 대상은 실제 DB의 중복 성공 응답 경쟁, 수정/삭제/철회/설정 변경 후 게시 거부, 잘못된 벡터/누락 chunk, 단계별 rollback, 여러 work의 공유 정산, 늦은 응답과 불명 비용 보존이다. 테스트 fixture는 새 두 테이블을 함께 초기화한다. 합성 벡터는 품질 근거가 아니며 앞선 실제 Gemini 평가와 구분한다.

#### 4-a 실행 결과

- `pnpm build:backend` 통과. `pnpm exec vitest run --exclude '**/*.integration.test.ts'`는 11개 파일 112개 검사, `pnpm exec vitest run tests/*.integration.test.ts`는 8개 파일 168개 검사가 통과했다. 실행·게시 검사는 44개이며 예약 후 단가가 바뀌어도 예약 당시 가격을 사용하는 회귀 검사를 포함한다.
- `pnpm exec tsc -p tsconfig.tests.json`, 변경 코드의 ESLint·Prettier 검사, `pnpm lint:architecture`가 통과했다. 동시성 skill에 따라 실제 PostgreSQL 잠금 대기를 관찰하고 중복 게시·rollback 후 최종 행과 정산액을 확인했다.
- `0013`은 격리 Testcontainers에서 적용·검증했다. 개발 DB에는 적용하지 않았다. 실제 AI 호출·유료 전환·환경 파일 변경은 하지 않았다.
- 이번 backend 단위에서는 전체 web build/typecheck, 브라우저·production 이미지 검사를 실행하지 않았다. consumer의 실제 호출, 동일 chunk 재사용, query embedding·hybrid 검색, 화면·보존 연결 뒤 Phase 2 종료 검사로 남긴다.

다음 구현 단위는 4-b의 worker 호출 흐름과 재사용이다. DB commit 뒤 provider를 호출하고 결과를 이번 게시·정산 경로에 전달해야 한다. 유료 프로젝트 확인 전에는 실제 개인 자료 전송을 켜지 않는다. **Phase 2 전체 완료가 아니다.**

## Phase 2 마무리 — 2026-10-01 후속 승인

사용자는 유료 전환 대신 **Gemini 무료 등급으로 개발을 완료**하도록 변경 승인했다. 앞 절의 유료 전환 전제는 이 결정으로 대체한다. 무료 서비스의 제품 개선·사람 검토 가능성과 민감·기밀·개인정보 전송 금지를 화면에 안내하고, 공개 가능한 학습 자료에 대한 명시적 동의 전에는 외부 호출하지 않는다. 무료 할당량을 무한 예산으로 간주하지 않으며 429는 자동 재호출하지 않고 명시적 재시도를 기다린다. 실제 검증에는 합성 자료만 사용한다.

작업 순서와 수용 기준:

1. worker: STARTED commit 후 Gemini 호출, 게시·정산 뒤 큐 완료, 종료 시 호출 취소, 동일 입력의 owner/consent/config 범위 재사용. 외부 호출 중 열린 DB transaction 0건을 확인한다.
2. 활성화: 현재 자료 상태·명시적 실패 재시도, 저장 후 활성화 누락 복구. 철회·삭제·현재 revision fence와 기존 저장 성공은 유지한다.
3. 검색: query 동의·예산 예약과 정산, 준비된 현재 자료의 vector/hybrid 조회, 이유가 표시되는 keyword fallback. 사용자 질의를 DB·로그에 저장하지 않는다.
4. 기존 화면: 무료 데이터 조건과 affirmative consent, 진행/실패/재시도/철회, 검색 모드와 부분 준비 안내. 새 제품 route는 만들지 않는다.
5. 정리·검증: 파생 자료의 즉시 조회 차단·bounded 물리 정리, 실제 DB/Redis/fake-provider 장애와 브라우저·이미지 여정, 문서·OpenAPI/client 일치. 완료 여부는 실제 실행 결과로 판정한다.

주요 대상은 API/worker의 indexing·usage-retention·materials·search, web의 library/search와 생성 client, 공유 schema/migration, 기존 통합·브라우저·이미지 검사다. API query와 worker chunk가 함께 사용할 Gemini 전송·설정은 실제 두 소비자가 생기는 시점에만 공유한다. 개발 DB migration·실제 사용자 자료 전송·결제 설정·배포·Git commit/push는 자동 수행하지 않는다.

### 현재 제품 연결 계약

- `packages/ai`가 API query·worker chunk의 Gemini 전송과 승인 fingerprint를 공유한다. 각 앱의 `GEMINI_API_KEY`가 필요하며 웹에는 key를 넣지 않는다. 실제 env는 사용자 소유로 읽거나 수정하지 않는다. 기동만으로 전송하지 않고 화면의 명시적 동의·활성화 또는 검색 요청이 필요하다.
- 무료 조건 안내는 본문·명시적 검색어만 대상으로 한다. 제목·메모·맥락·URL은 보내지 않는다. API는 targets를 받지만 현재 UI는 개별 선택 checkbox가 아니라 표시된 한 범위의 준비 가능한 자료를 함께 활성화한다. 사용자가 그 범위 전체의 공개 가능 여부를 확인해야 한다. 이번 범위와 활성화 이후 저장·수정한 자료만 처리하며 범위 밖 과거 자료는 scanner로 전송하지 않는다. preview·활성화는 한 번에 최대 20개다.
- worker는 claim token으로 같은 owner/material/config/consent의 동일 chunk 전체 재사용을 먼저 확인한다. 전부 재사용되면 새 vector identity만 게시하고 provider call·attempt·노출은 0건이다. 일부만 일치하면 현재 본문을 호출한다. STARTED commit과 호출 직전 fence 뒤 transaction 밖에서 HTTP를 실행하고 게시·정산을 기다린 뒤 consumer가 반환한다.
- 무료 429는 즉시 최종 실패로 분류해 자동 retry하지 않는다. 실패한 현재 자료의 화면 재시도는 terminal work를 되돌리는 대신 새 request ID·generation을 만든다. 일시 network/5xx만 기존 예약 안에서 최대 5회 시도한다.
- semantic은 명시적 `POST /search/semantic`이며 `q`, `mode`, UUID `requestId`를 받는다. 자동 focus/reconnect/mount 호출은 없다. query 원문·vector는 durable 저장하지 않는다. exact cosine과 RRF(k=60)로 현재 준비된 자료를 합치고 결과는 상위 50개·후속 페이지 없음·`truncated`를 명시한다. 불가하면 `effectiveMode=keyword`와 이유를 돌려준다.
- 표준 단가 기준 제품 참고 예산은 서비스 전체 UTC 월 $0.90이고 평가용 $0.10을 자동 환급하지 않는다. 무료 실제 청구액이라는 뜻은 아니다. 현재 설정은 기동 월에 고정되므로 월 변경 후 두 앱 재시작·새 fingerprint 동의·활성화가 필요하다.
- `0014_embedding_lifecycle`은 durable scanner cursor·vector 정리 시각, `0015_embedding_activation_scope`는 과거 미선택 자료 자동 처리를 막는 활성화 시각을 추가한다. `0016_embedding_retention`은 terminal·예약 종료·cleanup 시각을 추가하며 과거 종료 행은 업그레이드 시각부터 90일을 더 보존한다. 개발 DB에는 자동 적용하지 않는다.

### 보존에 대한 후속 사용자 승인

사용자는 **최소 중복 방지 기록 유지**를 선택했다. 예약 종료·연결된 모든 work의 terminal 전이·모든 attempt 종료가 각각 90일을 넘고 예산 기간이 끝난 경우에 상세 attempt·비용 receipt·예약을 같은 transaction에서 정리한다. 자료가 남아 있는 동안 최소 work ID·intent/generation·config·consent epoch·종료 상태는 보존하고 `reservationId`만 비운다. 본문·질문·벡터를 추가 보관하는 선택이 아니며 이미 끝난 작업이 정리 이후 자동 재실행되는 것을 막기 위한 결정이다. 활성·미정산 기록은 기한만으로 삭제하지 않는다. 월별 예산은 기간 종료 후 90일 및 연결 예약 정리 뒤 제거한다. activation receipt의 과거 응답 상한은 멱등 응답을 위해 유지하며 실제 비용 ledger와 구분한다.

worker의 15초 정리 주기는 Gemini key가 없어도 유지한다. 예약·vector는 각각 최대 100개씩 선점하며 활성화 누락 복구는 최대 20 owner × owner당 20 intent다. 파생 vector는 삭제·철회·설정 fence로 즉시 조회·재사용을 차단한다. 이전 revision의 동일 본문은 같은 현재 자료의 재사용 가능 범위에서만 유지한다. worker가 중단된 시간까지 24시간 물리 정리 완료라고 주장하지 않는다. 원문 revision 보존은 바꾸지 않는다.

### 종료 검사와 남은 사용자 확인

승인된 Phase 2 범위의 구현·종료 검증을 완료했다. 마지막 인증 transport 수정까지 포함한 확정 결과는 다음과 같다.

| 검사 | 2026-10-01 실행 결과 |
|---|---|
| `pnpm typecheck` | 통과 |
| `pnpm build` | 통과 |
| `pnpm openapi:check` | 재생성 후 drift 없음 |
| `pnpm exec vitest run` | 21개 파일 318개 통과, 45.75초; 단위·HTTP·실제 DB/큐 통합 포함 |
| `pnpm lint` | ESLint·형식·아키텍처 검사 통과; 242 modules, 773 dependencies |
| `pnpm test:browser` | 최종 49개 통과, 51.7초; 버튼 대비 회귀 수정·의미 검색 응답 유실 뒤 동일 ID 재요청 포함 |
| 인증 transport 후속 검사 | 동의 철회 POST의 401 복구를 추가하고 27개 통과 |
| `pnpm test:images` | 최종 UI·동의 철회 transport 수정까지 반영해 1개 통과, 약 1.4분 |

처음 합쳐 실행한 검사에서는 fixture/빌드·테스트 동시 실행 문제로 실패가 있었으며 이를 수정하고 선행 빌드 이후 순차 실행으로 위 318개를 확인했다. 브라우저 최초 48개 중 1개의 전환 중 버튼 대비 실패도 수정하고 새 응답 유실 회귀를 포함해 49개를 통과했다. 실패를 skip하거나 성공으로 처리하지 않았다. 실제 PostgreSQL 잠금과 최종 effect를 확인하는 concurrency skill 기준으로 재사용 0-call·명시 재시도·query 동의 경쟁·lifecycle 보존을 검증한다. 검사의 존재가 아니라 위 실제 실행 결과가 완료 근거다.

기존 3회 Gemini 합성 평가는 소규모 품질 근거이고 이번 fake-provider 검사는 정합성·장애 회귀 근거다. 이번 제품 연결 검사에서는 실제 AI 호출을 추가하지 않았으며 서로의 검증을 대체하지 않는다. 브라우저의 검색 응답 fixture도 실제 HTTP/DB semantic 통합과 구분한다.

개발 DB의 명시적 migration 적용과 사용자 키 설정, 본인이 공개 가능한 학습 자료로 동의·활성화·검색하는 수동 확인은 자동 실행하지 않는다. Phase 3 답변 생성, 실제 사용자 개인정보 전송, 유료 전환·cloud 배포는 이번 완료 범위에 포함하지 않는다.

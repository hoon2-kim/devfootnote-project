# Keyword 검색·snippet 측정 기록

이 문서는 2026-09-19~20의 격리 측정 결과를 ADR-0009에서 옮겨 보존한 보고서다. 문서 분리 시 다시 측정하지 않았으며 현재 작업 트리·운영 환경의 성능을 보장하지 않는다. 검색 의미·저장 계약은 [ADR-0003](../adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md), 측정 원칙은 [ADR-0009](../adr/0009-verification-observability-and-search-evaluation.md#성능-평가)가 소유한다.

## 읽는 순서와 현재 재현 경로

- 첫 기록은 저장 tsvector 도입 전 baseline, 다음 기록은 도입 후 비교다. 이전 수치를 현재 지연으로 인용하지 않는다.
- SQL 하네스는 `tests/benchmarks/keyword-search.mjs`이며 현재 조회 구현은 `DrizzleMaterialsQueryRepository.keywordCandidates()`다. 이후 책임 분리에서 경로를 옮겼지만 그 이동의 성능을 새로 측정한 기록은 아니다.
- snippet 하네스는 `tests/benchmarks/search-snippet.mjs`다. 명령과 환경 조건은 각 기록에 남긴다. DB·HTTP를 제외한 snippet 비용과 Repository 지연을 합쳐 실제 사용자 지연이라고 주장하지 않는다.
- 원시 표본은 Git에서 제외한 `test-results/`에 생성된다. 과거 raw 파일이 현재 checkout에 포함된다는 뜻은 아니다. 새 비교에서는 baseline을 보존하고 같은 fixture·환경·결과 동일성을 확인한다.

## Phase 1 keyword 측정 (2026-09-19)

재현: `pnpm bench:search` (Docker 필요). 테스트 전용 PostgreSQL에만 기존 migration과 fixture를 적용하고 종료 시 해당 컨테이너를 제거한다. 구현된 Repository가 생성한 SQL을 캡처해 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`을 실행하므로 별도 단순화 쿼리를 대신 측정하지 않는다. raw 표본·plan·index·설정은 Git에서 제외하는 `test-results/keyword-search.json`에 저장한다.

- 환경: Apple M2 Max/arm64, 호스트 12 CPU·32 GiB, Docker 28.0.4 VM 12 CPU·약 7.65 GiB. 컨테이너 별도 CPU/memory limit 없음. PostgreSQL 17.11/pgvector 0.8.6 고정 이미지, pool max 5, shared_buffers 128 MiB, work_mem 4 MiB, parallel workers per gather 2.
- 자료 1k/10k/20k 각각 현재·과거 revision 한 개씩(20k 자료일 때 keyword 40k행), 조회 owner 80%, tombstone 5%. 약 300–950자 합성 본문, 희소어는 현재 자료의 0.5%, 흔한 단어는 50%. 실제 chunk·AI corpus가 아니라 Phase 1 keyword projection 부하 fixture다.
- 시나리오마다 1회 예열 후 순차 10표본, `인증`은 동시 4요청×10회도 측정. cold cache·HTTP·snippet·사용자 네트워크는 제외한다. p95는 작은 표본의 관찰값이며 SLO·성능 보장으로 해석하지 않는다.

20k 자료의 warm Repository 지연(ms):

| 검색어/조건 | p50 | p95 | keyword 접근 계획 |
|---|---:|---:|---|
| bullmq | 10.15 | 10.73 | full-text + trigram BitmapOr |
| 재시도 | 9.85 | 10.52 | BitmapOr |
| 인증 | 234.71 | 246.82 | 병렬 Seq Scan |
| 큐 | 236.22 | 248.37 | 병렬 Seq Scan |
| bullmq 백오프 | 10.84 | 11.11 | BitmapOr |
| 공통기록 (50% 일치) | 380.41 | 392.12 | BitmapOr, 많은 후보의 점수 계산 |
| 공통기록 400페이지 | 389.94 | 401.53 | 같은 후보·정렬 + OFFSET |
| 과거전용 (현재 결과 0개) | 236.06 | 254.31 | 병렬 Seq Scan, 현재 revision JOIN에서 제외 |
| 인증, 동시 4요청 | 244.58 | 255.39 | 병렬 Seq Scan |

1k→10k→20k에서 `인증` p50은 25.17→119.14→234.71ms, `bullmq`는 1.87→6.71→10.15ms였다. OR 자체가 index 사용을 막는다는 가설은 기각한다. 반면 선행·후행 wildcard를 붙인 짧은 토큰은 추출 가능한 trigram이 부족하며, 이 fixture에서 순차 스캔 비용이 확인됐다. 흔한 단어와 과거 revision도 별도 비용이므로 “짧은 한글만 고치면 검색이 빠르다”고 결론 내리지 않는다.

이번에는 부분 문자열 정확도·정렬·schema를 변경하지 않았다. 후속 최적화는 동일 fixture와 실제 사용 규모를 기준으로 현재/owner 후보 축소·점수 계산 범위를 먼저 비교한다. 짧은 토큰의 FTS-only 전환은 검색 누락 정책이 바뀌므로 별도 승인 대상이다. `word_similarity_threshold` 변경은 현재 LIKE 조건의 해결책이 아니다. 2-gram projection이나 index 추가도 migration·쓰기 비용과 recall 비교가 선행돼야 한다. 반복 측정 없이 SQL만 바꾸거나 이 결과를 의미 검색 품질로 주장하지 않는다.

## 검색 저장 vector·snippet 후속 비교 (2026-09-20)

같은 `pnpm bench:search` fixture·이미지·호스트에서 변경 전과 `0009` 적용 후 실제 Repository를 비교했다. 검색 결과·정렬·추가 한 행을 포함한 27조건은 저장 vector SQL과 기존 `to_tsvector` 표현식 SQL의 반환 행을 대조해 동일함을 확인했다. 비교 SQL은 실제 생성 쿼리의 vector 표현만 치환하고 표본 측정 밖에서 실행한다. 성능 baseline은 이전 표현식 index가 있는 변경 전 실행이며, 신규 실행에서는 저장 컬럼 index만 사용한다. 각 조건 10표본(동시성 조건 40표본), warm cache이며 다른 실행 시점의 비교라 정확한 개선율이나 운영 SLO로 일반화하지 않는다.

20k 자료, 단일 요청·첫 페이지의 Repository 지연(ms):

| 검색어 | 이전 p50 / p95 | 저장 vector p50 / p95 |
|---|---:|---:|
| bullmq | 11.81 / 12.92 | 6.83 / 7.77 |
| 인증 | 238.02 / 249.76 | 23.54 / 25.44 |
| 큐 | 238.57 / 258.61 | 23.58 / 24.58 |
| 공통기록 | 376.77 / 383.31 | 290.47 / 306.62 |
| 과거전용 | 233.13 / 260.46 | 22.43 / 34.35 |

흔한 단어의 similarity 계산과 이력 스캔은 남아 있다. 점수 변경 없이 효과가 큰 저장 vector만 채택하고, owner/current 후보 축소·본문 후조회·current-search projection은 이번에 도입하지 않았다. 상위 N건만 재점수하거나 similarity를 제거하는 것은 순위 변경이므로 별도 결정이다. EXPLAIN의 total-startup 차이를 Sort 자체 시간으로 해석하지 않는다. index 접근 여부와 별개로 행별 함수 계산도 비용에 포함된다.

snippet 재현은 `pnpm build:api` 후 `node tests/benchmarks/search-snippet.mjs`다. Node 24.20.0에서 1k/10k UTF-16 길이, 한글/ASCII/전각/소문자 길이 확장, 앞/중간/끝 24조건을 각각 100회 예열 후 50건×20표본으로 측정한다. raw 표본·CPU·실행 시각은 Git에서 제외한 `test-results/search-snippet.json`에 기록한다. DB·HTTP를 제외한 동기 함수 비용이다.

10k 한글·50건의 p50은 앞 36.38→0.82ms, 중간 41.80→7.30ms, 끝 45.00→10.42ms였다. 전각 끝은 45.11→10.75ms, ASCII 끝은 31.40→3.22ms였다. 전체 grapheme 배열 대신 필요한 경계만 조회해 모든 측정 조건에서 p50이 감소했다. 소문자 길이 확장 문자 `İ`를 10k 가까이 반복한 끝 매칭은 145.11→110.85ms로 개선됐지만 여전히 비용이 크며 일반 본문과 구분해 기록한다. 임의 성능 상한 테스트나 fallback으로 정확도를 바꾸지 않는다.

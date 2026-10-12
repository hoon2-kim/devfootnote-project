---
name: devfootnote-search-benchmark
description: devfootnote 검색 SQL·snippet의 성능을 기존 격리 benchmark로 측정하고 실행계획과 결과 동일성을 검토한다. 검색 지연 진단, 쿼리·인덱스 최적화 검증, benchmark 결과 해석에 사용한다. 검색 UI 문구 수정이나 일반 DB 작업에는 적용하지 않는다.
---

# 검색 성능 측정·검토

검색 결과를 바꾸지 않는 최적화와 검색 의미를 바꾸는 정책을 구분하고, 실제 실행한 경로의 표본·실행계획으로 판단한다. 일반 작업·승인 규칙은 [AGENTS.md](../../../AGENTS.md)를 따른다. 성능 진단 요청만으로 SQL·index·migration·검색 정책을 변경하지 않는다.

## 기준과 측정 경로

명령·아래 코드 경로는 저장소 루트 기준이다. 상대 링크는 이 파일 기준으로 해석한다.

- 검색 계약·owner/current/deleted·정렬: [ADR-0003](../../../docs/adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md).
- 합성 측정·표본·한계: [ADR-0009](../../../docs/adr/0009-verification-observability-and-search-evaluation.md)의 검색 성능 기록.
- SQL: `tests/benchmarks/keyword-search.mjs`와 `apps/api/src/modules/materials/infrastructure/drizzle-materials-query.repository.ts`의 `DrizzleMaterialsQueryRepository.keywordCandidates`.
- snippet: `tests/benchmarks/search-snippet.mjs`, `apps/api/src/modules/search/search-snippet.ts`와 인접 단위 검사.

먼저 현재 manifest와 대상 script를 읽는다. `pnpm bench:search`는 Repository SQL 측정이고 HTTP·snippet·브라우저 전체 지연은 포함하지 않는다. snippet은 `pnpm build:api` 뒤 `node tests/benchmarks/search-snippet.mjs`로 따로 측정한다. 경로·명령이 바뀌었다면 기존 파일을 찾아 확인한다.

## 측정 전 확인

1. **질문을 좁힌다.** 느린 질의·자료량·owner 분포·과거 revision 비율·페이지·본문 길이 중 영향을 의심하는 조건을 정한다. 현재 working tree와 승인된 변경 범위를 확인한다. 과거 문서 수치를 현재 baseline으로 대신하지 않는다.
2. **실행 가능성과 격리를 확인한다.** Docker와 빌드 산출물, migration 경로, fixture의 실제 검색 선택도를 확인한다. schema가 바뀌었다면 seed와 TRUNCATE 대상이 FK 관계와 맞는지도 확인한다. 개발 DB나 실제 사용자 원문을 benchmark에 연결하지 않는다. 하네스가 깨졌으면 환경·fixture 오류로 보고하고, 수정 권한이 없는 경우 측정값 없이 멈춘다.
3. **비교 조건을 고정한다.** fixture seed·이미지/DB 설정·index 상태·자원 제한·pool·동시성·예열·표본 수를 기록한다. 변경 전후는 가능한 같은 환경에서 한 변수만 바꾼다. index 변경 비교는 양쪽 index 상태까지 맞추고, 새 index가 있는 DB에서 표현식만 바꾼 probe를 완전한 이전 버전 baseline이라고 부르지 않는다.

기존 script는 `test-results/keyword-search.json` 또는 `test-results/search-snippet.json`을 덮어쓴다. 이전 측정과 비교할 때는 필요한 baseline을 실행 전에 로컬 전용 기록으로 보존한다. 산출물은 공개 문서에 개인 경로째 붙이지 않는다.

## 실행계획과 결과 해석

- 기존 시나리오에서 희소어, 짧은 한글, 흔한 단어, 여러 토큰, 과거 revision에만 있는 단어, 깊은 페이지를 구분한다. owner·현재 revision·삭제 필터가 적용되기 전 후보 수와 실제 결과 수를 함께 본다. 전 행에 같은 검색어를 넣고 일반적인 선택도라고 가정하지 않는다.
- 실제 Repository가 생성한 SQL·parameter로 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`을 확인한다. JOIN을 뺀 단일 table probe는 원인 탐색용으로 구분하고 제품 경로의 성능 수치로 대체하지 않는다.
- scan/recheck·rows removed·JOIN 전후 행 수·함수 계산·sort/temp·buffer·loops를 확인한다. 부모 노드 시간에는 자식 실행이 포함될 수 있고 `total - startup`을 sort 자체 CPU 시간으로 단정할 수 없다. 인덱스가 있다는 사실만으로 사용 여부나 병목 해소를 판단하지 않는다. 가설은 통제된 비교로 확인한다.
- 작은 표본의 p95, warm cache 결과, 한 번의 실행에서 나온 개선율에는 표본 수와 한계를 붙인다. SQL 지연·snippet 비용·HTTP 지연을 섞거나 합성 결과를 운영 SLO·의미 검색 품질로 주장하지 않는다.
- snippet을 고치면 성능과 함께 기존 NFKC·소문자 길이 변화·여러 토큰·결합문자·이모지 경계 회귀를 확인한다. 정규화된 offset과 원문 offset이 같다고 가정하지 않는다.

최적화 구현이 승인되면 같은 fixture에서 변경 전후 결과 ID·순서·hasNext·owner/current/deleted 제외를 비교한다. 기존 하네스의 표현식 동등성 검사는 한 가지 변환만 다루므로 다른 SQL 변경까지 자동 보장한다고 해석하지 않는다. similarity 제거, 짧은 질의의 FTS-only 처리, 후보 상위 N개 제한은 결과·순위 변경 가능성이 있는 별도 정책이다. 지연 개선만으로 승인하지 않는다.

## 종료 보고

대상 코드·측정 범위, 환경·fixture·표본, 변경 전후 값, 관찰한 plan과 아직 가설인 원인, 결과 동일성 검사, 미실행 항목을 구분해 남긴다. 개선이 없거나 판단하기 어려운 결과도 그대로 보고한다. 검증된 병목이 없으면 index·projection·새 benchmark framework를 선행 추가하지 않는다.

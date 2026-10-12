# devfootnote 구현·검증 계획

## 현재 상태

2026-10-13 추가 승인 작업은 **구현·관련 격리 검증 완료**다. 검색을 단일 입력·명시 hybrid 제출로 통합하고 AI 불가 시 실제 keyword fallback을 알리며, ⓘ 도움말과 짧은 첫 전송 안내를 적용했다. `includeExisting=true`로 기존·미래 자료의 자동 준비를 승인하되 기존 범위 제한 활성화는 보존한다. 질문은 단일 자료 상세 대화로 옮겨 동일 현재 revision의 최근 게시 답변 최대 3개를 서버 검증 후 문맥으로 사용하고, SSE는 처리 상태·검증된 최종 게시 답변만 전달한다. 임베딩은 대화의 선행 조건이 아니며 화면 대화 목록은 메모리에만 유지한다. 7일/90일 보존·미완료 질문 최대 10분, 목적별 동의·예산·owner/revision fence는 바꾸지 않는다.

이번 변경의 검증: `pnpm build:backend`, 웹 build/typecheck, 테스트 타입 검사, ESLint·Prettier·dependency-cruiser(위반 0건)가 통과했다. `answers` 22개·`embedding-activation` 21개·`embedding-lifecycle` 17개·`semantic-search` 12개의 격리 통합 검사와 provider/policy 단위 31개, Playwright 63개가 통과했다. SSE 최초 owner 거부·연결 중 게시·재연결 무재호출, 기존 동의 범위 보존·20건 자동 준비, 모바일/데스크톱 대화·도움말·실패 복구를 확인했다. 전체 이미지 검사·실제 Gemini 재평가·개발 DB migration은 실행하지 않았다. 로컬 실행 전에 `0021_automatic_existing_materials.sql` 적용이 필요하다. 자료 밖 질문과 프롬프트 공격 차단의 실제 모델 정확도를 fake provider 회귀 결과로 주장하지 않는다.

상태 기준: 2026-10-07. Phase 2의 10월 1일 완료 기록과 이후 리뷰 보완을 구분한다. [Phase 3~4 작업 기록](plans/2026-10-06-phase3-4-completion.md)의 코드·격리 검증과 실제 답변 3건 smoke를 완료했고 사용자 승인으로 제품 답변 설정도 연결했다. 로컬 DB 적용·수동 확인은 사용자가 진행한다. Phase 5의 동결 품질 평가나 Phase 6 배포 완료를 뜻하지 않는다.

| 범위 | 상태 | 근거·다음 경계 |
|---|---|---|
| Phase 1 인증·자료 CRUD·keyword 검색 | 완료 기록 있음 | [당시 검증 결과](plans/2026-09-21-phase1-completion.md); 이후 변경은 해당 회귀 결과로 판단 |
| Phase 2의 0~1단계 공유 DB·큐·claim | 구현·검증 기록 있음 | [기반 기록](plans/2026-09-21-phase2-foundation.md); claim은 임베딩 완료가 아님 |
| Phase 2의 2단계 동의·예산·활성화 | API·DB 구현·검증 기록 있음 | [당시 활성화 기록](plans/2026-09-22-phase2-activation.md); 후속 무료 정책·화면과 연결 |
| Phase 2의 3단계 attempt·retry·lease 복구 | provider-free 범위 구현·검증 완료 | [당시 실행·복구 결과](plans/2026-09-22-phase2-recovery.md#실행-결과); 후속 consumer가 provider 실행을 조합 |
| 실제 provider·vector 게시·의미 검색·화면·정리 | Gemini Free 승인 범위 구현·종료 검증 완료 | 개발 DB 적용·사용자 환경의 수동 확인은 별도; [완료 기록](plans/2026-09-30-phase2-provider-gate.md#phase-2-마무리--2026-10-01-후속-승인) |
| Phase 3~4 답변·화면 완결 | 코드·격리 검증·실제 3건 smoke 및 설정 활성화 완료 | 기존 종료 검사와 실제 합성 smoke 3/3; 후속 활성화의 설정/답변 29개 회귀 통과. 개발 DB 적용·수동 확인은 별도 |
| Phase 5~6 최종 평가·배포 | 후속 범위 | 각 phase의 gate와 별도 승인 필요 |

OpenAI 첫 실제 평가 요청은 HTTP 429로 중단했고 이후 실행 코드를 제거했다. Gemini 합성 평가의 3회 호출은 vector/hybrid Hit@5 20/20, 제외 조건 위반 0건으로 개발 품질 gate를 통과했다. 이후 잠시 선택했던 유료 등급 전제는 사용자의 **Gemini Free로 Phase 2 완료** 요청으로 대체했다. 공개 학습 자료에만 명시적으로 동의·활성화하며 민감·기밀·개인정보는 보내지 않는다. 4~6단계의 worker 호출·동일 입력 재사용, query 검색·기존 화면, bounded 정리와 종료 검증을 완료했다. 단위·통합 318개, 브라우저 49개, 최종 이미지 1개 및 타입·빌드·lint·OpenAPI 검사가 통과했다. 이전 실제 품질 평가와 이번 격리 DB·Redis·fake provider 회귀 검사는 서로 다른 근거다. 이번 제품 연결 작업에서 실제 AI 호출을 추가하거나 개발 DB migration을 적용하지 않았다.

2026-10-07 사용자 요청의 [제품 화면 통일](adr/0006-frontend-information-architecture-and-design.md#제품-화면-통일--2026-10-07)은 로그인 배치를 유지하고 자료함·검색·읽기·작성·AI 보조 패널에 적용했다. `pnpm exec playwright test` 58개, web build/typecheck, 변경 범위 ESLint·Prettier, 테스트 TypeScript와 dependency-cruiser(위반 0건)가 통과했다. 320·768·1280px 화면과 키보드·접근성·오류 복구를 기존 브라우저 여정으로 확인했으며 질문 접기/펼치기의 초안 보존·AI 호출 없음도 추가 검증했다. 이번 UI 변경에서 전체 백엔드 통합·이미지 검사는 재실행하지 않았고 실제 AI 호출·개발 DB 변경은 하지 않았다.

2026-10-11 후속 UI 간소화는 반복 설명·참고 예산 표시·동의 checkbox/별도 승인 버튼을 제거하고 첫 전송 액션으로 통합했다. 서버의 동의·예산·멱등성은 유지했다. 공통 버튼·화살표/번호 페이지 이동과 검색 radio 선택을 적용했고 [화면 결정](adr/0006-frontend-information-architecture-and-design.md#작업-화면-간소화--2026-10-11)·ADR-0008·spec을 맞췄다. `pnpm exec playwright test` 59개, web build/typecheck, 변경 범위 ESLint·Prettier, 테스트 TypeScript와 dependency-cruiser(272개 모듈, 위반 0건)가 통과했다. 첫 답변 승인 실패에서 생성 0건·같은 승인 재시도, 전송 전 명시 동작, 끄기, 페이지 번호·URL·실제 결과, 검색 방식의 마우스/키보드를 확인했다. 전체 백엔드 통합·이미지 검사와 실제 AI 호출은 실행하지 않았다. API의 total count 계약은 변경하지 않았다.

## 1. 목적과 실행 경계

2026-10-13 사용자 요청 후속 검증: 삭제 버튼에 공통 destructive 색상, 검색에 숨길 수 있는 오른쪽 질문 drawer, 자료 목록에 `pageSize`·`totalCount`와 정확한 번호 이동을 연결했다. OpenAPI/SDK를 재생성했으며 자료 통합 검사 13개, 전체 브라우저 검사 59개, backend/SDK/web build, web typecheck·테스트 tsc, 변경 범위 ESLint·Prettier, dependency-cruiser(272개 모듈·위반 0건)가 통과했다. 320/1280px 질문 화면과 삭제 버튼 스크린샷을 확인했다. 생성 중 접기/다시 열기에서 추가 호출이 없고, 중첩 철회 창의 Escape가 질문 drawer까지 닫지 않는 것을 회귀 검사했다. 전체 backend 통합·이미지 검사·실제 AI 호출은 실행하지 않았고 개발 DB·환경 파일은 변경하지 않았다. migration은 필요하지 않다.

[`spec.md`](spec.md)가 제품 요구사항(`F-*`), 수용 기준(`AC-*`)과 non-goal(`NG-*`)의 유일한 선언 소유자다. 이 문서는 의존 순서와 검증 시나리오(`V-*`)만 선언한다. 기술 결정은 [ADR 기준선](#2-adr-기준선)이 소유한다.

Phase 1 인증·자료 CRUD·keyword 검색을 유지하며 Phase 2의 승인된 비동기 처리·의미 검색 범위를 완료했다. 검증 결과는 아래 완료 기록을 따르고 파일·script의 존재는 해당 gate 통과를 뜻하지 않는다. 문서 전환 당시의 제품·Git 작업 금지(`ref:NG-06`, `ref:NG-07`)는 문서 승인만으로 제품 작업을 시작하지 않는 경계다. 문서 수정·리뷰 요청에서 진행 중인 제품 코드, dependency, DB나 인프라를 임의로 변경하지 않는다. Git 작업도 별도 명시적 승인 없이 수행하지 않고, AI 호출과 Phase 6 배포는 각자의 gate·승인을 유지한다.

역사적 인증 교체는 spec의 단일 trace인 `integration:github-oauth` → `integration:google-oauth`만 참조한다. 그 밖의 이전 제품 의미, ADR 또는 부록은 이 계획의 입력이나 구현 단계가 아니다.

## 2. ADR 기준선

각 링크는 최종 canonical 파일명을 정확히 사용한다.

1. [ADR-0001: Monorepo and package boundaries](adr/0001-monorepo-and-package-boundaries.md)
2. [ADR-0002: Modular monolith domain ownership](adr/0002-modular-monolith-domain-ownership.md)
3. [ADR-0003: PostgreSQL, pgvector, Drizzle, revisions and search](adr/0003-postgresql-pgvector-drizzle-revisions-and-search.md)
4. [ADR-0004: BullMQ embedding delivery, retry and fencing](adr/0004-bullmq-embedding-delivery-retry-and-fencing.md)
5. [ADR-0005: Passport Google login and access/refresh JWT](adr/0005-google-login-and-sessions.md)
6. [ADR-0006: Frontend information architecture and design](adr/0006-frontend-information-architecture-and-design.md)
7. [ADR-0007: OpenAPI client and frontend state boundaries](adr/0007-openapi-client-and-frontend-state-boundaries.md)
8. [ADR-0008: AI provider consent, budget, grounding and retention](adr/0008-ai-provider-consent-budget-grounding-and-retention.md)
9. [ADR-0009: Verification, observability and search evaluation](adr/0009-verification-observability-and-search-evaluation.md)
10. [ADR-0010: AWS Terraform decision gate](adr/0010-aws-terraform-decision-gate.md)

ADR-0001 defines the package DAG; ADR-0002 owns entity/transition boundaries and public ports; ADR-0003 owns atomic save, revisions and search data; ADR-0004 owns async delivery and fencing; ADR-0005 owns Google OAuth/access/refresh JWT; ADR-0006 owns screens/design/accessibility; ADR-0007 owns API/client/frontend state; ADR-0008 owns AI/privacy/usage; ADR-0009 owns evidence and observability; ADR-0010 owns the Phase-6 decision gate. This plan sequences those owners without redefining them.

## 3. 의존 순서와 단계

원칙은 **작게 동작하는 제품 → 신뢰 가능한 비동기 확장 → 선택적 AI → 운영 증거 → 배포 결정**이다. 각 phase는 이전 phase의 usable behavior를 보존하며, optional subsystem을 추가하려고 핵심 저장·keyword·읽기 경로를 깨지 않는다.

### Phase 0 — 별도 제품 승인과 최소 scaffold

초기에는 web/API/생성 client와 PostgreSQL 기반만 구성한다. 현재 완료된 단계의 도입 순서를 보존한 설명이며 worker·Redis를 제거하거나 scaffold를 다시 만들라는 지침이 아니다.

- pnpm·Turbo의 실제 task, 생성 타입·cache 입력, 호스트 개발·앱 이미지 경계는 ADR-0001을 따른다.
- 기능별 모듈·공개 경계는 ADR-0002, DB 연결 수명주기·명시적 migration은 ADR-0003을 따른다. DB 연결·migration을 build의 숨은 선행 작업으로 넣지 않는다.
- 최소 HTTP envelope·OpenAPI/SDK는 ADR-0007, PostgreSQL 기반 ready와 DB 없는 live·안전한 로그·격리 테스트는 ADR-0009를 따른다.
- 해당 단계에 필요한 검사만 연결하며 다음 phase의 빈 worker·AI 코드·실패 테스트를 선행 생성하지 않는다. 초기 구현과 이후 구조 변경의 당시 기록은 Phase 1 이력과 모듈 개편 기록에서 구분한다.

Gate: `ref:AC-09`, `ref:AC-11`의 현재 구현 subset DAG/API 경계를 `ref:V-09`로 증명한다. 다음 phase의 acceptance를 미리 작성·실패시키는 것은 Phase 0 완료 조건이 아니다. 최종 허용 graph에 아직 없는 worker·feature를 빈 placeholder로 만들지 않는다. 로컬 전용 `docs/evidence/phase0/`의 2026-09-15 보존 기록은 단순화 이전의 probe·로그·API 연결 화면 계약을 검증한 기록으로 현재 gate의 통과 근거가 아니며, 새 실행 결과로 판단한다. 과거의 다음 phase red-test 기록도 당시 증거로 보존하되 현재 필수 검사나 기능 구현 증거로 사용하지 않는다.

### Phase 1 — 로그인부터 저장·keyword 검색·읽기까지

Google 로그인부터 자료 생성·수정·삭제, keyword 검색과 현재 원문 읽기까지 AI 없이 사용하는 첫 완결 여정이다. 구현·검증의 날짜별 결과와 미실행 범위는 [Phase 1 완료 기록](plans/2026-09-21-phase1-completion.md), 당시 구조 변경은 [모듈 개편 기록](plans/2026-09-18-api-module-reorganization.md)에 보존한다.

- 인증·세션·CSRF·owner 격리와 일시 장애/terminal 인증 복구는 ADR-0005/0007을 따른다.
- 저장 원자성·멱등성·변경 없는 저장·revision CAS·현재 자료 검색은 ADR-0003을 따른다. 실제 DB에서 부분 저장과 stale 결과 노출을 배제한다.
- 생성 SDK와 세 제품 화면, 안전한 원문 읽기·접근성은 ADR-0006/0007을 따른다.
- 실제 Passport와 Google 외부 응답 fixture, 격리 PostgreSQL·브라우저·HTTPS 앱 이미지로 검증한다. 사용자 개발 DB·비밀값·volume을 재사용하지 않는다.
- 이 단계의 로컬 이미지 검증은 실제 배포 도메인·공인 인증서·클라우드 운영 완료를 뜻하지 않는다.

Gate: `ref:AC-01`–`ref:AC-04`, `ref:AC-08`의 core path가 `ref:V-01`–`ref:V-05`로 통과하고, `ref:V-09`의 현재 구조·이미지 실행 검증을 통과해야 한다.

### Phase 2 — AI 도입 gate, embedding과 hybrid 검색

#### 구현 순서와 현재 승인 범위

| 순서 | 작업 단위 | 현재 범위 |
| --- | --- | --- |
| 0 | embedding 입력·work 단위·공유 코드·transaction 경계 확정 | 결정 기록 있음 |
| 1 | 전체 DB 패키지 승격, Redis/BullMQ 전달, worker 원자 claim | 구현·검증 기록 있음 |
| 2 | 동의·예산·명시적 활성화와 work 생성의 동일 transaction | 기반 검증 기록 있음, 무료 정책·기존 화면 연결 승인 |
| 3 | attempt·retry·lease 만료·repair·철회/삭제 fence | provider-free slice 구현·검증 완료 |
| 4 | provider 승인·vector schema·fenced publication·동일 chunk 결과 재사용 | Gemini Free 승인 범위 구현·검증 완료 |
| 5 | query embedding·hybrid 검색·기존 화면 연결 | 구현·통합·브라우저 검증 완료 |
| 6 | 삭제·철회 정리와 Phase 2 종료 검증 | 최소 중복 방지 기록 보존·bounded 정리·종료 검사 완료 |

0단계 결정: 임베딩 입력은 immutable chunk 본문 text다. 제목·메모·맥락·출처는 keyword 대상이며 embedding 입력에는 포함하지 않는다. 작업은 revision/config/consent/generation 단위로 조율하고 실제 provider attempt·비용 노출은 별도로 기록한다. 본문 처리 버전과 provider/model/version/dimension이 포함된 동일 입력 결과만 같은 owner의 유효한 범위에서 재사용한다.

1단계 구현: `packages/db`에 전체 schema·migration·Kit·연결 팩토리를 모으고 `packages/queue`에 work ID 전달 계약을 둔다. API indexing은 lazy producer, worker indexing은 consumer와 PG claim을 소유한다. 당시 work 생성·자동 enqueue는 연결하지 않았다. claim 메시지의 완료는 LEASED 전이 결과일 뿐 AI 성공이 아니며, LEASED 이후 실행·만료 복구는 다음 단계다. 구현·검증 범위는 [0~1단계 기록](plans/2026-09-21-phase2-foundation.md)을 따른다. Phase 2 전체 완료를 뜻하지 않는다.

2단계 당시 구현 범위: owner-scoped preview(최대 20건·cursor), 명시적 동의·철회, 공유 기간 예산의 정수 비용 예약, 멱등 활성화 receipt와 work 생성을 연결했다. 같은 DB transaction에서 current revision·동의 epoch·설정을 확인하고 commit 뒤 Redis로 전달한다. 당시에는 승인 설정이 없어 제품 활성화를 거부하고 합성 설정으로만 검증했다. 파일과 당시 검증은 [2단계 기록](plans/2026-09-22-phase2-activation.md)을 따르며 현재 정책·화면 범위는 후속 승인 기록을 따른다.

3단계 당시 승인 범위는 provider 없는 실행 시도·실패 분류·최대 5회 retry, LEASED/CALLING 만료 복구와 bounded repair였다. worker의 공개 Service가 같은 named CLS transaction에 참여하고 STARTED·예약 노출을 원자적으로 기록한다. 당시 consumer는 claim-only였으며 `0012`는 vector·provider·정산·명시 재시도·화면을 포함하지 않았다. [3단계 기록](plans/2026-09-22-phase2-recovery.md#실행-결과)은 당시 검증 근거이고 현재 제품 범위는 아니다. 4~6단계에서는 무료 429를 자동 retry에서 제외하고 게시·비용 정산 및 화면까지 연결한다.

4~6단계의 세부 수용 기준과 실제 검사 결과는 [마무리 기록](plans/2026-09-30-phase2-provider-gate.md#phase-2-마무리--2026-10-01-후속-승인)에 모은다. 현재 선택 자료와 활성화 이후 새 저장·수정만 자동 처리하며, 과거 미선택 자료·terminal work를 자동 재실행하지 않는다. semantic 검색은 명시적 POST 한 번으로 상위 50개를 제공하고, 90일 상세 이력을 정리한 뒤에도 최소 terminal work 식별자를 남겨 중복 호출을 막는다.

기반 단계와 이후 공통 책임 정리의 실행 결과는 [0~1단계 기록](plans/2026-09-21-phase2-foundation.md)과 [2단계 후속 기록](plans/2026-09-22-phase2-activation.md#동시기-후속-정리-기록)에 보존한다.

**불필요한 임베딩 재처리 감소**는 이 phase의 입력·worker 설계에 포함한다. Phase 1의 변경 없는 저장은 새 intent 자체를 만들지 않는다. 실제 내용이 바뀐 revision은 보존하되, 어떤 필드·전처리·chunk 구성을 provider 입력으로 쓰는지 먼저 확정하고 동일 입력 결과의 재사용을 설계한다. 재사용 식별에는 실제 입력과 provider/model/version/dimension·입력 처리 설정을 포함하며 material 전체 fingerprint나 "사소한 수정" 여부만으로 판단하지 않는다. 같은 owner의 허용된 결과 범위부터 검토하고 새 revision/chunk 연결·현재 revision·삭제·consent/config/lease fence를 유지한다. 입력·설정 불일치와 철회/삭제 결과의 재사용 금지, 재사용 시 provider 0-call을 검증한다. 글로벌 cache·계정 간 공유·query 원문 보존을 선행 추가하지 않는다. 입력 경계 결정은 0단계에 기록했고 실제 결과 재사용은 4단계의 후속 구현 범위다.

외부 호출 없는 immutable intent와 queue·state-machine slice를 먼저 만든다. Phase 0·1에서 AI 설정 없이 저장한 현재 revision intent도 보존하되 indexing work를 만들거나 Phase 1을 막지 않는다. 첫 실제 chunk 또는 검색 질의 embedding 호출 전에 provider/model/version/dimension, 단위 가격과 호출별 최대 비용, provider retention/private-data 조건을 품질·privacy·비용 evidence로 비교해 별도 승인하고 exact configuration fingerprint를 고정한다. 같은 gate에서 `embedding` purpose의 명시적 consent, budget reservation/settlement, 철회와 provider 0-call negative를 먼저 검증한다.

그 뒤 기존 `/library` 또는 `/search` 안에 의미 검색 활성화·현재 자료 재시도 동작을 추가하고 1단계의 worker/큐 기반에 lease/retry/final state, repair와 fenced PostgreSQL publication을 연결한다. 활성화는 current revision·config·consent epoch·budget을 확인하고, AI 설정 전에 저장한 intent 또는 재동의된 intent에 새 indexing work를 bounded batch로 만든다. terminal work는 변경하지 않으며 activation idempotency와 active-work unique constraint로 반복 요청의 중복을 막는다. 새 settings/운영 화면이나 범용 재색인 시스템은 만들지 않는다.

0~1단계에서 로컬 `docker-compose.yml`의 Redis와 worker Dockerfile·`app` profile을 도입했다. 평소 API와 worker는 호스트의 별도 pnpm·Turbo 개발 프로세스로 실행하고 이미지 기동은 격리 검사로 확인한다. consumer·processor·scheduler는 worker에서만 등록하고 공유 backend Module을 사용하는 API에서는 시작하지 않는다. Redis가 시작부터 없거나 실행 중 중단되어도 API 기동과 core 경로는 유지되어야 한다. 자동화된 큐·경쟁 테스트는 개발 Redis나 PostgreSQL을 재사용하지 않고 Testcontainers로 격리한다.

문서 chunk embedding과 검색 질의 embedding 모두 같은 consent/budget/provider gate를 통과한다. 질의 원문은 필요한 호출에만 transient하게 전송하고 durable usage/telemetry에는 저장하지 않는다. vector/hybrid는 준비된 현재 revision만 사용하며 query embedding 실패·미동의·예산 차단은 설명 가능한 keyword fallback으로 끝난다.

이 단계부터 비동기 attempt·재시도·fence 실패를 실제로 조사하는 데 필요한 structured log와 correlation을 추가한다. ADR-0009의 개인정보 차단을 유지하고 전체 분산 추적·자동 계측은 관측 필요가 확인되는 구간부터 도입한다.

Gate: `ref:AC-05`, `ref:AC-07`, `ref:AC-08`을 `ref:V-06`, `ref:V-08`로 통과하고 Phase 1 journey가 Redis-down 또는 provider-blocked 조건에서도 계속 통과해야 한다. `ref:V-09`의 worker 전용 등록·이미지 기동과 optional dependency 분리도 확인한다.

### Phase 3 — 명시적 근거 답변

`answers`가 공개 port를 통해 `usage-retention`의 consent/budget reservation과 표시 가능한 evidence snapshot을 pre-call transaction에서 결합해 `RESERVED`를 commit한다. 별도 claim transaction이 `RUNNING`과 call-attempt `STARTED`를 기록한 뒤 provider를 모든 DB transaction 밖에서 호출한다. post-call은 owner/request/reservation/consent/current revision/deletion/expiry를 다시 확인하고, answer/citation 게시 가능 여부와 실제·불명확 비용의 settlement를 독립적으로 exactly-once 결정한다.

timeout, 429, malformed output, invalid citation, 호출 전 crash, 호출 시작 후 결과 불명 crash, late/duplicate result와 compensation/expiry를 구현한다. 응답 저장 뒤 HTTP 응답이 유실되어도 같은 owner·request ID·fingerprint 재요청은 유효한 저장 결과를 추가 호출 없이 반환하고, 다른 fingerprint는 충돌한다. 재조회 시에도 revision·삭제·동의·만료를 검사하며 answer body TTL과 더 긴 dedupe receipt TTL을 분리한다.

Gate: `ref:AC-06`, `ref:AC-07`, `ref:AC-08`을 `ref:V-07`, `ref:V-08`로 통과하고 provider 0-call negative를 evidence로 남긴다.

### Phase 4 — 화면 완결과 접근성·보안 hardening

세 화면의 empty/loading/error/conflict/degraded/recovery와 답변 lifecycle을 완결한다. [`../DESIGN.md`](../DESIGN.md)의 hierarchy를 ADR-0006의 화면별 글꼴·브랜드와 devfootnote semantic token으로 적용하되 금지 brand asset을 포함하지 않는다. keyboard/focus return, label/error association, ARIA announcement, reduced motion, 44×44 touch, tablet navigation collapse와 mobile single-column을 실기기 크기에서 닫는다. JWT expiry·refresh/logout 복구, CSRF, A/B owner isolation과 retention cleanup을 함께 harden한다.

Gate: `ref:AC-01`, `ref:AC-02`, `ref:AC-07`, `ref:AC-10`을 `ref:V-02`, `ref:V-03`, `ref:V-08`, `ref:V-10`, `ref:V-12`로 통과한다.

### Phase 5 — 평가, 관측성과 운영 복구

20-case development corpus로 failure taxonomy를 찾은 뒤 32 grounded+8 ungrounded의 frozen 40-case final corpus를 평가한다. keyword/vector/hybrid의 Hit@1/5와 multi-evidence recall, 답변 grounded/valid/false-answer ratio를 기록한다. 1k/10k chunk 성능은 hardware, memory, dimension, cache, query plan, p50/p95와 provider 구간을 분리하고 한 번에 한 변수만 바꾼다.

Pino/OpenTelemetry는 request→intent→delivery→publication/answer를 content 없이 연결한다. PostgreSQL은 readiness 필수, Redis/AI는 degraded로 분리한다. 저장·검색·queue·answer의 baseline을 얻기 전 SLO를 선언하지 않는다. restore, cleanup, repair와 redaction rehearsal을 수행한다.

`app` profile의 전체 앱 이미지에서 중지·재시작과 worker SIGTERM을 검증한다. 새 claim 중단, 진행 중 작업의 제한된 종료 대기, DB/Redis 연결 정리와 강제 종료 뒤 lease·repair·revision fence 복구를 확인한다. PostgreSQL named volume은 일반 재시작으로 지우지 않으며 destructive reset과 복구 실험은 검증 소유의 별도 자원에서만 수행한다. 이미지 빌드·smoke 결과를 transaction·queue 경쟁 테스트의 대체 증거로 사용하지 않는다.

Gate: `ref:AC-09`, `ref:AC-12`를 `ref:V-09`, `ref:V-11`, `ref:V-12`로 통과하고 모든 앞선 regression을 닫는다.

### Phase 6 — AWS 비용·Terraform 결정 gate

제품 구현과 Phase 5 evidence가 모두 끝난 뒤에만 ADR-0010에 따라 최소 세 후보 A/B/C를 같은 workload로 비교한다. A/B/C는 식별자일 뿐이며 실제 service·배치 조합은 그때 정한다. 이 phase를 여는 별도 승인 전에는 region, SKU, topology 또는 IaC를 선택·생성하지 않는다.

후보별 workload·공식 가격·환율·세금·여유분과 서비스 전체 월 30,000원 상한의 계산식은 ADR-0010을 따른다. 이 문서에서 별도 계산식·가격 가정을 재정의하지 않는다. 두 검토자의 재계산 일치, 비용·용량·복구 조건 통과 뒤에도 배포 승인은 별도로 필요하다.

Gate: `ref:AC-13`을 `ref:V-13`으로 통과한 뒤 별도 승인에서만 ADR-0010의 deferred decision을 갱신한다.

## 4. 검증 선언

각 `V-*`는 이 절에서만 선언한다. 다른 위치는 `ref:V-*`로만 참조한다. Infrastructure behavior는 실제 PostgreSQL 또는 Redis/BullMQ evidence가 필요하며 mock은 provider/browser 경계 격리에만 사용한다.

| ID | 선언 | Evidence |
|---|---|---|
| `V-01` | route inventory와 component/browser 시나리오가 `/login` entry 및 정확히 세 제품 route의 모든 적용 가능한 normal/empty/loading/error/conflict/degraded/recovery 상태와 OpenAPI client 경계를 검증한다. API contract는 공통 성공 envelope 1회 적용, 오류 status/error/message·검증 errors, redirect/204 등 본문 없는 응답과 제품 API의 generated schema 일치를 확인한다. 최소 health는 ADR-0007에 따라 실제 일반 JSON·상태 코드·SDK 호출을 확인하며 unknown 본문 타입을 허용한다. | route inventory, Supertest, RTL/MSW, Playwright |
| `V-02` | Google token/profile 요청만 fixture로 제어하고 실제 Passport Strategy/Guard의 서버 code 교환·profile 조회·callback/method 설정과 대표 실패를 검증한다. OAuth state의 난수·브라우저 binding·TTL·원자 소모·재사용 거부, Google profile 검증 전 account/refresh 쓰기 0건, 첫 로그인 계정 생성·재로그인 재사용·서로 다른 Google 계정 분리를 실제 PostgreSQL·HTTP로 확인한다. 브라우저 여정에서는 Google provider token의 browser/DB 보존 0건 및 서비스 JWT의 HttpOnly cookie 외 노출 0건을 구분한다. | integration DB rows, 정제된 browser storage/network 검사 결과; token 원문을 evidence로 보존하지 않음 |
| `V-03` | JWT의 별도 key·용도·issuer/audience/subject·만료, access 만료 후 refresh, 15분/고정 7일 expiry, 실제 DB의 계정별 회전 CAS 단일 성공·재사용 거절·logout 경쟁과 다른 계정 refresh 비변경을 검증한다. 기존 access의 잔여 유효성·rotation 응답 유실·실패 refresh의 cookie 비변경도 확인한다. CSRF bootstrap·서명된 token과 binding의 일치/거절, exact Origin·cookie flags·로그인 갱신/refresh 유지/logout 삭제와 JWT의 JSON 노출 0건을 확인한다. unsafe GET·production bypass 부재와 프론트 bounded 재전송을 유지한다. | 실제 PostgreSQL+Supertest, controllable clock/barrier, MSW와 browser E2E |
| `V-04` | 검토된 Drizzle Kit SQL migrations를 적용한 실제 PostgreSQL에서 Drizzle로 atomic save, idempotent replay, same-key/different-input conflict, expected-revision CAS, concurrent update/delete와 immutable old revision을 검증한다. ORM·parameterized SQL 연산이 같은 transaction handle을 사용하고 단계별 실패·CAS 충돌 시 all-or-none rollback되는지 확인한다. 빈 DB forward·이전 schema upgrade, 실제 FK/unique와 필요한 raw 결과 변환·DB 오류 분류도 ADR-0003에 따라 검증한다. | Testcontainers PostgreSQL+Drizzle transaction/constraint evidence, reviewed SQL migration/metadata artifact |
| `V-05` | owner A가 Redis/AI 없이 저장 직후 한영 keyword로 current material을 찾아 메모·원문·source를 읽고 owner B·deleted·old revision 결과는 0건임을 검증한다. | PostgreSQL integration+E2E; A/B test identities |
| `V-06` | 승인된 provider/model/version/dimension fingerprint와 embedding consent/budget이 없으면 AI 설정 전 저장한 intent를 보존하면서 chunk·query provider call과 indexing work가 0건인지 검증한다. 최초 설정·동의, 재동의와 현재 자료 재시도는 current revision만 대상으로 terminal work를 변경하지 않고 새 work를 만들며, 같은 activation request와 active config/epoch 반복은 중복 work 0건이어야 한다. 실제 Redis/BullMQ+PostgreSQL에서는 enqueue/claim/call/publish/ack crash, queue loss, restart, bounded retry/final failure, repair, lease expiry와 late-worker race를 검증하고 PostgreSQL publication만 effect evidence로 인정한다. query 원문은 durable usage/telemetry에 0건이어야 한다. | configuration/consent receipt, activation idempotency rows, provider call ledger, Testcontainers crash matrix and durable publication receipts |
| `V-07` | fake provider와 실제 DB가 `REQUESTED → RESERVED → RUNNING → terminal` 전이, call-attempt 시작 기록, provider-outside-transaction, 호출 전 crash의 무비용 release와 호출 시작 후 결과 불명의 보수 정산을 구분해 검증한다. 응답 저장 뒤 HTTP 유실 재요청은 같은 owner/request/fingerprint에 저장 결과를 반환하고 추가 호출·charge가 0건이며 다른 fingerprint는 충돌한다. 재조회 revision/delete/consent/expiry fence, exact citation, no-answer, timeout/429/malformed output과 분리된 answer/dedupe TTL도 검증한다. | PostgreSQL integration, controllable crash barriers, connection observation, provider call ledger |
| `V-08` | consent default-off, budget/policy negative, revoke/delete/revision/expiry races와 duplicate result에서 금지된 새 provider call·answer publish·double settlement가 0건인지 검증한다. publication 차단과 비용 exposure 정산은 독립 decision table대로 exactly-once 처리되고 AI 파생 자료는 즉시 inaccessible·24시간 내 deleted여야 한다. | call/settlement ledger, DB-clock race matrix, retention evidence |
| `V-09` | ADR의 package/feature graph를 최종 허용 상한으로 사용하고 각 phase의 node·edge가 그 부분집합인지 검사한다. 공개 Nest Module·명명된 업무 Service 메서드는 허용하되 cycle, frontend→backend runtime, feature deep import, cross-private repository/schema, 공개 경계를 우회하는 rule/schema 접근과 generic bypass coordinator는 거부한다. API에서 consumer·scheduler가 기동되지 않고 PostgreSQL-down readiness 실패와 Redis/AI 없이 API 기동·core 지속이 구별되어야 한다. 최소 Turbo task·cache 정책, `docker-compose.yml`의 단계별 서비스·healthcheck·loopback 연결, 호스트 개발 및 `app` profile의 image build/runtime smoke, same-origin HTTPS 인증, 재시작 후 데이터 보존과 worker 종료·복구를 현재 phase 범위에서 확인한다. 후속 공유 패키지는 실제 consumer와 owner를 확인하고 허용 graph를 갱신한다. | phase-aware dependency graph test, API/worker integration probes, task graph 확인, 로컬·CI image build/smoke와 데이터 보존·종료 기록; 세부 검증은 ADR-0001/0009 |
| `V-10` | ADR-0006의 화면별 글꼴·브랜드·semantic token을 실제 브라우저에서 검증한다. 사용하는 색 조합의 AA contrast, non-color cue, `ink-faint` 제한, labels/names/errors/announcements, keyboard/focus return, reduced motion, 44×44, tablet/mobile reflow 및 금지 identity/asset 0건을 확인한다. 별도 토큰 수식 보고서를 필수 산출물로 요구하지 않는다. | 접근성 assertions, Playwright/axe, screenshots/interaction |
| `V-11` | versioned 20-case development와 frozen 40-case final corpus가 Hit@1/5, multi-evidence recall, grounded/valid/false-answer ratio를 재현하고, 별도 1k/10k run이 latency/cost/resource 조건과 한 변수 비교를 기록한다. | corpus hash, raw result artifact, evaluation report |
| `V-12` | redaction fixtures와 cleanup/restore rehearsal이 content·prompt·answer·provider response·secret·token·source query의 telemetry 0건, bounded pseudonym label, retention deadlines와 recovery를 검증한다. | log/trace/metric scan, DB retention receipts, restore report |
| `V-13` | 두 검토자가 모든 사용자의 workload·AI 최대 비용을 합산한 동일 official-price worksheet를 독립 재계산해 동일 `finalTotalKRW`/gate를 얻으며 누락 line, stale/unknown source, 월 서비스 전체 30,000 KRW 초과, memory margin 부족 또는 restore 실패를 각각 BLOCK한다. | signed input snapshot, two recomputation outputs, ADR-0010 gate receipt |
| `V-14` | [역사적 문서 전환 전용] canonical inventory/parser가 devfootnote-only content, exact ten ADR links, 단일 F/AC/V/NG declaration, typed forward/reverse references, owner consistency와 dangling link 0건을 확인하고 docs cutover의 Git/product/test/IaC/cloud action 0건을 증명한다. | document graph report and scoped file-action receipt |

## 5. Acceptance 추적 매트릭스

아래는 선언이 아니라 typed reference 연결이다. Evidence는 해당 `V-*` 선언의 evidence class를 따른다.

| Acceptance 참조 | Verification 참조 | Phase |
|---|---|---:|
| `ref:AC-01` | `ref:V-01`, `ref:V-10` | 1, 4 |
| `ref:AC-02` | `ref:V-02`, `ref:V-03` | 1, 4 |
| `ref:AC-03` | `ref:V-04` | 1 |
| `ref:AC-04` | `ref:V-05`, `ref:V-11` | 1, 5 |
| `ref:AC-05` | `ref:V-06` | 2 |
| `ref:AC-06` | `ref:V-07`, `ref:V-08` | 3 |
| `ref:AC-07` | `ref:V-08`, `ref:V-12` | 2–5; Phase 2는 embedding consent·budget·query privacy subset만 적용 |
| `ref:AC-08` | `ref:V-05`, `ref:V-06`, `ref:V-09` | 1–5 |
| `ref:AC-09` | `ref:V-09` | 0–5 |
| `ref:AC-10` | `ref:V-10` | 4 |
| `ref:AC-11` | `ref:V-01`, `ref:V-09`, `ref:V-13` | 0–6 |
| `ref:AC-12` | `ref:V-11` | 5 |
| `ref:AC-13` | `ref:V-13` | 6 |
| `ref:AC-14` | `ref:V-14` | docs cutover |

## 6. 구현 규칙과 승인 gate

### 6.1 기능 단위 작업 절차

전체 제품을 구현 전에 끝까지 상세 설계하지 않는다. 새 기능, 여러 파일에 걸친 변경 또는 인증·DB·비동기 경계 변경은 관련 spec/ADR을 읽고 **지금 구현할 한 slice**의 계획을 먼저 정한다. 단순 문구 수정이나 원인·범위가 명확한 작은 버그 수정은 짧은 작업 설명과 재현 검사로 충분하다.

기능 계획은 다음 내용을 짧게 담는다.

- **목표와 제외 범위:** 이번 변경의 사용자 동작과 이번에 하지 않을 일.
- **기준 문서:** 관련 요구사항·수용 기준·검증 참조와 owning ADR. 기존 계약을 복제하거나 새 요구사항의 선언 장소로 사용하지 않는다.
- **관찰할 결과:** 정상·실패·경계 사례와 필요한 경쟁 시나리오. 기대 결과는 구현 코드가 아니라 위 계약에서 정한다.
- **구현 순서:** 변경할 파일·모듈, transaction·외부 호출 경계와 작은 작업 순서. 완성 코드를 미리 길게 작성하지 않는다.
- **검증:** 가장 좁은 재현 검사, 실제 DB/큐가 필요한 검사, 필요한 HTTP·브라우저 여정과 실행 환경. 아직 없는 script는 도입 예정으로 구분한다.
- **완료 보고:** 실제 명령·결과·미실행 항목, 남은 실패·위험과 문서 영향. 별도 evidence 문서는 보존할 실험·복구 기록이 있을 때만 추가한다.

한 세션에서 끝나는 작업은 대화의 계획으로 충분하다. 여러 세션에서 이어갈 기능만 필요할 때 `docs/plans/<날짜>-<기능>.md`에 계획과 결과를 보존한다. 이 파일들은 실행 기록이며 제품 요구사항은 spec, 기술 결정은 ADR, phase 순서·검증 선언은 이 문서가 계속 소유한다. 새 문서 체계·플러그인·skill을 이 절차만을 위해 도입하지 않는다.

실행 순서는 관련 계약·수용 기준 확인 → 필요한 검사 선택 → 구현 → 관련 검사·리뷰 → 필요한 문서 갱신이다. 버그 수정은 가능한 가장 좁은 재현 실패를 먼저 확인한다. 단순 변경에 RED 증거나 새 테스트 기반을 만들기 위한 작업을 추가하지 않는다. 승인 범위의 세부 작업마다 재승인을 요구하지 않되, 계약 충돌·새 권한·범위 확대는 구현 전에 확인한다. 문서의 잘못된 전제에 코드나 테스트를 억지로 맞추지 않는다.

### 6.2 실행과 검증 규칙

- 모든 phase는 제품·AI 구성·브랜드의 제외 범위(`ref:NG-01`–`ref:NG-05`, `ref:NG-08`)를 유지한다. 모노레포 구조나 Docker 실행 모드를 추가하는 것을 기능·권한·제품 범위 확대의 근거로 사용하지 않는다.
- 검증은 이번 변경이 깨뜨릴 수 있는 계약에 맞춰 기존 검사부터 선택한다. 순수 규칙은 unit, DB/queue 정합성은 integration, HTTP는 Supertest, 화면 상태는 RTL/MSW, 핵심 여정은 Playwright를 사용하되 한 변경에 모든 계층을 의무 적용하지 않는다. 아직 없는 phase의 실패 테스트·전용 harness·placeholder를 만들지 않는다.
- 실제 DB constraint, transaction, lease, queue delivery, crash recovery 또는 fencing을 mock-only test로 통과시키지 않는다. Sleep 대신 barrier와 controllable clock으로 경쟁을 재현한다.
- 폴더와 port는 현재 phase의 호출자·실패 경계·transaction 소유권이 요구할 때만 추가한다. 공개 Nest Module·업무 Service를 기본으로 하고 외부 AI의 장애 격리처럼 필요한 곳만 interface를 둔다. 빈 layer, Service와 일대일로 중복된 UseCase, generic repository/controller/workflow와 예상 재사용용 shared package를 미리 만들지 않는다.
- Provider call은 DB transaction 밖에 있어야 하고, publication/charge는 post-call fenced transaction의 commit만 effect 증거다. BullMQ 완료나 in-memory state를 성공 근거로 사용하지 않는다.
- 일반 JSON 성공은 ADR-0007의 success/data envelope를 한 번만 적용하고 API error는 실제 HTTP status와 success/error/message 계약으로 sanitize한다. 제품 mutation은 server-derived owner와 access JWT·CSRF 검사를 거친다. refresh/logout은 access 만료와 독립적인 ADR-0005의 refresh/CSRF 경계를 따른다. 사용자 입력으로 owner를 선택하지 않는다.
- phase 종료에는 해당 AC·V의 실행 결과, 관련 OpenAPI/client diff·migration state와 남은 실패를 검토한다. 일상 수정은 영향받는 검사로 닫고 전체 regression·이미지 smoke를 매번 반복하지 않는다. CI와 phase gate의 필수 검사는 유지하며 실패를 숨기려고 수용 기준을 완화하지 않는다.
- 명령·결과는 짧은 완료 보고로 충분하다. 실험·복구의 상세 기록이나 `AC → V → evidence path` manifest가 필요할 때만 Git에서 제외한 `docs/evidence/`에 보관한다. 공개 문서에는 로컬 링크 대신 검증 요약·재현 명령·한계를 남기며 테스트 코드와 CI 설정은 버전 관리한다.
- Phase 0에서는 실제 앱 조립·DB 연결·HTTP 계약의 좁은 검사부터 연결한다. 이후 해당 기능을 구현할 때 관련 테스트와 CI gate를 추가하며 테스트 폴더·비율·coverage 수치를 채우기 위한 placeholder를 만들지 않는다. 임시 scaffold 검사와 지속할 회귀 검사의 구분, CI 환경 누락 처리와 AI 검토 기준은 [ADR-0009](adr/0009-verification-observability-and-search-evaluation.md#scaffold-검사의-수명)를 따른다.
- AI가 테스트를 작성하거나 별도 에이전트가 리뷰했어도 실행 증거를 대신하지 않는다. 핵심 불변식과 기대 결과는 담당자가 원문 요구사항에 대조하고, 구현된 behavior·실제 검사·문서 계약이 일치해야 완료다.

## 7. 중단 조건과 handoff

다음이면 BLOCK한다: 승인 부재, ownership 중복/순환, private repository 접근, split save, owner/current/deleted predicate 누락, provider-in-transaction, unfenced publication/settlement, Google 로그인·서버 profile 검증 전 account/refresh write, browser provider token, JWT 검증·계정별 refresh 원자 교체·CSRF 결함, optional subsystem이 core path를 막음, content/secret telemetry, mock-only infrastructure proof, declaration/link graph 오류, 비용 worksheet 입력 누락, `finalTotalKRW > 30000`, memory/restore failure 또는 배포 승인 부재.

문서 작업 완료는 변경한 문서·링크·계약의 일관성을 뜻하며 제품 검증 완료가 아니다. 단계 완료는 각각의 gate와 실제 검사 결과로 판단한다. 다음 phase나 source control로 자동 확장하지 않으며, deployment handoff는 별도 Phase-6 승인과 비용·복구 gate 뒤다.

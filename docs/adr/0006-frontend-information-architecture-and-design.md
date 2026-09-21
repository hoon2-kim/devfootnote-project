# ADR-0006: 프론트엔드 정보 구조와 디자인

- Status: Accepted
- Date: 2026-09-12
- Updated: 2026-09-16 — Google 첫 로그인 계정 생성과 사용자별 개인 자료함 안내 반영
- Updated: 2026-09-20 — 사용자 요청에 따라 로그인부터 고운바탕·편집물 형태의 디자인으로 전환
- Canonical owner: 사용자 surface, 화면별 정보 구조, 디자인 토큰, 반응형·접근성 계약

## Context

devfootnote는 사용자마다 자신의 개발 메모와 근거를 저장하고, 기억나는 한영 혼합 단서로 다시 찾고, 저장 당시 메모와 원문을 구분해 읽는 개인 도구다. UI는 기능을 늘리기보다 이 여정을 짧고 복구 가능하게 만들어야 한다.

루트 [`DESIGN.md`](../../DESIGN.md)의 `Notion Analysis`는 저장소에 고정된 디자인 참고 계약이다. devfootnote는 그 문서의 따뜻한 종이 같은 계층, 흰 surface, 명료한 타이포그래피, 8px 기반 간격, 절제된 radius·elevation, navigation·card·input·auth·modal·empty·toast 패턴을 제품 맥락에 맞게 적용한다. Notion의 상표, 로고, 이름, 제품 문구, 이미지, sticker, 독점 `NotionInter`, 화면 구성의 픽셀 단위 복제는 하지 않는다.

## Decision Drivers

1. 제품 surface를 정확히 세 화면과 로그인 진입으로 유지한다.
2. 검색 준비 지연과 선택 기능 장애를 숨기지 않되 저장·키워드 검색·원문 읽기를 방해하지 않는다.
3. 데스크톱, 키보드, touch, tablet과 좁은 화면에서 같은 정보와 복구 동작을 제공한다.
4. 색상만으로 의미를 전달하지 않고 WCAG 2.2 AA를 검증 가능한 계약으로 만든다.

## Decision

### Route와 화면 수

사용자 route는 다음 네 개뿐이다. `/login`은 인증 진입이며 제품 화면 수에 포함하지 않는다.

1. `/library` — **자료함**: 자료 저장, 현재 자료 목록, 유형·태그/상태 필터, 최근 수정 정보, 비어 있음과 저장 복구를 제공한다.
2. `/search` — **검색·질문**: keyword를 항상 기본 경로로 제공하고, 준비된 경우 semantic/hybrid 결과를 함께 보여 주며, 사용자가 명시적으로 요청할 때만 근거 답변을 시작한다.
3. `/documents/[materialId]` — **자료 읽기**: 저장 메모/context와 source 원문을 시각·의미적으로 분리하고, 현재 revision, 출처, citation 대상 구간과 편집·삭제 진입을 제공한다.
4. `/login` — Google 로그인 한 동작과 개인 자료함 소개, 인증 오류·재시도만 제공한다. 첫 로그인 계정 생성은 인증 동작으로 유지하지만 별도의 가입 안내 문구는 표시하지 않는다. 별도 이메일/비밀번호 가입·초대·역할·팀 UI는 없다.

별도 dashboard, settings, chat history, analytics, feed, billing 화면은 만들지 않는다. consent·보존 설정처럼 필요한 제어는 해당 작업의 dialog 또는 화면 내 disclosure로 둔다. modal은 독립 제품 화면이 아니다.

### 화면 상태 계약

모든 화면은 적용 가능한 `loading`, `ready`, `empty`, `error`, `degraded`, `recovery` 상태를 명시적으로 갖는다.

| Surface | 정상/비어 있음 | 실패·저하 | 복구 |
|---|---|---|---|
| 자료함 | 저장 form과 현재 자료 card/list; 최초 사용 안내; AI 설정 뒤 기존 현재 자료의 의미 검색 활성화 | 저장 검증·충돌·네트워크 오류는 입력 가까이에 표시; Redis/worker/AI 장애는 저장 성공을 뒤집지 않고 indexing 지연으로 표시 | 동일 idempotency context로 저장 재시도, 최신 revision 다시 불러오기, 실패한 현재 자료 embedding 명시적 재시도 |
| 검색·질문 | keyword 결과가 기준; semantic 준비도와 answer 근거 표시 | semantic/AI 미동의·예산 소진·provider 장애는 해당 control만 비활성/설명하고 keyword 결과 유지 | keyword 계속 사용, 준비도 새로 확인, 기존 현재 자료 활성화·명시적 재시도 |
| 자료 읽기 | 메모와 원문을 별도 landmark/heading으로 제공; citation에서 근거로 이동 | 삭제됨, 권한 없음, stale revision, 원문 load 실패를 구별 | 검색/자료함으로 돌아가기, 최신 revision 열기 |
| 로그인 | 단일 Google 로그인 동작 | callback·Google profile·JWT 인증 오류를 개인정보 없이 설명 | 새 인증 시도; Google profile 인증 실패 중 account/refresh row 생성과 서비스 JWT 발급은 없음 |

loading은 기존 내용을 불필요하게 지우지 않으며 skeleton은 실제 구조와 비슷해야 한다. error는 원인 범주, 영향 범위, 다음 동작을 포함한다. toast만으로 영구 오류나 저장 결과를 전달하지 않는다.

### 정보 구조와 상호작용

공통 app shell은 제품명과 자료함/검색 두 navigation 항목, 로그인 상태와 logout 동작만 갖는다. access 만료 시 재발급·실패 복구는 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)의 transport 계약을 따르며 별도 token·장치 관리 화면을 만들지 않는다. 읽기 화면은 breadcrumb 또는 명시적 뒤로 가기 문맥을 제공한다. 현재 route는 `aria-current="page"`와 형태/텍스트로 표시한다. 자료 card 전체를 모호한 click target으로 만들지 않고 제목 link와 보조 동작을 분리한다.

검색 결과는 자료 제목, 매치 구간, 자료 유형, 현재 revision/준비 상태를 표시한다. keyword와 semantic 점수의 내부 수치로 관련성을 과장하지 않는다. 답변은 결과 위의 별도 요청 동작이며 자동 실행하지 않는다. 답변 citation은 선택된 근거 목록과 양방향으로 연결되고 자료 읽기의 정확한 구간으로 이동한다. 근거가 부족하면 답변 대신 그 사실을 표시한다.

삭제·동의 철회처럼 파괴적이거나 privacy에 영향이 있는 동작은 결과와 범위를 명시한 확인 dialog를 사용한다. dialog는 초점 trap, 처음의 안전한 focus, Escape 정책, 닫은 뒤 trigger로 focus return을 갖는다.

### devfootnote 디자인 토큰

`DESIGN.md`의 값은 참고 입력이며 앱에서는 devfootnote 소유의 semantic token으로 매핑한다.

| 역할 | 값/기준 | 사용 |
|---|---|---|
| `canvas` | `#f6f5f4` | page 배경 |
| `surface` | `#ffffff` | card, panel, field |
| `text-primary` | `#000000` | heading, 본문 |
| `text-secondary` | `#31302e` | 보조 본문 |
| `text-muted` | `#615d59` | 비핵심 metadata |
| `text-placeholder` | `#615d59` | 흰 field에서 4.5:1 이상 대비가 필요한 placeholder |
| `decoration-faint` | `#a39e98` | 정보를 전달하지 않는 비상호작용 장식만 |
| `border-subtle` | `#e6e6e6` | divider, card hairline |
| `action-primary` / `focus` | `#0075de` | 주 action, link, active/focus signal만 |
| `action-pressed` | `#005bab` | pressed 상태 |
| `status-error`, `status-warning`, `status-success`, `status-destructive` | 구현 전에 AA contrast를 충족하는 독립 semantic ramp로 확정 | 상태 text/icon/background; primary blue와 경쟁하는 CTA로 사용 금지 |

상태 token의 최종 색값은 scaffold에서 자동 contrast 검사를 통과한 값으로 고정한다. 색만으로 상태를 구분하지 않고 텍스트 label, icon(유용한 경우), `role="status"`/`role="alert"` 등 적절한 ARIA 의미를 함께 쓴다. `text-placeholder`도 일반 텍스트와 같은 최소 4.5:1 대비를 충족하며 본문, 도움말, 상태, timestamp, disabled control 설명에는 각 semantic text token을 사용한다. `decoration-faint`는 정보·상태·입력 힌트·control affordance를 전달하지 않는다.

제품 본문의 기본 font는 오픈소스 **Inter**와 system fallback이다. 로그인·자료함 제목·공통 Wordmark는 아래 승인된 고운바탕 예외를 적용한다. `NotionInter`를 요청하거나 번들하지 않는다. body는 16px/1.5를 기준으로 하고 dense metadata도 의미 있는 정보는 14px 미만으로 낮추지 않는다. heading은 단계가 건너뛰지 않는 문서 outline을 따른다. 간격은 8px base와 4/8/12/16/24/32 계열을 사용한다. input은 4px, utility control은 8px, card는 12px 정도의 절제된 radius를 사용하고 shadow보다 hairline과 whitespace를 우선한다. 제품 작업 화면에 marketing hero, sticker palette와 과도한 pill CTA를 도입하지 않는다.

### 로그인 디자인 전환 — 2026-09-20

사용자가 고운바탕과 UIBowl을 참고해 로그인부터 디자인을 변경하도록 요청했다. `DESIGN.md` 원본은 보존하고 `/login`의 글꼴·색상·배치는 이 결정을 우선 적용한다. 후속 요청으로 자료함과 공통 헤더까지 적용 범위를 넓혔으며, 검색·원문 읽기의 본문 배치는 유지한다.

- 참고: [고운바탕 원작 저장소](https://github.com/yangheeryu/Gowun-Batang), [UIBowl 로그인·회원가입 패턴](https://uibowl.io/?detail=1&patterns=%EB%A1%9C%EA%B7%B8%EC%9D%B8%C2%B7%ED%9A%8C%EC%9B%90%EA%B0%80%EC%9E%85). UIBowl의 공개 최신 패턴만 열람했다. 유료 열람을 우회하거나 다른 서비스의 이미지·화면을 복제하지 않는다.
- 중앙 카드 대신 왼쪽 소개와 오른쪽 로그인 동작을 얇은 선으로 구분한다. 좁은 화면은 한 열이며 장식용 각주·중복 소개 문구를 생략해 로그인 동작을 우선한다. 그라데이션·스티커·새 이미지 자산·가입 단계는 추가하지 않는다.
- 고운바탕 Regular를 브랜드·제목·소개 문구에 적용하고, 버튼·오류·안내문은 Inter/system sans를 유지한다. `next/font/local`과 약 495KB의 Fontsource 5.2.5 Korean WOFF2를 사용한다. 출처·배포본 checksum·OFL 저작권 고지는 `apps/web/public/fonts/gowun-batang/`에 보존한다. 빌드·브라우저의 외부 폰트 요청은 없다.
- `paper-canvas` `#f8f7f2`, `paper-ink` `#292e28`, `paper-muted` `#62665d`, `paper-rule` `#dcded5`, `paper-accent` `#536047`, `paper-control` `#74796e`, `paper-hover` `#f0f1eb`를 로그인·자료함·공통 헤더에서 공유한다. 최초 로그인 전용 `login-*` 토큰을 실제 공유 범위에 맞춰 이름만 바꿨다. 흰 Google 버튼과 올리브 focus를 사용하되 상태 오류색·Google 공식 아이콘은 유지한다. divider는 장식이고 버튼 경계·focus는 별도로 대비를 갖춘다.
- 문구 `나의 기록에, 나의 각주를`의 끝에는 마침표를 넣지 않는다. CTA는 `구글 로그인`이며 가입 양식·자동 계정 생성 설명을 다시 넣지 않는다. 기존 error 안내, returnTo 전달, 인증 처리·API 계약은 변경하지 않는다.
- 2026-09-21 사용자 요청으로 제목의 각주 숫자 `1`과 하단의 `1 개발 메모와 참고한 원문을 함께 모아두는 개인 자료함` 블록을 모든 화면 크기에서 제거한다. 나머지 소개 문구·로그인 동작은 유지한다.
- 사용자 요청으로 `개발자를 위한 개인 자료함`, `기록하는 개발자의 공간`, `구글 계정으로 자료함을 열어보세요`, `자료는 로그인한 계정에서만 볼 수 있습니다.`는 로그인에서 제거한다. 실제 인증 오류 안내는 유지한다.

### 자료함의 목록 우선 구성

- `/library`의 기본 화면은 고운바탕 제목, `새 자료` 버튼과 제목·최근 수정일 목록이다. 번호가 있는 revision은 읽기 화면에서 확인하며 자료함에 통계 카드·가짜 태그·폴더를 추가하지 않는다. 기존 페이지 이동과 현재 자료 조회·owner 격리는 유지한다.
- `새 자료`는 같은 화면의 작성 패널을 펼친다. modal이 아니므로 별도 focus trap이나 배경 차단을 두지 않는다. 처음 열면 제목 input에 초점을 주고 닫기 버튼 또는 Escape로 접으면 진입 버튼에 초점을 돌린다. 저장 중에는 닫기를 막는다.
- 패널은 접어도 마운트를 유지한다. 같은 화면에서 다시 열면 초안·검증 오류·저장 결과·멱등 요청 ID가 유지되고, 저장 성공 시에는 기존처럼 form을 비우고 목록을 갱신한다. 다른 페이지 이동·새로고침 뒤의 초안 보존은 별도 기능이며 추가하지 않는다.
- 공통 Wordmark와 인증 헤더도 종이색·고운바탕 브랜드로 통일한다. 데스크톱에서는 브랜드·자료함/검색·로그아웃을 한 줄에 두고 모바일에서는 탐색을 다음 줄로 옮긴다. 자료 목록·입력·버튼은 Inter/system sans를 유지한다. 로그인·자료함·Wordmark는 `lib/fonts.ts`의 같은 로컬 폰트 정의를 사용한다.
- UIBowl의 공개 목록·북마크·검색 패턴은 정보 밀도만 참고한다. 외부 화면·이미지를 복제하지 않으며 목록 응답에 없는 본문 미리보기나 새 API를 디자인 때문에 추가하지 않는다.

### 접근성·키보드·touch

- normal text contrast는 최소 4.5:1, large text는 3:1, control boundary와 focus indicator는 인접 색 대비 최소 3:1이다.
- 모든 interactive element는 순서가 예측 가능한 native keyboard 동작, 가시적인 `:focus-visible`, 접근 가능한 이름을 갖는다. hover-only 정보나 동작은 금지한다.
- input은 지속되는 label, 도움말과 오류 연결(`aria-describedby`), invalid 상태를 제공한다. submit 실패 시 오류 summary 또는 첫 invalid field로 focus를 이동한다.
- 비동기 저장·검색·답변 결과는 적절한 live region으로 알리되 반복 typing마다 방해하는 발표를 하지 않는다.
- icon-only control은 screen-reader name과 tooltip을 갖고, icon은 Lucide를 사용하더라도 의미를 text에서 대체하지 않는다.
- animation은 `prefers-reduced-motion`을 존중한다. press scale이나 scroll animation은 정보 접근의 전제가 아니다.
- 모든 주요 touch target은 최소 44×44 CSS px이다. 인접 target은 오조작을 막는 간격을 둔다.
- citation anchor, skip link, landmark, heading으로 keyboard와 screen reader가 메모·원문·근거 사이를 직접 이동할 수 있어야 한다.

검색 방식 안내는 검색 input의 `aria-describedby`에 연결한다. 검색·문서 재시도는 버튼 비활성화뿐 아니라 진행 문구와 `role="status"`로 알린다. 여러 서버 필드 오류는 모두 표시하고 응답 배열 순서가 아닌 화면의 제목→원문→메모→맥락→출처 순서로 첫 오류 필드에 한 번 focus한다. 문서의 일시적인 background 재조회 실패에는 본문·초안을 유지하되 오래된 내용임을 표시하며 접근 불가 응답에는 숨긴다.

### 반응형 계약

wide/desktop에서는 최대 폭 content column과 필요할 때만 2열을 사용한다. tablet 구간에서는 navigation을 축약하고 library/search의 보조 panel을 본문 아래로 접는다. 좁은 화면(최소 320 CSS px 포함)에서는 모든 핵심 content와 action을 single-column으로 유지하고 가로 page scroll을 만들지 않는다. table은 card/list로 재구성하거나 자체 scroll region과 label을 제공한다. button과 form field는 필요한 경우 full width가 되며 sticky control이 본문·오류·키보드 focus를 가리지 않는다. 긴 URL, 한영 혼합어, code, citation label은 wrap 또는 제한된 내부 overflow로 처리한다.

## Frontend libraries

Next.js App Router, React와 strict TypeScript 위에서 Tailwind CSS, shadcn/ui(Radix), TanStack Query, React Hook Form과 Zod, `react-markdown`과 `rehype-sanitize`, Lucide를 사용한다. exact 버전은 scaffold 시점의 상호 호환되는 stable 버전으로 고정한다. Markdown raw HTML은 허용하지 않고 sanitize 뒤에도 외부 link와 code rendering 정책을 검증한다. API와 상태 소유권은 [ADR-0007](0007-openapi-client-and-frontend-state-boundaries.md)이 정한다.

## Consequences

- 세 화면의 작업 흐름이 분명하고 optional semantic/AI 장애가 core path를 가리지 않는다.
- repository 디자인 참고의 계층과 절제를 재사용하면서 다른 제품의 정체성은 복제하지 않는다.
- semantic 상태색과 정확한 responsive 수치는 구현 시 검증을 거쳐 고정해야 하지만 WCAG와 기능 계약은 유예되지 않는다.
- 새 top-level 제품 화면은 이 ADR 변경 없이는 추가할 수 없다.

## Verification contract

구현 단계에서 token contrast 자동 검사, axe 기반 component 검사, screen-reader name/role assertion, keyboard-only E2E, focus trap/return, form error focus, live announcement, reduced-motion, 44×44 target과 320px narrow layout을 검증한다. `/login`, `/library`, `/search`, `/documents/[materialId]` 각각에서 적용 가능한 정상·빈 화면·대기·실패·저하·복구 상태를 검증한다. visual/문구 review는 Notion 이름·로고·asset·copy·sticker·`NotionInter`와 픽셀 복제를 거부한다.

## Revisit triggers

새 사용자 journey가 세 화면으로 표현될 수 없다는 관찰 근거, WCAG 기준 변경, 또는 루트 디자인 권위의 별도 승인된 교체가 있을 때만 재검토한다.

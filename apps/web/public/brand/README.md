# devfootnote 로고 시안

사용자가 만든 책갈피·세리프 로고를 기준으로 여백·색상·배치를 정리한 SVG다. 원본 PNG를 잘라 쓴 것이 아니라 단순한 책갈피를 다시 그렸다. `Wordmark`는 로그인에서 세로형, 공통 헤더·인증 대기/복구 화면에서 가로형을 사용한다. root layout의 icon metadata는 책갈피 심볼을 참조한다.

- `devfootnote-stacked.svg`: 로그인 상단 세로형.
- `devfootnote-horizontal.svg`: 공통 헤더·인증 대기/복구 화면의 가로형.
- `devfootnote-symbol.svg`: 브라우저 탭 파비콘에 연결한 책갈피 단독형.
- 색상은 단색 `#3B302A`. 세 파일 모두 배경이 투명하다.
- 원본 글꼴은 확인되지 않았다. 기존 웹 폰트 설정의 fallback 계열인 **Georgia Bold**로 굵은 세리프 느낌을 맞췄으며, 원본과 동일한 글꼴이라고 보장하지 않는다. 기존 UI의 고운바탕 설정은 변경하지 않았다.
- 글자를 path로 변환해 SVG를 열 때 폰트 설치·외부 요청에 의존하지 않는다. 폰트 파일 자체는 복사하거나 배포하지 않는다.
- PNG가 필요하면 SVG를 원하는 크기로 렌더링한다. 이번 미리보기·PNG 내보내기는 로컬 `test-results/logo/`에 있다.

단독 이미지로는 내장 title이 있고, 웹의 `Wordmark`는 `alt="devfootnote"`를 지정한다. 옆에 같은 제품명이 텍스트로 있으면 심볼은 중복 낭독을 피하도록 `alt=""`로 사용한다. SVG는 Next 이미지 최적화 없이 원본으로 전달한다.

// 실제 사용자 자료가 아닌 합성 개발 메모다. 모델 호출 전에 질의와 정답을 고정한다.
export const corpusVersion = 'developer-notes-ko-en-v1';
export const documents = [
  [
    'refresh-cas',
    'Refresh token 회전',
    '여러 탭이 동시에 토큰 갱신을 요청하면 이전 토큰 해시를 조건부 UPDATE로 교체한다. 일치한 한 요청만 성공하고 나머지는 재사용으로 거절한다. 계정마다 현재 refresh 해시 한 개만 저장한다.',
  ],
  [
    'oauth-state',
    'OAuth 왕복 검증',
    '소셜 로그인 시작 때 난수 state와 브라우저 binding을 만든다. callback에서는 두 값의 해시와 만료 시간을 함께 검사하며 행을 원자적으로 소비한다. 다른 브라우저가 보낸 응답과 재사용을 막는다.',
  ],
  [
    'csrf',
    '쿠키 인증 요청 보호',
    '브라우저가 쿠키를 자동으로 보내는 unsafe 요청은 CSRF 토큰과 정확한 Origin을 검사한다. 공격자 사이트에서 사용자의 로그인 쿠키로 임의의 변경 요청을 보내는 것을 막는다.',
  ],
  [
    'idempotency',
    '응답 유실과 중복 저장',
    '서버가 자료를 저장한 뒤 응답이 사라질 수 있다. 같은 멱등 키와 입력 fingerprint로 재요청하면 저장된 receipt 결과를 돌려준다. 새 자료나 비용을 두 번 만들지 않고 다른 입력이면 충돌을 반환한다.',
  ],
  [
    'outbox',
    'DB 저장과 큐 전달',
    '데이터베이스 commit과 Redis enqueue는 원자화할 수 없다. 자료와 처리 의도를 같은 transaction에 남기고 큐 전달은 commit 뒤 수행한다. 전달에 실패한 의도는 스캐너가 찾아 재전송한다.',
  ],
  [
    'lease',
    '중단된 worker 복구',
    'worker는 만료 시간이 있는 lease와 무작위 token으로 작업을 점유한다. 죽은 프로세스의 점유는 DB 시각으로 회수한다. 늦게 돌아온 이전 worker는 token이 달라 결과를 게시할 수 없다.',
  ],
  [
    'backoff',
    '외부 호출 재시도',
    '일시적인 429와 5xx는 횟수 상한 안에서 재시도한다. 모든 클라이언트가 동시에 다시 호출하지 않도록 지수 backoff에 무작위 jitter를 섞는다. 다음 실행 시각은 DB에 기록한다.',
  ],
  [
    'skip-locked',
    '여러 복구 스캐너의 작업 분배',
    '여러 복구 프로세스가 만료 작업을 가져갈 때 SELECT FOR UPDATE SKIP LOCKED를 사용한다. 다른 연결이 잠근 행은 기다리지 않고 건너뛰며 batch 개수를 제한해 작업량을 고정한다.',
  ],
  [
    'revision',
    '동시 문서 편집 충돌',
    '사용자가 읽었던 expectedRevisionId와 현재 revision을 비교한다. 다른 편집이 먼저 저장됐다면 409를 반환하고 새 입력을 몰래 덮지 않는다. immutable revision을 추가한 뒤 current pointer를 교체한다.',
  ],
  [
    'pagination',
    '깊은 목록 페이지',
    'OFFSET은 앞쪽 행을 계속 건너뛰므로 뒤 페이지일수록 비싸진다. 목록은 updated_at과 id를 함께 커서로 사용해 안정적인 다음 페이지를 읽을 수 있다. 점수 검색은 다른 cursor 설계가 필요하다.',
  ],
  [
    'trigram',
    '짧은 한글 부분 문자열',
    'pg_trgm의 padding 경계 trigram은 infix LIKE 패턴에서 쓰기 어렵다. 두 글자 검색은 seq scan이 될 수 있다. 검색 누락 정책을 바꾸지 말고 실행계획과 후보 행 수를 먼저 측정한다.',
  ],
  [
    'stored-fts',
    '전문 검색의 반복 계산',
    'to_tsvector를 조회마다 각 행에서 다시 계산하면 넓은 검색이 느려진다. stored generated tsvector 컬럼에 토큰화 결과를 저장하고 GIN과 ts_rank_cd가 같은 컬럼을 사용하게 한다.',
  ],
  [
    'unicode',
    '검색 snippet 원문 위치',
    'NFKC 정규화는 전각 문자와 결합문자의 길이를 바꿀 수 있다. 정규화한 검색 위치를 원문 offset으로 그대로 쓰면 잘못 자른다. grapheme 경계를 찾아 환산하고 이모지 surrogate pair를 보존한다.',
  ],
  [
    'pool',
    '데이터베이스 연결 고갈',
    '요청마다 새 Pool을 만들지 않고 프로세스별 bounded 연결 풀을 공유한다. 연결 획득 timeout과 statement timeout을 나누고 사용한 client는 finally에서 반환한다. 앱 종료 때 pool.end를 기다린다.',
  ],
  [
    'readiness',
    '선택 기능 장애와 상태 검사',
    'liveness는 프로세스가 응답하는지만 확인한다. readiness는 핵심 PostgreSQL 연결을 검사한다. Redis나 외부 AI 장애가 저장과 keyword 검색까지 중단시키지 않게 선택 기능의 degraded 상태를 분리한다.',
  ],
  [
    'docker-cache',
    '모노레포 컨테이너 빌드',
    'Dockerfile은 workspace manifest와 lockfile을 먼저 복사하고 frozen install을 수행한다. 소스 복사는 그 뒤에 둬 소스 수정마다 의존성을 다시 내려받지 않는다. runtime은 non-root이며 secret은 build layer에 넣지 않는다.',
  ],
  [
    'query-cache',
    'Background refetch 실패',
    'TanStack Query는 백그라운드 재조회가 실패해도 이전 data를 유지한다. data가 있으면 문서를 계속 보여주고 최신 상태 확인 실패 경고를 표시한다. 오류 여부만 보고 읽던 본문을 숨기지 않는다.',
  ],
  [
    'budget',
    'AI 비용 예약',
    '외부 AI 호출 전에 서비스 공유 예산 행을 잠근다. 이미 정산한 비용과 유효 예약을 합산하고 새 최대 비용을 예약한다. 호출 결과가 불명확한 예약은 만료됐다는 이유로 무료 처리하지 않는다.',
  ],
  [
    'consent',
    '외부 전송 동의 철회',
    '사용자가 동의를 철회하면 consent epoch를 증가시킨다. 이전 epoch에서 대기하던 작업은 새 호출을 시작할 수 없고 진행 중이던 응답도 게시하지 않는다. 이미 전송한 데이터를 회수했다고 약속하지 않는다.',
  ],
  [
    'grounding',
    '근거 제한 답변',
    '답변은 현재 사용자의 저장 자료에서 선택한 evidence만 사용한다. 인용은 모델이 만든 임의 URL 대신 서버의 chunk identity에 연결한다. 충분한 근거가 없으면 답을 꾸며내지 않고 부족함을 알린다.',
  ],
  [
    'jwt-expiry',
    'Access JWT 만료',
    'access JWT는 서명과 issuer, audience, 용도, 만료를 검증한다. 짧은 유효 시간 동안 인증을 제공하며 refresh JWT와 서명 키를 분리한다. logout 이후 이미 발급한 access의 잔여 유효성을 문서화한다.',
  ],
  [
    'oauth-profile',
    '소셜 계정 식별',
    '이메일은 바뀔 수 있으므로 Google의 issuer와 subject를 계정 식별자로 사용한다. 인증된 profile을 받은 뒤 첫 로그인에 내부 account를 생성한다. 내부 owner ID와 provider 식별자를 분리한다.',
  ],
  [
    'cors',
    '교차 출처 읽기',
    'CORS는 브라우저가 다른 출처 응답을 읽을 수 있는지를 제어한다. 인증이나 CSRF 검사를 대체하지 않는다. 필요한 출처만 허용하며 credentials를 쓰는 응답의 wildcard 설정을 주의한다.',
  ],
  [
    'http-cache',
    'HTTP 응답 캐시',
    'ETag는 리소스 표현을 식별한다. If-None-Match가 현재 태그와 같으면 서버는 304로 본문 전송을 생략할 수 있다. Cache-Control로 브라우저와 공유 캐시의 보존 정책을 정한다.',
  ],
  [
    'redis-cache',
    '읽기 캐시 무효화',
    'cache-aside는 캐시에 값이 없으면 DB를 조회한 뒤 Redis에 저장한다. TTL만 기다리면 갱신 직후 stale data가 보일 수 있어 쓰기 성공 후 관련 키를 무효화한다. 캐시 장애에는 원본 DB 조회를 사용한다.',
  ],
  [
    'queue-priority',
    '작업 우선순위',
    '대화형 요청과 대량 배치를 같은 큐에서 처리하면 짧은 작업이 오래 기다릴 수 있다. priority와 worker concurrency를 조정하되 DB 연결 수와 외부 rate limit도 함께 계산한다.',
  ],
  [
    'rate-limit',
    '공개 API 요청 제한',
    '공개 경로에는 시간 구간별 요청 수 제한을 둘 수 있다. 429 응답과 Retry-After로 과도한 트래픽을 제한한다. 사용자별 제한과 서비스 전체 예산은 서로 다른 목적이다.',
  ],
  [
    'deadlock',
    '데이터베이스 교착',
    '두 transaction이 반대 순서로 행을 잠그면 서로 상대 잠금을 기다리는 deadlock이 생긴다. 공통 잠금 순서를 정하고 짧은 transaction을 유지한다. 실패를 성공으로 감추지 않는다.',
  ],
  [
    'soft-delete',
    '삭제 자료 가리기',
    'soft delete는 행을 바로 지우지 않고 deleted_at을 설정한다. 읽기와 검색의 모든 branch에서 미삭제 조건을 적용해야 한다. 감사 이력 보존과 사용자 접근 허용은 별개의 문제다.',
  ],
  [
    'sorting',
    '안정적인 결과 순서',
    '점수가 같은 검색 결과는 updated_at과 ID로 순서를 결정한다. 같은 입력과 같은 snapshot에서 결과가 바뀌지 않게 tie-break를 명시한다. 정렬 비용은 실행계획의 노드별 시간을 확인한다.',
  ],
  [
    'fts-config',
    '전문 검색 설정',
    'PostgreSQL full-text search는 문서를 lexeme으로 나누고 tsquery와 매칭한다. simple 설정과 언어별 dictionary는 stemming과 stop word 처리에서 차이가 있다. tokenizer 변경은 검색 의미를 바꾼다.',
  ],
  [
    'gin-write',
    '역색인 쓰기 비용',
    'GIN 인덱스는 값에서 여러 행을 찾는 역색인이다. 읽기 선택도가 좋을 때 유리하지만 쓰기와 저장 공간 비용이 있다. 모든 컬럼에 인덱스를 추가하지 않고 실제 쿼리를 기준으로 판단한다.',
  ],
  [
    'markdown',
    '원문 렌더링 보안',
    '사용자가 저장한 Markdown의 raw HTML과 script를 그대로 실행하지 않는다. 링크 protocol을 제한하고 본문 텍스트와 렌더링 결과를 분리한다. 저장 자료 안의 명령은 시스템 지시사항이 아니다.',
  ],
  [
    'connection-proxy',
    'DB 연결 프록시',
    '여러 앱 프로세스의 연결 수를 합산해야 한다. transaction pooling 프록시는 연결 수를 줄일 수 있지만 session state와 prepared statement의 호환성을 확인해야 한다.',
  ],
  [
    'health-logs',
    '안전한 장애 로그',
    'DB 오류 객체에는 SQL parameter와 credential이 들어갈 수 있다. 원본 error stack을 출력하지 않고 operation과 유한한 실패 분류만 남긴다. 로그 redaction은 원문을 넘기지 않는 원칙의 보조 장치다.',
  ],
  [
    'turbo',
    '빌드 캐시 입력',
    'Turborepo cache는 task 입력을 기준으로 재사용된다. 루트 tsconfig와 Node 기준 파일도 결과에 영향을 주면 globalDependencies에 넣는다. 캐시 hit와 새 빌드 실행은 구분해 보고한다.',
  ],
  [
    'form-state',
    '폼 입력과 서버 상태',
    'React Hook Form은 사용자가 작성 중인 입력을 관리한다. TanStack Query는 서버 응답을 관리한다. 원격 변경이 감지돼도 작성하던 내용을 자동으로 덮지 않고 사용자의 복구 선택을 받는다.',
  ],
  [
    'usage-report',
    '비용 관찰',
    'provider 대시보드는 사용량을 관찰하는 도구다. 대시보드 알림만으로 동시 호출의 서비스 비용 상한을 보장할 수 없다. settled token count와 가격 버전을 함께 기록해 금액을 계산한다.',
  ],
  [
    'retention',
    '파생 자료 보존',
    '벡터와 인용 본문은 자료 삭제나 동의 철회 뒤 즉시 접근하지 못하게 한다. 물리 정리는 bounded batch로 수행한다. 원문 없는 중복 방지 receipt와 과금 이력은 별도 기간 동안 보존한다.',
  ],
  [
    'vector',
    '의미 검색 벡터',
    '임베딩은 텍스트를 숫자 배열로 표현한다. 같은 모델과 차원으로 만든 벡터를 cosine distance로 비교한다. 단어가 정확히 같지 않아도 의미가 유사한 문서를 후보로 찾을 수 있다.',
  ],
].map(([id, title, body]) => ({ id, title, body }));

export const queries = [
  ['q01', '동시에 갱신된 토큰 중 하나만 인정', 'refresh-cas'],
  ['q02', '다른 브라우저의 구글 로그인 응답 거절', 'oauth-state'],
  ['q03', '로그인 쿠키를 악용한 외부 사이트의 변경 요청 차단', 'csrf'],
  ['q04', '저장은 됐는데 응답이 끊겨 다시 전송하면?', 'idempotency'],
  ['q05', 'DB에 저장했는데 작업 큐에는 못 넣은 경우', 'outbox'],
  ['q06', '죽었다 돌아온 작업자가 옛 결과를 덮어쓰지 못하게', 'lease'],
  ['q07', '장애 복구 순간 재요청이 한꺼번에 몰리지 않게', 'backoff'],
  ['q08', '잠긴 항목은 건너뛰고 다른 배치 처리', 'skip-locked'],
  ['q09', '문서 수정 중 다른 사람이 먼저 저장', 'revision'],
  ['q10', '뒤쪽 페이지 조회가 점점 느려지는 이유', 'pagination'],
  ['q11', '두 글자 한글 LIKE 검색 인덱스', 'trigram'],
  ['q12', 'to_tsvector 재계산 줄이기', 'stored-fts'],
  ['q13', '전각 글자 검색 후 강조 위치가 틀림', 'unicode'],
  ['q14', 'DB 커넥션을 돌려주지 않아 요청이 대기', 'pool'],
  ['q15', 'Redis가 죽어도 서버 준비 상태는 정상이어야 하나', 'readiness'],
  ['q16', '소스만 바꿨는데 Docker 의존성을 매번 다시 설치', 'docker-cache'],
  ['q17', 'focus refetch 네트워크 오류 뒤 읽던 문서 유지', 'query-cache'],
  ['q18', 'AI 동시 요청이 월 예산을 넘지 않도록 선점', 'budget'],
  ['q19', 'AI 전송 동의를 취소했는데 뒤늦게 온 응답', 'consent'],
  ['q20', '저장하지 않은 지식을 섞지 말고 출처로만 답하기', 'grounding'],
].map(([id, query, expected]) => ({ id, query, expected }));

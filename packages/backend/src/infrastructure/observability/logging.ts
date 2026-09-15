import { pino } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(level)) {
  // Pino의 기본 오류에는 거부한 설정값이 포함되므로 값 없이 안내한다.
  throw new Error('LOG_LEVEL은 fatal, error, warn, info, debug, trace, silent 중 하나여야 합니다.');
}

export const logger = pino({
  name: 'devfootnote',
  level,
  timestamp: () => {
    // 현재 한국 표준시(UTC+9). 호스트 TZ나 DB의 시간 설정은 변경하지 않는다.
    const time = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
    return `,"time":"${time}"`;
  },
  // 지정 경로만 제거하는 보조 방어다. 호출부에서는 원본 요청·예외·비밀값을 넘기지 않는다.
  redact: {
    paths: ['req', 'res', 'err', 'password', 'accessToken', 'refreshToken'],
    remove: true,
  },
});

import { ConsoleLogger } from '@nestjs/common';
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
  redact: {
    paths: ['req', 'res', 'err', 'password', 'accessToken', 'refreshToken'],
    remove: true,
  },
});

export class NestLogger extends ConsoleLogger {
  // Nest가 main의 catch보다 먼저 기록하는 초기화·종료 오류도 원문을 넘기지 않는다.
  override error(): void {
    logger.error('Nest 내부 처리 중 오류가 발생했습니다.');
  }
}

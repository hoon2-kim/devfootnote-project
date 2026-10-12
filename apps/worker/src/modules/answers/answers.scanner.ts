import {
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { AnswersService } from './answers.service.js';
import { logger } from '../../infrastructure/logging/logger.js';

/** DB의 RESERVED 요청만 소비한다. API는 이 scanner를 등록하지 않는다. */
@Injectable()
export class AnswersScanner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly answers: AnswersService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      if (this.running || this.abort.signal.aborted) {
        return;
      }

      this.running = this.answers
        .sweep(this.abort.signal)
        .catch(() => {
          logger.warn('답변 요청 처리·정리 회차를 완료하지 못했습니다.');
        })
        .finally(() => {
          this.running = null;
        });
    }, 15_000);
    this.timer.unref();
  }

  async beforeApplicationShutdown() {
    clearInterval(this.timer);
    this.abort.abort();

    if (this.running) {
      await this.running;
    }
  }
}

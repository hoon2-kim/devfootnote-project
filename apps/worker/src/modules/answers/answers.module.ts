import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiAnswer } from '@devfootnote/ai';
import { MaterialsModule } from '../materials/index.js';
import { UsageRetentionModule } from '../usage-retention/index.js';
import { AnswersRepository } from './answers.repository.js';
import { AnswersService } from './answers.service.js';
import { AnswersScanner } from './answers.scanner.js';

@Module({
  imports: [MaterialsModule, UsageRetentionModule],
  providers: [
    AnswersRepository,
    AnswersService,
    AnswersScanner,
    {
      provide: GeminiAnswer,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('geminiApiKey');

        return key ? new GeminiAnswer(key) : null;
      },
    },
  ],
  exports: [AnswersService],
})
export class AnswersModule {}

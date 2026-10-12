import type { Database } from '@devfootnote/db';
import { Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule, WORKER_DATABASE } from './database.module.js';

export type PostgresTransactionAdapter = TransactionalAdapterDrizzleOrm<Database>;

// 작업 전체가 아니라 claim·호출 준비·결과 처리의 짧은 transaction만 묶는다.
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      plugins: [
        new ClsPluginTransactional({
          connectionName: 'worker',
          imports: [DatabaseModule],
          adapter: new TransactionalAdapterDrizzleOrm({ drizzleInstanceToken: WORKER_DATABASE }),
        }),
      ],
    }),
  ],
})
export class TransactionsModule {}

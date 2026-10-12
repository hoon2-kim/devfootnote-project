import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { DatabaseModule } from './database.module.js';
import { DATABASE, type Database } from './database.provider.js';

export type PostgresTransactionAdapter = TransactionalAdapterDrizzleOrm<Database>;

// HTTP 전체가 아니라 명시적인 withTransaction 범위에만 연결을 묶는다.
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          adapter: new TransactionalAdapterDrizzleOrm({ drizzleInstanceToken: DATABASE }),
        }),
      ],
    }),
  ],
})
export class TransactionsModule {}

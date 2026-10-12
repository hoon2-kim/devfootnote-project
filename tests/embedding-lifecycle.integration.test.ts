import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveEmbeddingPolicy, type EmbeddingPolicy } from '@devfootnote/ai';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/embedding-lifecycle.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const {
  EmbeddingActivationService,
  EmbeddingDeliveryService,
}: typeof import('../apps/api/dist/modules/indexing/index.js') = requireFixture(
  '../apps/api/dist/modules/indexing/index.js',
);
const {
  TransactionsModule,
}: typeof import('../apps/worker/dist/infrastructure/database/transactions.module.js') =
  requireFixture('../apps/worker/dist/infrastructure/database/transactions.module.js');
const {
  DatabaseModule,
}: typeof import('../apps/worker/dist/infrastructure/database/database.module.js') = requireFixture(
  '../apps/worker/dist/infrastructure/database/database.module.js',
);
const { MaterialsModule }: typeof import('../apps/worker/dist/modules/materials/index.js') =
  requireFixture('../apps/worker/dist/modules/materials/index.js');
const {
  UsageRetentionModule,
  WorkerUsageService,
}: typeof import('../apps/worker/dist/modules/usage-retention/index.js') = requireFixture(
  '../apps/worker/dist/modules/usage-retention/index.js',
);
const {
  EmbeddingWorkRepository,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-work.repository.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-work.repository.js');
const {
  EmbeddingLifecycleService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-lifecycle.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-lifecycle.service.js');
const {
  EmbeddingExecutionService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-execution.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-execution.service.js');
const {
  EmbeddingRepairService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-repair.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-repair.service.js');

const policy: EmbeddingPolicy = {
  provider: 'fixture-no-network',
  model: 'fixture',
  modelVersion: '1',
  dimensions: 1536,
  inputVersion: 'fixture-body-v1',
  policyVersion: 'fixture-consent-v1',
  retentionNotice: 'fixture only',
  pricingVersion: 'fixture-price-v1',
  currency: 'USD',
  unitScale: 1000000000,
  maximumPerChunk: '10',
  pricePerToken: '1',
  budgetId: '00000000-0000-4000-8000-000000000300',
  budgetLimit: '10000',
  periodStart: '2020-01-01T00:00:00.000Z',
  periodEnd: '2100-01-01T00:00:00.000Z',
  reservationSeconds: 600,
};

describe('명시적 활성화 이후 누락 복구와 파생 벡터 보존', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let module: TestingModule;
  let settings: ConfigService;
  let lifecycle: InstanceType<typeof EmbeddingLifecycleService>;
  let repository: InstanceType<typeof EmbeddingWorkRepository>;
  let ownerId: string;

  const create = (body = '현재 자료의 PostgreSQL 근거') =>
    harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      body,
    });

  async function activate(material: Awaited<ReturnType<typeof create>>) {
    const result = await harness.app.get(EmbeddingActivationService).activate(ownerId, {
      requestId: randomUUID(),
      configFingerprint: approveEmbeddingPolicy(policy).fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: 0,
      accepted: true,
      targets: [{ materialId: material.id, revisionId: material.revisionId }],
    });

    return result.workIds[0]!;
  }

  async function enableAutomatic(expectedConsentEpoch = 0) {
    return harness.app.get(EmbeddingActivationService).activate(ownerId, {
      requestId: randomUUID(),
      configFingerprint: approveEmbeddingPolicy(policy).fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch,
      accepted: true,
      includeExisting: true,
      targets: [],
    });
  }

  async function due() {
    await harness.pool.query(
      "update indexing_embedding_activations set scan_after = clock_timestamp() - interval '1 second'",
    );
    await harness.pool.query(
      "update indexing_embedding_vectors set cleanup_after = clock_timestamp() - interval '1 second'",
    );
  }

  async function effects() {
    return (
      await harness.pool.query(`select
      (select count(*)::int from indexing_embedding_works) as works,
      (select count(*)::int from usage_embedding_reservations) as reservations,
      (select count(*)::int from indexing_embedding_vectors) as vectors,
      (select count(*)::int from material_revisions) as revisions`)
    ).rows[0];
  }

  async function vectorFixture(material: Awaited<ReturnType<typeof create>>, workId: string) {
    await harness.pool.query(
      "update indexing_embedding_works set state = 'PUBLISHED' where id = $1",
      [workId],
    );
    await harness.pool.query(
      `insert into indexing_embedding_vectors (work_id,owner_id,material_id,revision_id,chunk_id,embedding)
      select $1,owner_id,material_id,revision_id,id,$2::vector from material_chunks where revision_id=$3`,
      [workId, JSON.stringify(Array.from({ length: 1536 }, () => 0.5)), material.revisionId],
    );
  }

  beforeAll(async () => {
    harness = await startAuthHarness();
    settings = new ConfigService({
      databaseUrl: harness.app.get(ConfigService).getOrThrow<string>('databaseUrl'),
      embeddingConfigFingerprint: approveEmbeddingPolicy(policy).fingerprint,
      embeddingPolicy: approveEmbeddingPolicy(policy),
    });
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TransactionsModule,
        DatabaseModule,
        MaterialsModule,
        UsageRetentionModule,
      ],
      providers: [EmbeddingWorkRepository, EmbeddingLifecycleService, EmbeddingExecutionService],
    })
      .overrideProvider(ConfigService)
      .useValue(settings)
      .compile();
    await module.init();
    lifecycle = module.get(EmbeddingLifecycleService);
    repository = module.get(EmbeddingWorkRepository);
    vi.spyOn(harness.app.get(EmbeddingDeliveryService), 'deliver').mockResolvedValue(false);
  });

  beforeEach(async () => {
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    harness.app.get(ConfigService).set('embeddingPolicy', policy);
    settings.set('embeddingConfigFingerprint', approveEmbeddingPolicy(policy).fingerprint);
    await harness.auth.completeLogin(GOOGLE_SUBJECT_A);
    ownerId = (await harness.pool.query<{ id: string }>('select id from accounts')).rows[0]!.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();

    try {
      await module?.close();
    } finally {
      await harness?.close();
    }
  });

  it('미동의 자료에는 만들지 않고 활성화 이후 저장 알림이 없어도 새 work와 예약을 함께 만든다', async () => {
    const first = await create();

    await create('활성화 전에 저장했고 사용자가 선택하지 않은 자료');
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 0, reservations: 0 });
    await activate(first);
    const second = await create('두 번째 현재 자료');

    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 2, reservations: 2 });
    expect(
      (
        await harness.pool.query(
          `select w.activation_id = a.request_id as inherited from indexing_embedding_works w
      join embedding_intents i on i.id = w.intent_id join indexing_embedding_activations a on a.owner_id=w.owner_id
      where i.material_id=$1`,
          [second.id],
        )
      ).rows,
    ).toEqual([{ inherited: true }]);
    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 2, reservations: 2 });
  });

  it('앞쪽 완료·최종실패 intent를 지나 durable cursor로 다음 페이지까지 복구한다', async () => {
    const first = await create();
    const firstWork = await activate(first);

    for (let i = 0; i < 24; i++) {
      await create(`후속 자료 ${i}`);
    }

    await harness.pool.query(
      "update indexing_embedding_works set state='FINAL_FAILED' where id=$1",
      [firstWork],
    );
    await lifecycle.activateMissing();
    expect((await effects()).works).toBeLessThanOrEqual(21);
    expect(
      (await harness.pool.query('select intent_cursor from indexing_embedding_activations')).rows[0]
        ?.intent_cursor,
    ).not.toBeNull();
    await due();
    await lifecycle.activateMissing();
    expect((await effects()).works).toBe(25);
    expect(
      (await harness.pool.query('select intent_cursor from indexing_embedding_activations')).rows[0]
        ?.intent_cursor,
    ).toBeNull();
    await due();
    await lifecycle.activateMissing();
    expect((await effects()).works).toBe(25);
  });

  it('전체 자동 준비는 기존 자료도 한 회차 20건 이내로 처리하고 이후 저장·수정도 발견한다', async () => {
    const first = await create();

    for (let index = 0; index < 24; index++) {
      await create(`활성화 전에 저장한 자료 ${index}`);
    }

    await enableAutomatic();
    expect(await effects()).toMatchObject({ works: 0, reservations: 0 });
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 20, reservations: 1 });
    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 25, reservations: 2 });
    await harness.pool.query("update indexing_embedding_works set state='FINAL_FAILED'");
    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 25, reservations: 2 });

    // terminal 재검사의 마지막 페이지까지 마쳐 다음 검사가 커서 위치에 의존하지 않게 한다.
    await due();
    await lifecycle.activateMissing();

    const later = await create('전체 자동 준비를 켠 다음 저장한 본문');
    const revised = await harness.app.get(MaterialsService).update(ownerId, first.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: first.revisionId,
      body: '수정 후 새로 준비할 본문',
    });

    for (let page = 0; page < 2; page++) {
      await due();
      await lifecycle.activateMissing();
    }

    expect((await effects()).works).toBe(27);
    expect(
      (
        await harness.pool.query(
          `select count(*)::int as count from indexing_embedding_works w
         join embedding_intents i on i.id=w.intent_id
         where i.revision_id in ($1,$2) and w.state='PENDING'`,
          [later.revisionId, revised.revisionId],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });

  it('자료가 없을 때 켠 자동 준비도 첫 저장을 처리하고 철회 뒤 새 자료는 처리하지 않는다', async () => {
    await enableAutomatic();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 0, reservations: 0 });
    await create();
    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
    await harness.app.get(EmbeddingActivationService).revoke(ownerId, 1);
    await create('철회 후 저장한 본문');
    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
  });

  it('기존 범위 활성화는 명시적 확대 전에는 과거 자료를 처리하지 않는다', async () => {
    const selected = await create();

    await create('기존 동의에 포함되지 않은 이전 본문');
    await activate(selected);
    await lifecycle.activateMissing();
    expect((await effects()).works).toBe(1);
    await enableAutomatic(1);
    await lifecycle.activateMissing();
    expect((await effects()).works).toBe(2);
  });

  it('활성화와 같은 밀리초 안에 먼저 저장된 미선택 자료도 자동 전송하지 않는다', async () => {
    const selected = await create();
    const previous = await create('동의 직전의 미선택 자료');

    await activate(selected);
    await harness.pool.query(
      "update indexing_embedding_activations set enabled_at='2026-01-01 00:00:00.123900+00'",
    );
    await harness.pool.query(
      "update materials set updated_at='2026-01-01 00:00:00.123100+00' where id=$1",
      [previous.id],
    );
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
  });

  it('work 저장 실패는 공유 예약과 cursor 변경도 rollback한다', async () => {
    await activate(await create());
    await create('실패를 주입할 다음 자료');
    await harness.pool
      .query(`create function reject_lifecycle_work() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$;
      create trigger reject_lifecycle_work before insert on indexing_embedding_works for each row execute function reject_lifecycle_work()`);

    try {
      await lifecycle.activateMissing();
      expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
    } finally {
      await harness.pool.query(
        'drop trigger reject_lifecycle_work on indexing_embedding_works; drop function reject_lifecycle_work()',
      );
    }

    await due();
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 2, reservations: 2 });
  });

  it('철회 또는 설정 변경 뒤 자동 work를 생성하지 않는다', async () => {
    await activate(await create());
    await create();
    settings.set('embeddingConfigFingerprint', 'different');
    await lifecycle.activateMissing();
    settings.set('embeddingConfigFingerprint', approveEmbeddingPolicy(policy).fingerprint);
    await harness.pool.query(
      'update usage_embedding_consents set revoked_at=clock_timestamp(),epoch=epoch+1',
    );
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
  });

  it('잠긴 activation은 건너뛰고 별도 선점 뒤에는 같은 회차를 중복 처리하지 않는다', async () => {
    await activate(await create());
    const blocker = await harness.pool.connect();

    try {
      await blocker.query('begin');
      await blocker.query('select owner_id from indexing_embedding_activations for update');
      expect(await repository.reserveActivationBatch()).toEqual([]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    expect(await repository.reserveActivationBatch()).toEqual([ownerId]);
    expect(await repository.reserveActivationBatch()).toEqual([]);
  });

  it('예산이 부족하면 새 work와 예약 모두 만들지 않는다', async () => {
    await activate(await create());
    await create('예산이 필요한 다음 자료');
    await harness.pool.query('update usage_embedding_reservations set reserved_maximum=10000');
    await lifecycle.activateMissing();
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
  });

  it('만료된 query 노출만 상한 정산하고 잠긴 행·chunk 공유 예약은 남긴다', async () => {
    await activate(await create());
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    for (const id of ids) {
      await harness.pool.query(
        `insert into usage_embedding_reservations
        (id,owner_id,budget_id,request_id,fingerprint,config_fingerprint,consent_epoch,
         reserved_maximum,pricing_snapshot,expires_at,exposure_started_at,created_at)
        select $1::uuid,owner_id,budget_id,$1::uuid,'query-v1:' || $1::text,config_fingerprint,consent_epoch,
          reserved_maximum,pricing_snapshot,clock_timestamp()-interval '1 second',clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '3 seconds'
        from usage_embedding_reservations where fingerprint not like 'query-v1:%' limit 1`,
        [id],
      );
    }

    await harness.pool.query(
      "update usage_embedding_reservations set created_at=clock_timestamp()-interval '3 seconds', expires_at=clock_timestamp()-interval '1 second', exposure_started_at=clock_timestamp()-interval '2 seconds' where fingerprint not like 'query-v1:%'",
    );
    const blocker = await harness.pool.connect();

    try {
      await blocker.query('begin');
      await blocker.query('select id from usage_embedding_reservations where id=$1 for update', [
        ids[0],
      ]);
      expect(await module.get(WorkerUsageService).settleExpiredQueries(2)).toBe(2);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    expect(
      (
        await harness.pool.query(`select count(*)::int as count from usage_embedding_reservations
      where state='settled' and settled_amount=reserved_maximum`)
      ).rows,
    ).toEqual([{ count: 2 }]);
    expect(await module.get(WorkerUsageService).settleExpiredQueries(2)).toBe(1);
    expect(
      (
        await harness.pool.query(
          "select state from usage_embedding_reservations where fingerprint not like 'query-v1:%'",
        )
      ).rows,
    ).toEqual([{ state: 'reserved' }]);
  });

  it('철회된 벡터만 물리 삭제하고 원문과 terminal identity는 보존한다', async () => {
    const material = await create();

    await vectorFixture(material, await activate(material));
    await lifecycle.cleanVectors();
    expect((await effects()).vectors).toBe(1);
    await harness.pool.query(
      'update usage_embedding_consents set revoked_at=clock_timestamp(),epoch=epoch+1',
    );
    await due();
    await lifecycle.cleanVectors();
    expect(await effects()).toMatchObject({ vectors: 0, works: 1, revisions: 1, reservations: 1 });
  });

  it('같은 현재 본문에 쓸 수 있는 과거 벡터는 보존하고 본문 변경 뒤에는 지운다', async () => {
    const material = await create();

    await vectorFixture(material, await activate(material));
    const changed = await harness.app.get(MaterialsService).update(ownerId, material.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: material.revisionId,
      body: '현재 자료의 PostgreSQL 근거',
      title: '제목만 변경',
    });

    await lifecycle.cleanVectors();
    expect((await effects()).vectors).toBe(1);
    await harness.app.get(MaterialsService).update(ownerId, material.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: changed.revisionId,
      body: '완전히 다른 현재 본문',
    });
    await due();
    await lifecycle.cleanVectors();
    expect(await effects()).toMatchObject({ vectors: 0, revisions: 3, works: 1 });
  });

  it('잠긴 벡터를 건너뛰고 설정이 없으면 기존 벡터를 임의 삭제하지 않는다', async () => {
    const material = await create();

    await vectorFixture(material, await activate(material));
    const blocker = await harness.pool.connect();

    try {
      await blocker.query('begin');
      await blocker.query('select work_id from indexing_embedding_vectors for update');
      expect(await repository.reserveVectorCleanup()).toEqual([]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    settings.set('embeddingConfigFingerprint', null);
    await lifecycle.cleanVectors();
    expect((await effects()).vectors).toBe(1);
  });

  it('provider 설정을 꺼도 repair 회차가 철회된 벡터를 정리하고 큐는 연결하지 않는다', async () => {
    const material = await create();

    await vectorFixture(material, await activate(material));
    await harness.pool.query(
      'update usage_embedding_consents set revoked_at=clock_timestamp(),epoch=epoch+1',
    );
    settings.set('embeddingConfigFingerprint', null);
    const repair = new EmbeddingRepairService(
      repository,
      module.get(EmbeddingExecutionService),
      module.get(WorkerUsageService),
      settings,
      lifecycle,
    );

    try {
      await repair.runOnce();
      expect(await effects()).toMatchObject({ works: 1, vectors: 0 });
    } finally {
      await repair.beforeApplicationShutdown();
    }
  });

  async function expiredAuditFixture() {
    const material = await create();
    const workId = await activate(material);
    const attemptId = randomUUID();

    await harness.pool.query(
      `update indexing_embedding_works set state='FINAL_FAILED',attempt_count=1,
      terminal_at=clock_timestamp()-interval '91 days' where id=$1`,
      [workId],
    );
    await harness.pool.query(
      `insert into indexing_embedding_attempts(id,owner_id,work_id,number,lease_token,outcome,started_at,finished_at)
      values($1,$2,$3,1,$4,'FINAL_FAILED',clock_timestamp()-interval '92 days',clock_timestamp()-interval '91 days')`,
      [attemptId, ownerId, workId, randomUUID()],
    );
    await harness.pool
      .query(`update usage_embedding_reservations set state='settled',settled_amount=1,
      completed_at=clock_timestamp()-interval '91 days',cleanup_after=clock_timestamp()-interval '1 second'`);
    await harness.pool.query(
      `insert into usage_embedding_call_receipts(attempt_id,owner_id,reservation_id,tokens,amount,created_at)
      select $1,owner_id,id,1,1,clock_timestamp()-interval '91 days' from usage_embedding_reservations`,
      [attemptId],
    );

    return { workId, attemptId };
  }

  it('종료와 정산 모두 90일 지난 상세만 지우고 work·활성화 멱등 기록은 보존한다', async () => {
    const { workId } = await expiredAuditFixture();

    await lifecycle.cleanAudit();
    expect((await effects()).reservations).toBe(1); // 진행 중인 예산의 정산 합계는 보존한다.
    await harness.pool.query(
      "update usage_embedding_budgets set period_end=clock_timestamp()-interval '91 days'",
    );
    await lifecycle.cleanAudit();
    expect(await effects()).toMatchObject({ works: 1, reservations: 0, revisions: 1 });
    expect(
      (
        await harness.pool.query(
          'select state,reservation_id from indexing_embedding_works where id=$1',
          [workId],
        )
      ).rows,
    ).toEqual([{ state: 'FINAL_FAILED', reservation_id: null }]);
    expect(
      (
        await harness.pool.query(`select
      (select count(*)::int from indexing_embedding_attempts) as attempts,
      (select count(*)::int from usage_embedding_call_receipts) as calls,
      (select count(*)::int from usage_embedding_budgets) as budgets,
      (select count(*)::int from indexing_activation_receipts) as receipts`)
      ).rows,
    ).toEqual([{ attempts: 0, calls: 0, budgets: 0, receipts: 1 }]);
    await due();
    await lifecycle.activateMissing();
    expect((await effects()).works).toBe(1);
  });

  it('최근 종료된 시도가 있으면 정산이 오래돼도 보존하고 삭제 실패는 전체 rollback한다', async () => {
    const { attemptId } = await expiredAuditFixture();

    await harness.pool.query(
      "update usage_embedding_budgets set period_end=clock_timestamp()-interval '91 days'",
    );
    await harness.pool.query(
      'update indexing_embedding_attempts set finished_at=clock_timestamp() where id=$1',
      [attemptId],
    );
    await lifecycle.cleanAudit();
    expect((await effects()).reservations).toBe(1);
    await harness.pool.query(
      "update indexing_embedding_attempts set finished_at=clock_timestamp()-interval '91 days'",
    );
    await harness.pool.query(
      "update usage_embedding_reservations set cleanup_after=clock_timestamp()-interval '1 second'",
    );
    await harness.pool
      .query(`create function reject_audit_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$;
      create trigger reject_audit_delete before delete on usage_embedding_reservations for each row execute function reject_audit_delete()`);

    try {
      await lifecycle.cleanAudit();
      expect((await effects()).reservations).toBe(1);
      expect(
        (
          await harness.pool.query(`select
        (select count(*)::int from indexing_embedding_attempts) as attempts,
        (select count(*)::int from usage_embedding_call_receipts) as calls,
        (select count(*)::int from indexing_embedding_works where reservation_id is not null) as attached`)
        ).rows,
      ).toEqual([{ attempts: 1, calls: 1, attached: 1 }]);
    } finally {
      await harness.pool.query(
        'drop trigger reject_audit_delete on usage_embedding_reservations; drop function reject_audit_delete()',
      );
    }
  });
});

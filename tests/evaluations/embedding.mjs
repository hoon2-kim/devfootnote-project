import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DrizzleMaterialsRepository } from '../../apps/api/dist/modules/materials/infrastructure/drizzle-materials.repository.js';
import { DrizzleMaterialsQueryRepository } from '../../apps/api/dist/modules/materials/infrastructure/drizzle-materials-query.repository.js';
import { prepareMaterial } from '../../apps/api/dist/modules/materials/domain/material-content.js';
import {
  GeminiEmbedding,
  EmbeddingProviderError,
  geminiEmbeddingModel,
  geminiEmbeddingInputVersion,
} from '@devfootnote/ai';
import { corpusVersion, documents, queries } from './embedding-corpus.mjs';

const image =
  'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6';
const checkOnly = process.argv.includes('--check');
const freeTierConfirmed = process.argv.includes('--gemini-free');
const evidence = checkOnly
  ? 'test-results/embedding-gemini-preflight'
  : 'docs/evidence/embedding-gemini2-free-v1';
const owner = randomUUID();
const budget = randomUUID();
const corpusHash = createHash('sha256')
  .update(JSON.stringify({ corpusVersion, documents, queries }))
  .digest('hex');
const fingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      corpusHash,
      model: geminiEmbeddingModel,
      dimensions: 1536,
      inputVersion: geminiEmbeddingInputVersion,
    }),
  )
  .digest('hex');
// 무료 여부와 별개로 유료 표준 단가를 예산 계산에 적용한다. 실제 청구액이라는 뜻은 아니다.
const pricePerToken = 200n;
const maximumPerInput = 8192n * pricePerToken;
const budgetLimit = 100_000_000n - 3_276_800n; // 앞선 OpenAI 실패 요청의 노출 상한을 보존한다.
const report = {
  corpusVersion,
  corpusHash,
  configFingerprint: fingerprint,
  provider: 'google',
  tier: checkOnly ? 'not_checked' : 'free-confirmed-by-operator',
  accounting: 'paid-list-price-reference-not-an-invoice',
  priorExposureNanoUsd: '3276800',
  model: geminiEmbeddingModel,
  dimensions: 1536,
  inputVersion: geminiEmbeddingInputVersion,
  startedAt: new Date().toISOString(),
  calls: [],
  cases: [],
  status: 'preparing',
};

// 키 값은 검사 결과·예외·산출물에 넣지 않는다. 사용자 DB 주소는 사용하지 않는다.
const key = process.env.GEMINI_API_KEY;

if (!checkOnly && !freeTierConfirmed) {
  console.error(
    'AI Studio의 Free 등급 확인 후 --gemini-free로 실행해 주세요. 유료 전환은 하지 않습니다.',
  );
  process.exit(1);
}

if (!checkOnly && !key?.trim()) {
  console.error('GEMINI_API_KEY가 없습니다. 워커의 서버 환경 설정을 확인해 주세요.');
  process.exit(1);
}

await mkdir(evidence, { recursive: true });
let receipt;

if (!checkOnly) {
  try {
    receipt = await open(`${evidence}/started.json`, 'wx', 0o600);
  } catch {
    console.error(
      '평가 시작 기록이 이미 있거나 기록할 수 없습니다. 중복 외부 호출을 막기 위해 중단합니다.',
    );
    process.exit(1);
  }

  await receipt.writeFile(JSON.stringify({ ...report, maximumUsd: '0.10' }, null, 2));
  await receipt.sync();
  await receipt.close();
}

let container;
let pool;

async function reserve(inputCount) {
  const id = randomUUID();
  const amount = maximumPerInput * BigInt(inputCount);
  const client = await pool.connect();

  try {
    await client.query('begin');
    const consent = await client.query(
      'select epoch from usage_embedding_consents where owner_id = $1 and config_fingerprint = $2 and granted_at is not null and revoked_at is null for update',
      [owner, fingerprint],
    );

    assert.equal(consent.rowCount, 1);
    await client.query('select id from usage_embedding_budgets where id = $1 for update', [budget]);
    const total = await client.query(
      `select coalesce(sum(coalesce(settled_amount, reserved_maximum)), 0)::text as amount from usage_embedding_reservations where budget_id = $1`,
      [budget],
    );

    assert.ok(BigInt(total.rows[0].amount) + amount <= budgetLimit);
    await client.query(
      `insert into usage_embedding_reservations
      (id, owner_id, budget_id, request_id, fingerprint, config_fingerprint, consent_epoch, reserved_maximum, pricing_snapshot, expires_at, exposure_started_at)
      values ($1, $2, $3, $1, $4, $4, 1, $5, $6, now() + interval '10 minutes', now())`,
      [
        id,
        owner,
        budget,
        fingerprint,
        amount.toString(),
        JSON.stringify({
          version: 'gemini2-standard-reference-2026-10-01',
          currency: 'USD',
          unitScale: 1_000_000_000,
          maximumPerChunk: maximumPerInput.toString(),
        }),
      ],
    );
    await client.query('commit');

    return { id, amount };
  } catch (error) {
    await client.query('rollback');

    throw error;
  } finally {
    client.release();
  }
}

async function embed(inputs, purpose) {
  if (checkOnly) {
    return inputs.map((_, index) =>
      Array.from({ length: 1536 }, (_, dimension) => (dimension === index ? 1 : 0)),
    );
  }

  const vectors = [];

  for (let offset = 0; offset < inputs.length; offset += 20) {
    const batch = inputs.slice(offset, offset + 20);
    const reservation = await reserve(batch.length);
    const call = {
      count: batch.length,
      maximumNanoUsd: reservation.amount.toString(),
      outcome: 'unknown',
    };

    report.calls.push(call);
    // 호출 전에 기록해 실패·강제 종료 뒤에도 노출된 예약을 무료로 취급하지 않는다.
    await writeFile(`${evidence}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    const result = await new GeminiEmbedding(key).embed(batch, purpose);
    const amount =
      result.tokens === null ? reservation.amount : BigInt(result.tokens) * pricePerToken;

    assert.ok(amount <= reservation.amount);
    await pool.query(
      `update usage_embedding_reservations set state = 'settled', settled_amount = $2 where id = $1 and state = 'reserved'`,
      [reservation.id, amount.toString()],
    );
    Object.assign(call, {
      outcome: result.tokens === null ? 'conservative_maximum' : 'usage_confirmed',
      tokens: result.tokens,
      accountedNanoUsd: amount.toString(),
    });
    vectors.push(...result.vectors);
    await writeFile(`${evidence}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  }

  return vectors;
}

try {
  container = await new PostgreSqlContainer(image).withDatabase('embedding_evaluation').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: 'packages/db/migrations' });
  await pool.query('insert into accounts (id, issuer, subject) values ($1, $2, $3)', [
    owner,
    'synthetic-evaluation',
    'owner',
  ]);
  await pool.query(
    `insert into usage_embedding_consents (owner_id, epoch, config_fingerprint, policy_version, granted_at) values ($1, 1, $2, 'synthetic-gemini-free-evaluation-2026-10-01', now())`,
    [owner, fingerprint],
  );
  await pool.query(
    `insert into usage_embedding_budgets (id, period_start, period_end, currency, unit_scale, "limit") values ($1, now() - interval '1 hour', now() + interval '1 day', 'USD', 1000000000, $2)`,
    [budget, budgetLimit.toString()],
  );
  // 평가 후보만 담는 임시 테이블이다. 제품 게시 경로를 검증했다고 주장하지 않는다.
  await pool.query(
    'create table evaluation_vectors (material_id uuid, revision_id uuid, vector vector(1536))',
  );
  const writes = new DrizzleMaterialsRepository(db, { tx: db });
  const keyword = new DrizzleMaterialsQueryRepository(db);
  const identifiers = new Map();
  const saved = [];

  for (const document of documents) {
    const material = await writes.create({
      ownerId: owner,
      idempotencyKey: randomUUID(),
      prepared: prepareMaterial({ title: document.title, body: document.body }),
    });

    saved.push(material);
    identifiers.set(material.id, document.id);
  }

  report.status = 'calling';
  const vectors = [
    ...(await embed(
      documents.map((item) => item.body),
      'document',
    )),
    ...(await embed(
      queries.map((item) => item.query),
      'query',
    )),
  ];

  for (let index = 0; index < saved.length; index++) {
    await pool.query('insert into evaluation_vectors values ($1, $2, $3::vector)', [
      saved[index].id,
      saved[index].revisionId,
      JSON.stringify(vectors[index]),
    ]);
  }

  // 동일 벡터의 타인·삭제·과거 버전을 섞어 필터를 따로 검증한다.
  const otherOwner = randomUUID();

  await pool.query('insert into accounts (id, issuer, subject) values ($1, $2, $3)', [
    otherOwner,
    'synthetic-evaluation',
    'other',
  ]);
  const foreign = await writes.create({
    ownerId: otherOwner,
    idempotencyKey: randomUUID(),
    prepared: prepareMaterial({ body: documents[0].body }),
  });
  const deleted = await writes.create({
    ownerId: owner,
    idempotencyKey: randomUUID(),
    prepared: prepareMaterial({ body: documents[0].body }),
  });

  await pool.query('update materials set deleted_at = now() where id = $1', [deleted.id]);
  const historical = await writes.create({
    ownerId: owner,
    idempotencyKey: randomUUID(),
    prepared: prepareMaterial({ body: documents[0].body }),
  });
  const changed = prepareMaterial({ body: '현재 버전의 별도 자료' });

  await writes.update({
    ownerId: owner,
    materialId: historical.id,
    expectedRevisionId: historical.revisionId,
    idempotencyKey: randomUUID(),
    fingerprint: changed.fingerprint,
    prepared: changed,
  });

  for (const material of [foreign, deleted, historical]) {
    await pool.query('insert into evaluation_vectors values ($1, $2, $3::vector)', [
      material.id,
      material.revisionId,
      JSON.stringify(vectors[0]),
    ]);
  }

  let filterViolations = 0;

  for (let index = 0; index < queries.length; index++) {
    const item = queries[index];
    const normalized = item.query.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
    const words = await keyword.keywordCandidates(owner, normalized, 1, 40);
    const semantic = await pool.query(
      `select m.id from evaluation_vectors v join materials m on m.id = v.material_id and m.current_revision_id = v.revision_id where m.owner_id = $1 and m.deleted_at is null order by v.vector <=> $2::vector, m.id limit 40`,
      [owner, JSON.stringify(vectors[documents.length + index])],
    );
    const ranks = new Map();

    for (const candidates of [words.items, semantic.rows]) {
      candidates.forEach(({ id }, rank) =>
        ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + rank + 1)),
      );
      filterViolations += candidates.filter(({ id }) =>
        [foreign.id, deleted.id, historical.id].includes(id),
      ).length;
    }

    const hybrid = [...ranks]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([id]) => ({ id }));
    const hit = (rows) => rows.slice(0, 5).some(({ id }) => identifiers.get(id) === item.expected);

    report.cases.push({
      id: item.id,
      expected: item.expected,
      keywordHit5: hit(words.items),
      vectorHit5: hit(semantic.rows),
      hybridHit5: hit(hybrid),
    });
  }

  report.summary = {
    queries: queries.length,
    keywordHit5: report.cases.filter((item) => item.keywordHit5).length,
    vectorHit5: report.cases.filter((item) => item.vectorHit5).length,
    hybridHit5: report.cases.filter((item) => item.hybridHit5).length,
    filterViolations,
  };

  assert.equal(filterViolations, 0);
  report.status = checkOnly
    ? 'preflight_only'
    : report.summary.hybridHit5 >= 18 &&
        report.summary.hybridHit5 >= report.summary.keywordHit5 &&
        filterViolations === 0
      ? 'passed'
      : 'quality_failed';
  console.log(JSON.stringify({ status: report.status, ...report.summary, calls: report.calls }));

  if (!checkOnly && report.status !== 'passed') {
    process.exitCode = 1;
  }
} catch (error) {
  report.status = error instanceof EmbeddingProviderError ? error.kind : 'evaluation_failed';
  console.error(
    `임베딩 평가를 중단했습니다: ${report.status}. 원본 오류와 입력은 출력하지 않습니다.`,
  );
  process.exitCode = 1;
} finally {
  try {
    await writeFile(`${evidence}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  } finally {
    try {
      await pool?.end();
    } finally {
      await container?.stop();
    }
  }
}

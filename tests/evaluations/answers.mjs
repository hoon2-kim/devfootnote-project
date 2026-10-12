import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '@devfootnote/db';
import { reserveAiBudget } from '@devfootnote/db/usage-retention/budget-reservation';
import { GeminiAnswer, AnswerProviderError, geminiFreeAnswerPolicy } from '@devfootnote/ai';

// 실제 사용자 자료와 무관한 고정 합성 사례다. 출력 내용은 저장하지 않고 판정·사용량만 남긴다.
const cases = [
  {
    id: 'single-evidence',
    question: '별무리 캐시 항목의 TTL은 몇 초인가요?',
    evidence: [{ evidenceId: 'e1', text: '합성 별무리 캐시의 항목 TTL은 37초다.' }],
    expected: [{ evidenceId: 'e1', pattern: /37\s*초/u }],
  },
  {
    id: 'multi-evidence',
    question: '합성 은하 큐의 최대 시도 횟수와 재시도 간격을 각각 알려주세요.',
    evidence: [
      { evidenceId: 'e1', text: '합성 은하 큐는 최초 실행을 포함해 최대 3회 시도한다.' },
      { evidenceId: 'e2', text: '합성 은하 큐의 재시도 간격은 250밀리초다.' },
    ],
    expected: [
      { evidenceId: 'e1', pattern: /3\s*회/u },
      { evidenceId: 'e2', pattern: /250\s*(?:밀리초|ms)/iu },
    ],
  },
  {
    id: 'insufficient-evidence',
    question: '합성 서비스의 인증 토큰은 몇 초 뒤 만료되나요?',
    evidence: [{ evidenceId: 'e1', text: '합성 서비스의 자료는 PostgreSQL에 저장한다.' }],
    expected: [],
  },
];
const checkOnly = process.argv.includes('--check');
const freeConfirmed = process.argv.includes('--gemini-free');
const directory = checkOnly
  ? 'test-results/answer-gemini-preflight'
  : 'docs/evidence/answer-gemini35-free-v1';
const policy = geminiFreeAnswerPolicy();
const maximum = BigInt(policy.requestMaximum);
const corpusHash = createHash('sha256')
  .update(JSON.stringify(cases, (_, value) => (value instanceof RegExp ? value.source : value)))
  .digest('hex');
const report = {
  corpusVersion: 'answer-smoke-v1',
  corpusHash,
  model: policy.model,
  configFingerprint: policy.fingerprint,
  pricingVersion: policy.pricingVersion,
  tier: checkOnly ? 'not_checked' : 'operator-confirmed-free',
  accounting: 'paid-list-price-reference-not-an-invoice',
  scope: 'adapter-smoke-not-product-publication-or-final-quality-evaluation',
  startedAt: new Date().toISOString(),
  maximumCalls: cases.length,
  maximumNanoUsd: (maximum * BigInt(cases.length)).toString(),
  priorExposureNanoUsd: '0',
  status: 'preparing',
  calls: [],
};
let container;
let pool;
let mayWriteReport = checkOnly;

async function persist() {
  if (mayWriteReport) {
    await writeFile(`${directory}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}

async function evaluate() {
  const key = process.env.GEMINI_API_KEY;

  if (!checkOnly && (!freeConfirmed || !key?.trim())) {
    report.status = 'configuration_missing';

    throw new Error('평가 설정이 필요합니다.');
  }

  if (!checkOnly) {
    // 앞선 10월 평가 노출액도 유지한다. 기록이 없거나 불명확하면 새 호출을 시작하지 않는다.
    const prior = JSON.parse(
      await readFile('docs/evidence/embedding-gemini2-free-v1/result.json', 'utf8'),
    );

    assert.equal(prior.status, 'passed');
    const priorAmount = prior.calls.reduce(
      (sum, call) => sum + BigInt(call.accountedNanoUsd ?? call.maximumNanoUsd),
      BigInt(prior.priorExposureNanoUsd),
    );

    assert.ok(priorAmount + maximum * BigInt(cases.length) <= 100_000_000n);
    report.priorExposureNanoUsd = priorAmount.toString();
  }

  await mkdir(directory, { recursive: true });

  if (!checkOnly) {
    // 중단·재실행도 중복 호출로 이어지지 않게 실제 호출보다 먼저 배타적 시작 기록을 남긴다.
    const receipt = await open(`${directory}/started.json`, 'wx', 0o600);

    try {
      await receipt.writeFile(JSON.stringify(report, null, 2));
      await receipt.sync();
    } finally {
      await receipt.close();
    }

    mayWriteReport = true;
  }

  container = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6',
  )
    .withDatabase('answer_evaluation')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
  const db = createDatabase(pool);

  await migrate(db, { migrationsFolder: 'packages/db/migrations' });
  const ownerId = randomUUID();
  const budgetId = randomUUID();

  await pool.query("insert into accounts(id, issuer, subject) values ($1, 'synthetic', 'owner')", [
    ownerId,
  ]);
  await pool.query(
    `insert into usage_answer_consents(owner_id, epoch, config_fingerprint, policy_version, granted_at)
     values ($1, 1, $2, $3, now())`,
    [ownerId, policy.fingerprint, policy.policyVersion],
  );
  const evaluationPolicy = {
    ...policy,
    budgetPeriod: undefined,
    budgetId,
    periodStart: new Date(Date.now() - 60_000).toISOString(),
    periodEnd: new Date(Date.now() + 3_600_000).toISOString(),
    budgetLimit: report.maximumNanoUsd,
    purposeBudgetLimit: report.maximumNanoUsd,
  };

  for (const item of cases) {
    const reservation = await db.transaction(async (tx) => {
      const consent = await tx.execute(sql`select epoch from usage_answer_consents
        where owner_id = ${ownerId} and config_fingerprint = ${policy.fingerprint}
        and granted_at is not null and revoked_at is null for update`);

      assert.equal(consent.rowCount, 1);
      const reserved = await reserveAiBudget(tx, {
        ownerId,
        requestId: randomUUID(),
        fingerprint: corpusHash,
        epoch: 1,
        amount: maximum,
        policy: evaluationPolicy,
        purpose: 'grounded-answer',
      });

      assert.ok(reserved.accepted);
      await tx.execute(sql`update usage_embedding_reservations
        set exposure_started_at = clock_timestamp() where id = ${reserved.id}`);

      return reserved;
    });
    const call = { id: item.id, outcome: 'started', maximumNanoUsd: maximum.toString() };

    report.calls.push(call);
    report.status = 'calling';
    await persist();
    const started = performance.now();
    let candidate;
    let usage = null;
    let providerFailure = null;

    try {
      const idle = await pool.query(`select count(*)::int as count from pg_stat_activity
        where datname = current_database() and state = 'idle in transaction'`);

      assert.equal(idle.rows[0].count, 0);
      candidate = checkOnly
        ? {
            insufficientEvidence: item.expected.length === 0,
            claims: item.expected.map((expected) => ({
              text: item.evidence.find((entry) => entry.evidenceId === expected.evidenceId).text,
              evidenceIds: [expected.evidenceId],
            })),
            usage: { inputTokens: 100, outputTokens: 20 },
          }
        : await new GeminiAnswer(key).generate({
            question: item.question,
            evidence: item.evidence,
          });
      usage = candidate.usage;
    } catch (error) {
      providerFailure = error instanceof AnswerProviderError ? error.kind : 'evaluation_failed';
      usage = error instanceof AnswerProviderError ? error.usage : null;
    }

    const amount = usage
      ? BigInt(usage.inputTokens) * BigInt(policy.inputPricePerToken) +
        BigInt(usage.outputTokens) * BigInt(policy.outputPricePerToken)
      : maximum;

    assert.ok(amount <= maximum);
    const settled = await pool.query(
      `update usage_embedding_reservations set state='settled', settled_amount=$2,
       input_tokens=$3, output_tokens=$4, completed_at=clock_timestamp()
       where id=$1 and state='reserved' returning id`,
      [reservation.id, amount.toString(), usage?.inputTokens ?? null, usage?.outputTokens ?? null],
    );

    assert.equal(settled.rowCount, 1);
    Object.assign(call, {
      outcome: providerFailure ?? 'response_validated',
      elapsedMs: Math.round(performance.now() - started),
      usage,
      accountedNanoUsd: amount.toString(),
    });

    if (providerFailure) {
      report.status = providerFailure;
      await persist();

      throw new Error('제공자 응답 확인 실패');
    }

    const expectedOutcome = candidate.insufficientEvidence === (item.expected.length === 0);
    const matchedFacts = item.expected.filter((expected) =>
      candidate.claims.some(
        (claim) =>
          claim.evidenceIds.includes(expected.evidenceId) && expected.pattern.test(claim.text),
      ),
    ).length;

    Object.assign(call, {
      expectedOutcome,
      matchedFacts,
      expectedFacts: item.expected.length,
      claimCount: candidate.claims.length,
      // 숫자·단위와 해당 citation의 일치만 검사한다. 전체 의미 근거성을 판정했다고 주장하지 않는다.
      factAndCitationSmokePassed: expectedOutcome && matchedFacts === item.expected.length,
    });
    await persist();

    if (!call.factAndCitationSmokePassed) {
      report.status = 'smoke_mismatch';

      throw new Error('고정 기대 결과와 다름');
    }
  }

  report.status = checkOnly ? 'preflight_passed_no_ai_calls' : 'smoke_passed';
}

try {
  await evaluate();
} catch {
  if (['preparing', 'calling'].includes(report.status)) {
    report.status = 'evaluation_failed';
  }

  process.exitCode = 1;
} finally {
  try {
    await persist();
  } catch {
    report.status = 'report_write_failed';
    process.exitCode = 1;
  } finally {
    try {
      await pool?.end();
    } catch {
      report.status = 'cleanup_failed';
      process.exitCode = 1;
    } finally {
      try {
        await container?.stop();
      } catch {
        report.status = 'cleanup_failed';
        process.exitCode = 1;
      }
    }
  }

  console.log(JSON.stringify(report));
}

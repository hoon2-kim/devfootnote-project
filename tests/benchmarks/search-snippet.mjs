import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createSearchSnippet } from '../../apps/api/dist/modules/search/search-snippet.js';

const samples = [];

for (const size of [1000, 10000]) {
  for (const [name, prefix, match, token] of [
    ['한글', '가', '인증', '인증'],
    ['ASCII', 'x', 'redis', 'redis'],
    ['전각', '가', 'ＢｕｌｌＭＱ', 'bullmq'],
    ['소문자 확장', 'İ', 'redis', 'redis'],
  ]) {
    for (const position of ['start', 'middle', 'end']) {
      const offset =
        position === 'start' ? 0 : position === 'middle' ? size / 2 : size - match.length;
      const body = prefix.repeat(offset) + match + prefix.repeat(size - offset - match.length);
      const material = { body, note: null, context: null, title: null, sourceUrl: null };
      const run = () => createSearchSnippet(material, [token]);

      assert.ok(run().snippet.includes(match));

      for (let i = 0; i < 100; i++) {
        run();
      }

      const times = [];

      for (let batch = 0; batch < 20; batch++) {
        const start = performance.now();

        for (let i = 0; i < 50; i++) {
          run();
        }

        times.push(performance.now() - start);
      }

      const sorted = [...times].sort((a, b) => a - b);
      const result = {
        size,
        name,
        position,
        p50Ms: sorted[9],
        p95Ms: sorted[18],
        samplesMs: times,
      };

      samples.push(result);
      console.log(JSON.stringify({ ...result, samplesMs: undefined }));
    }
  }
}

await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/search-snippet.json',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      node: process.version,
      cpu: os.cpus()[0]?.model,
      warmupCalls: 100,
      resultsPerRequest: 50,
      scope: 'warm synchronous snippet only; synthetic input; excludes DB/HTTP; no SLO claim',
      samples,
    },
    null,
    2,
  ),
);

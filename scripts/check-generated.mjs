import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await snapshot(file));
    else result[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
const before = { openapi: await readFile('docs/openapi.json', 'utf8'), generated: await snapshot('packages/api-client/src/generated') };
const result = spawnSync('pnpm', ['openapi:generate'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(1);
const after = { openapi: await readFile('docs/openapi.json', 'utf8'), generated: await snapshot('packages/api-client/src/generated') };
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error('OpenAPI 또는 생성 SDK drift가 있습니다. 재생성된 변경을 검토하세요.');
  process.exit(1);
}
console.log('OpenAPI와 생성 SDK drift 없음');

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const roots = ['apps', 'packages'].flatMap(parent => readdirSync(parent, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(`${parent}/${entry.name}/package.json`))
  .map(entry => `${parent}/${entry.name}`));
// AC-09의 최종 DAG 중 현재 존재하는 node만 둔다. `apps/worker`와 여섯 feature module의
// edge는 해당 package·feature를 실제로 만드는 phase에서 이 표와 함께 추가한다.
const allowed: Record<string, string[]> = {
  'apps/web': ['@devfootnote/api-client'],
  'apps/api': ['@devfootnote/backend'],
  'packages/backend': [],
  'packages/api-client': [],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}

function imports(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) throw new Error(`정적 검증할 수 없는 import: ${file}`);
      result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

describe('package·feature 소유권 경계', () => {
  it('현재 workspace node와 edge가 승인된 DAG의 부분집합이다', () => {
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(Object.keys(allowed)).toContain(root);
      const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
      for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@devfootnote/'))) expect(allowed[root]).toContain(dependency);
      for (const version of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) expect(version).toMatch(/^(workspace:\*|catalog:|\d+\.\d+\.\d+)$/);
    }
  });
  it('source import가 public entry와 package 경계를 지킨다', () => {
    for (const root of roots) for (const file of files(`${root}/src`).filter(file => /\.tsx?$/.test(file))) {
      for (const specifier of imports(file)) {
        if (specifier.startsWith('@devfootnote/')) expect(allowed[root], `${file}: ${specifier}`).toContain(specifier);
        // 상대 import가 자기 package를 벗어나면 public entry를 우회한 deep import다.
        if (specifier.startsWith('.')) {
          const target = path.normalize(path.join(path.dirname(file), specifier));
          expect(target.startsWith(`${root}/src/`), `${file} → ${target}`).toBe(true);
        }
        if (root.startsWith('apps/')) expect(specifier).not.toMatch(/^(pg|drizzle-orm)(\/|$)/);
        if (root === 'apps/web') expect(specifier).not.toMatch(/^@nestjs\//);
      }
    }
  });
  it('backend root는 DB·Repository·schema를 노출하지 않는다', () => {
    const manifest = JSON.parse(readFileSync('packages/backend/package.json', 'utf8'));
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    const program = ts.createProgram(['packages/backend/src/index.ts'], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, experimentalDecorators: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile('packages/backend/src/index.ts');
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error('backend 공개 진입점을 읽을 수 없습니다.');
    for (const exported of checker.getExportsOfModule(symbol)) {
      const resolved = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      for (const declaration of resolved.declarations ?? []) expect(declaration.getSourceFile().fileName).not.toMatch(/\/database\/|\.(schema|repository|store)\.ts$/);
    }
  });
  it('상태 의존 작업은 cache hit로 검사를 생략하지 않는다', () => {
    const turbo = JSON.parse(readFileSync('turbo.json', 'utf8'));
    expect(turbo.tasks.dev).toMatchObject({ cache: false, persistent: true });
    for (const task of ['test:integration', 'test:browser', 'db:migrate', 'db:generate']) expect(turbo.tasks[task].cache).toBe(false);
  });
  it('OpenAPI operation ID·응답 상태·설명과 생성 경계를 유지한다', () => {
    const api = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    const ids: string[] = [];
    for (const item of Object.values(api.paths)) for (const operation of Object.values(item as Record<string, { operationId: string }>)) ids.push(operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
    for (const route of ['live', 'ready']) for (const status of ['200', '500']) {
      expect(api.paths[`/api/v1/health/${route}`].get.responses[status].description).not.toBe('');
    }
    expect(api.paths['/api/v1/health/ready'].get.responses['503']).toBeDefined();
  });
  it('공유 의존성 버전을 catalog 한 곳에서 exact로 소유한다', () => {
    const lines = readFileSync('pnpm-workspace.yaml', 'utf8').split('\n');
    const start = lines.indexOf('catalog:');
    expect(start, 'pnpm-workspace.yaml에 catalog 블록이 필요하다').toBeGreaterThanOrEqual(0);
    const entries: string[][] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('  ')) entries.push(line.trim().split(/:\s*/).map(part => part.replace(/'/g, '')));
      else if (line.trim() !== '') break;
    }
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, version] of entries) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    const catalogued = new Set(entries.map(([name]) => name));
    for (const root of roots) {
      const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
      for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
        if (version === 'catalog:') expect(catalogued, `${root}: ${name}`).toContain(name);
      }
    }
  });
  it('build script가 명시적 migration 작업을 포함하지 않는다', () => {
    for (const root of roots) {
      const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
      expect(manifest.scripts.build).not.toMatch(/migrate|generate|DATABASE_URL/);
    }
    for (const file of files('packages/backend/src').filter(file => file.endsWith('.schema.ts'))) expect(readFileSync(file, 'utf8')).not.toMatch(/@nestjs|new Pool|createPool/);
  });
});

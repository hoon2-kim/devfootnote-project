const { resolve } = require('node:path');
const modules = ['auth', 'materials', 'search', 'health'];

module.exports = {
  forbidden: [
    {
      name: 'features-do-not-import-http-composition',
      severity: 'error',
      from: { path: '^apps/api/src/modules/' },
      to: { path: '^apps/api/src/http/' },
    },
    {
      name: 'common-has-no-feature-or-composition-dependency',
      severity: 'error',
      from: { path: '^apps/api/src/common/' },
      to: { path: '^apps/api/src/(modules/|http/|app\\.module\\.ts$|configure-app\\.ts$)' },
    },
    // 생성 SDK의 type-only 상호 참조는 생성기가 소유하며 수동으로 바꾸지 않는다.
    {
      name: 'no-cycles',
      severity: 'error',
      from: { pathNot: '^packages/api-client/src/generated/' },
      to: { circular: true },
    },
    {
      name: 'no-unresolved-api-imports',
      severity: 'error',
      from: { path: '^apps/api/src/' },
      to: { couldNotResolve: true },
    },
    ...modules.flatMap((name) => [
      {
        name: `${name}-public-entry`,
        severity: 'error',
        from: { pathNot: `^apps/api/src/modules/${name}/` },
        to: {
          path: `^apps/api/src/modules/${name}/`,
          pathNot: `^apps/api/src/modules/${name}/index\\.ts$`,
        },
      },
      {
        name: `${name}-no-internal-barrel`,
        severity: 'error',
        from: { path: `^apps/api/src/modules/${name}/` },
        to: { path: `^apps/api/src/modules/${name}/index\\.ts$` },
      },
    ]),
    {
      name: 'no-private-storage-exports',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/index\\.ts$' },
      to: { path: '(\\.schema\\.ts$|repositories/|infrastructure/|application/ports/)' },
    },
    {
      name: 'materials-domain-is-pure',
      severity: 'error',
      from: { path: '^apps/api/src/modules/materials/domain/' },
      to: {
        path: '(node_modules/|^apps/api/src/)',
        pathNot: '^apps/api/src/modules/materials/domain/',
      },
    },
    {
      name: 'materials-application-inward',
      severity: 'error',
      from: { path: '^apps/api/src/modules/materials/application/' },
      to: {
        path: '(materials/(infrastructure|presentation)/|src/infrastructure/database/|node_modules/(drizzle-orm|pg|express|@nestjs/swagger)/)',
      },
    },
    {
      name: 'http-does-not-access-storage',
      severity: 'error',
      from: {
        path: '(\\.controller\\.ts$|/presentation/|/dto/|/guards/|/strategies/|^apps/api/src/(common|http)/)',
      },
      to: {
        path: '(\\.schema\\.ts$|\\.repository\\.ts$|/infrastructure/database/|node_modules/(pg|drizzle-orm)/)',
      },
    },
    {
      name: 'business-does-not-import-http',
      severity: 'error',
      from: {
        path: '(materials/(application|domain|infrastructure)/|auth/(services/(auth|token)\\.service|repositories/)|search/search\\.service)',
      },
      to: {
        path: '(/presentation/|/dto/|\\.controller\\.ts$|node_modules/(express|@nestjs/swagger)/)',
      },
    },
    {
      name: 'infrastructure-has-no-feature-policy',
      severity: 'error',
      from: { path: '^apps/api/src/infrastructure/' },
      to: { path: '^apps/api/src/modules/' },
    },
    {
      name: 'no-cross-app-imports',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^(apps/web|packages/api-client)/' },
    },
    {
      name: 'frontend-does-not-import-backend',
      severity: 'error',
      from: { path: '^(apps/web|packages/api-client)/' },
      to: { path: '(^apps/api/|node_modules/(pg|drizzle-orm|@nestjs)/)' },
    },
    {
      name: 'generated-client-is-independent',
      severity: 'error',
      from: { path: '^packages/api-client/' },
      to: { path: '^apps/' },
    },
    {
      name: 'auth-has-no-feature-dependency',
      severity: 'error',
      from: { path: '^apps/api/src/modules/auth/' },
      to: { path: '^apps/api/src/modules/', pathNot: '^apps/api/src/modules/auth/' },
    },
    {
      name: 'materials-business-has-no-feature-dependency',
      severity: 'error',
      from: { path: '^apps/api/src/modules/materials/(application|domain|infrastructure)/' },
      to: { path: '^apps/api/src/modules/', pathNot: '^apps/api/src/modules/materials/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: resolve('apps/api/tsconfig.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};

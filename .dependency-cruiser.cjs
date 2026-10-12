const { resolve } = require('node:path');
const modules = ['auth', 'materials', 'search', 'health', 'indexing', 'usage-retention', 'answers'];
const webFeatures = ['auth', 'library', 'search', 'documents', 'indexing', 'answers'];

module.exports = {
  forbidden: [
    {
      name: 'budget-reservation-owned-access',
      severity: 'error',
      from: {
        pathNot:
          '(^packages/db/|^apps/(api|worker)/src/modules/usage-retention/[^/]+\\.repository\\.ts$)',
      },
      to: { path: '^packages/db/(src|dist)/usage-retention/' },
    },
    ...['auth', 'materials', 'indexing', 'usage-retention', 'answers'].map((name) => ({
      name: `${name}-schema-owned-access`,
      severity: 'error',
      from: {
        pathNot: `(^packages/db/|^apps/(api|worker)/src/modules/${name}/(repositories/|infrastructure/|[^/]+\\.repository\\.ts$))`,
      },
      to: { path: `^packages/db/(src|dist)/schema/${name}\\.(ts|js)$` },
    })),
    {
      name: 'shared-backend-packages-are-policy-free',
      severity: 'error',
      from: { path: '^packages/(db|queue|ai)/' },
      to: { path: '(^apps/|node_modules/@nestjs/)' },
    },
    {
      name: 'worker-does-not-import-other-apps',
      severity: 'error',
      from: { path: '^apps/worker/' },
      to: { path: '^apps/(api|web)/' },
    },
    ...['indexing', 'materials', 'usage-retention', 'answers'].flatMap((name) => [
      {
        name: `worker-${name}-public-entry`,
        severity: 'error',
        from: { pathNot: `^apps/worker/src/modules/${name}/` },
        to: { path: `^apps/worker/src/modules/${name}/`, pathNot: '/index\\.ts$' },
      },
      {
        name: `worker-${name}-no-internal-barrel`,
        severity: 'error',
        from: { path: `^apps/worker/src/modules/${name}/` },
        to: { path: `^apps/worker/src/modules/${name}/index\\.ts$` },
      },
    ]),
    ...['materials', 'usage-retention'].map((name) => ({
      name: `worker-${name}-has-no-feature-dependency`,
      severity: 'error',
      from: { path: `^apps/worker/src/modules/${name}/` },
      to: {
        path: '^apps/worker/src/modules/',
        pathNot: `^apps/worker/src/modules/${name}/`,
      },
    })),
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
      from: { path: '^(apps/(api|worker)/src/|packages/(db|queue|ai)/src/)' },
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
      from: { path: '^apps/(api|worker)/src/modules/[^/]+/index\\.ts$' },
      to: {
        path: '(\\.schema\\.ts$|\\.repository\\.ts$|repositories/|infrastructure/|application/ports/)',
      },
    },
    {
      name: 'materials-domain-is-pure',
      severity: 'error',
      from: { path: '^apps/api/src/modules/materials/domain/' },
      to: {
        path: '(node_modules/|^apps/|^packages/)',
        pathNot: '^apps/api/src/modules/materials/domain/',
      },
    },
    {
      name: 'materials-application-inward',
      severity: 'error',
      from: { path: '^apps/api/src/modules/materials/application/' },
      to: {
        path: '(materials/(infrastructure|presentation)/|src/infrastructure/database/|^packages/db/|node_modules/(drizzle-orm|pg|express|@nestjs/swagger)/)',
      },
    },
    {
      name: 'http-does-not-access-storage',
      severity: 'error',
      from: {
        path: '(\\.controller\\.ts$|/presentation/|/dto/|/guards/|/strategies/|^apps/api/src/(common|http)/)',
      },
      to: {
        path: '(\\.schema\\.ts$|\\.repository\\.ts$|/infrastructure/database/|^packages/db/|node_modules/(pg|drizzle-orm)/)',
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
      from: { path: '^apps/(api|worker)/src/infrastructure/' },
      to: { path: '^apps/(api|worker)/src/modules/' },
    },
    {
      name: 'no-cross-app-imports',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^(apps/(web|worker)|packages/api-client)/' },
    },
    {
      name: 'frontend-does-not-import-backend',
      severity: 'error',
      from: { path: '^(apps/web|packages/api-client)/' },
      to: {
        path: '(^apps/(api|worker)/|^packages/(db|queue|ai)/|node_modules/(pg|drizzle-orm|@nestjs)/)',
      },
    },
    {
      name: 'generated-client-is-independent',
      severity: 'error',
      from: { path: '^packages/api-client/' },
      to: { path: '^apps/' },
    },
    ...webFeatures.map((name) => ({
      name: `web-${name}-public-entry`,
      severity: 'error',
      from: { pathNot: `^apps/web/src/features/${name}/` },
      to: {
        path: `^apps/web/src/features/${name}/`,
        pathNot: `^apps/web/src/features/${name}/index\\.ts$`,
      },
    })),
    {
      name: 'web-ui-is-domain-neutral',
      severity: 'error',
      from: { path: '^apps/web/src/components/ui/' },
      to: {
        path: '(^apps/web/src/features/|^apps/web/src/lib/api-(client|provider)\\.tsx?$|^packages/api-client/)',
      },
    },
    {
      name: 'web-transport-does-not-import-ui',
      severity: 'error',
      from: { path: '^apps/web/src/lib/api-client\\.ts$' },
      to: { path: '^apps/web/src/(features|components|app)/' },
    },
    {
      name: 'auth-storage-does-not-import-services',
      severity: 'error',
      from: { path: '^apps/api/src/modules/auth/repositories/' },
      to: { path: '^apps/api/src/modules/auth/services/' },
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

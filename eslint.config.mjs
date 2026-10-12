import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.next-playwright/**',
      '**/node_modules/**',
      '**/src/generated/**',
      '**/next-env.d.ts',
      'test-results/**',
      'playwright-report/**',
      '.gjc/**',
      '.codex/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      curly: ['error', 'all'],
      // Prettier는 줄바꿈 폭을, ESLint는 제어 흐름 사이의 읽기 간격을 맡는다.
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try'] },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
      ],
    },
  },
  {
    files: ['.dependency-cruiser.cjs'],
    languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bullmq',
              importNames: ['Worker', 'QueueScheduler', 'JobScheduler'],
              message: 'consumer·scheduler는 apps/worker에서만 등록합니다.',
            },
          ],
        },
      ],
    },
  },
  // Playwright fixture는 의존성이 없어도 첫 인자에 객체 구조 분해를 요구한다.
  {
    files: ['tests/browser/**/*.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
);

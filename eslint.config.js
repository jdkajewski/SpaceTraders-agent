// @ts-check
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      'packages/api/prisma/**',
      // Generated Prisma client — never lint generated code.
      '**/generated/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    // Fastify async plugins (autoload/fastify-plugin contract) must use the
    // `async` signature even when the body registers routes synchronously.
    files: ['packages/api/src/app.ts', 'packages/api/src/routes/**/*.ts', 'packages/api/src/plugins/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Test files are excluded from the package tsconfigs, so the type-checked
    // project service can't resolve them — disable type-aware linting there.
    files: ['**/__tests__/**', '**/*.test.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettierConfig,
);
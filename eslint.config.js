// @ts-check
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', 'packages/api/prisma/**'],
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
    // Test mocks frequently declare async stubs with no `await`.
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettierConfig,
);
import globals from 'globals';
import prettier from 'eslint-plugin-prettier';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat();

export default [
  // Old .eslintrc config (old style for plugins that don't support flat config)
  ...compat.config({
    root: true,
    ignorePatterns: ['dist', 'node_modules'],
    plugins: ['prettier', '@typescript-eslint'],
    extends: [
      'plugin:@typescript-eslint/eslint-recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:prettier/recommended',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 1,
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  }),

  // Flat config (new style)
  {
    files: ['**/*.ts'],
    ignores: ['dist/*', 'node_modules/*'],
    plugins: { prettier, typescriptEslint },
    rules: {
      'no-console': 1,
      'no-var': 1,
      camelcase: 1,
      'arrow-body-style': 1,
      semi: [2, 'always'],
    },
    languageOptions: {
      ecmaVersion: 12,
      sourceType: 'module',
      globals: {
        commonjs: true,
        browser: true,
        es6: true,
        ...globals.browser,
      },
    },
  },
];

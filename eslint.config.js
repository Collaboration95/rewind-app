const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['node_modules/**', '.expo/**', 'dist/**', 'coverage/**'],
  },
  {
    files: ['server/tests/**/*.mjs'],
    rules: {
      // These tests import server/dist after the server TypeScript build;
      // lint runs before that generated directory exists in CI.
      'import/no-unresolved': 'off',
    },
  },
]);

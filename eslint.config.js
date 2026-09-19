const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['node_modules/**', '.expo/**', 'dist/**', 'server/dist/**', 'coverage/**'],
  },
  {
    files: ['server/tests/**/*.mjs'],
    rules: {
      // These tests import server/dist after the server TypeScript build;
      // lint runs before that generated directory exists in CI.
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['scripts/production-e2e-server.mjs', 'scripts/web-smoke-server.mjs'],
    rules: {
      // These harnesses import server/dist after the server TypeScript build;
      // lint runs before that generated directory exists in clean CI.
      'import/no-unresolved': 'off',
    },
  },
]);

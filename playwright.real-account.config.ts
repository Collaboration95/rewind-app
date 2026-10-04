import { defineConfig } from '@playwright/test';

const runId = process.env.REWIND_REAL_ACCOUNT_RUN ?? 'single';

export default defineConfig({
  outputDir: process.env.REWIND_REAL_ACCOUNT_OUTPUT_DIR ?? `test-results/real-account-${runId}`,
  reporter: 'list',
  testDir: './tests/e2e-real-account',
  testMatch: 'real-account.spec.mjs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: process.env.REWIND_REAL_ACCOUNT_WEB_ORIGIN,
    browserName: 'firefox',
    ignoreHTTPSErrors: false,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});

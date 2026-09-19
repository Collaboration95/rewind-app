import { defineConfig } from '@playwright/test';

const runId = process.env.REWIND_E2E_RUN ?? 'single';

export default defineConfig({
  outputDir: `test-results/production-e2e-${runId}`,
  reporter: 'list',
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:8083',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node scripts/production-e2e-server.mjs',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:8083/api/health',
  },
});

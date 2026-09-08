import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: 'list',
  testDir: './tests/responsive',
  use: {
    baseURL: 'http://127.0.0.1:8082',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx expo serve dist --port 8082',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:8082',
  },
});

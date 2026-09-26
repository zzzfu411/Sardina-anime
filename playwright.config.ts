import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  expect: { timeout: 12_000 },
  use: {
    baseURL: 'http://127.0.0.1:4179',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        browserName: 'chromium',
        channel: 'chrome',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
  webServer: {
    command: 'node --import tsx tests/e2e-server.ts',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: [['list'], ['json', { outputFile: '.cache/e2e-results.json' }]],
});

import { defineConfig } from '@playwright/test';

// End-to-end tests against a running Grafana with this plugin installed (`make run`). They use the
// locally installed Google Chrome, sign in as a temporary Viewer and clean up after themselves.
//
//   GRAFANA_URL=http://localhost:3000 VM_URL=http://localhost:8428 npx playwright test
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.GRAFANA_URL ?? 'http://localhost:3000',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1680, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

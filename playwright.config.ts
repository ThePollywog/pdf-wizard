import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite: `npx playwright test` (or `npm run test:e2e`).
 * Starts its own Vite dev server (port 5199) so it never touches a developer's running instance.
 * Every test gets a fresh browser context, so the file library (IndexedDB) starts empty. The dev server is required: tests read `window.__app`
 * and `window.__engine`, which only exist in development builds.
 */
// Override with E2E_WEB_PORT to run several suites side by side.
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5199);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // One at a time: timing-sensitive UI tests are more deterministic this way.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: `/tmp/pdfwizard-e2e-results-${WEB_PORT}`,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `VITE_NO_WATCH=1 PORT=${WEB_PORT} VITE_CACHE_DIR=node_modules/.vite-e2e-${WEB_PORT} npx vite --port ${WEB_PORT} --strictPort`,
    url: `http://localhost:${WEB_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

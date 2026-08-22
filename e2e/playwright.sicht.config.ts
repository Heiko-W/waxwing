import { defineConfig, devices } from '@playwright/test'

/**
 * The 2026-08-22 visual sweep of the surfaces the JMAP-gap waves added.
 *
 * Three widths, one signed-in session per suite: 390 px (phone, portrait 844 so a dialog that
 * does not fit is visible as such), 834 px (tablet — the 40em..64em band where the folder rail is
 * a drawer and the view rail is icons) and 1280 px (desktop).
 *
 * `hasTouch` on the two narrow projects is load-bearing and not decoration: `tokens.css` keys
 * `--waxwing-control-min` off `@media (pointer: coarse)` — 2.125rem (34 px) fine, 2.75rem (44 px)
 * coarse. A run without it measures the desktop number and reports touch-target failures that do
 * not exist, which is exactly what an earlier pass did.
 */
const PORT = 4183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './audit',
  testMatch: ['**/sicht-*.spec.ts'],
  // One fixture account, and several of these suites create and delete real server state.
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  retries: 0,
  reporter: [['list']],
  globalSetup: './sicht.setup.mjs',
  use: {
    locale: 'en-US',
    baseURL: BASE_URL,
    trace: 'off',
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 834, height: 1112 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { WAXWING_E2E: '1' },
  },
})

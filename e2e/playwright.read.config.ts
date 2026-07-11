import { defineConfig, devices } from '@playwright/test'

// M1.9 read E2E suite. Unlike the self-contained placeholder config, this drives the REAL
// production bundle against the live Stalwart fixture:
//   - the webServer builds apps/web and serves it with `vite preview` PLUS the same-origin
//     Stalwart proxy (WAXWING_E2E=1 → vite.config preview.proxy), so the browser only ever
//     talks to this one origin (no CORS, no cross-origin loopback);
//   - globalSetup brings the fixture up advertising THIS origin (STALWART_PUBLIC_URL) and seeds
//     alice's inbox; globalTeardown tears it down (skip with WAXWING_KEEP_FIXTURE=1).
//
// Run: `pnpm e2e:read` (self-manages the fixture) — see scripts/verify-read-e2e.mjs for the
// chromium-install + teardown-guaranteed wrapper used by `pnpm verify:e2e`.
const PORT = 4183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/read.spec.ts'],
  // One seeded account, stateful mutations (flag/move/delete/live-deliver) → keep it serial and
  // reseed per test (see read.spec.ts beforeEach), so ordering never makes a test flaky.
  fullyParallel: false,
  workers: 1,
  // Live login + initial sync + reading take a few seconds against the real server.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './read.setup.mjs',
  globalTeardown: './read.teardown.mjs',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the shipping bundle, then preview it with the same-origin Stalwart proxy switched on.
    command:
      'pnpm --filter @waxwing/web exec vite build && ' +
      `pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { WAXWING_E2E: '1' },
  },
})

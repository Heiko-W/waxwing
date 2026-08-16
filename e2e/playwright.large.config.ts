import { defineConfig, devices } from '@playwright/test'

/**
 * M4.8 large-mailbox perf config (NFR-PERF-02).
 *
 * Deliberately WITHOUT the read config's globalSetup/teardown. Seeding 100 000 messages takes about
 * eight minutes, and that teardown destroys the volume — so sharing it would mean either re-seeding
 * on every run or silently measuring an empty folder. This config assumes a fixture that is already
 * up and already seeded, which is what `pnpm e2e:large` arranges:
 *
 *     pnpm e2e:server            # fixture up
 *     pnpm seed:large 100000     # ~8 minutes, idempotent (reseed removes the previous batch)
 *     pnpm e2e:large             # measure
 *     pnpm e2e:server:down       # when finished
 *
 * It is not part of `pnpm gate` for the same reason: an eight-minute seed on every gate run would
 * make the gate something nobody runs. The numbers it produces are recorded in the plan instead.
 */
const PORT = 4183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/perf-large.spec.ts'],
  fullyParallel: false,
  workers: 1,
  // A cold sync of a 100 k mailbox's first window is not instant, and the point of the suite is what
  // happens AFTER that — so the timeout is generous and the budgets inside the tests are not.
  timeout: 180_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  // Brings the fixture up advertising the APP origin (no teardown — it would destroy the seed).
  globalSetup: './large.setup.mjs',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm --filter @waxwing/web exec vite build && ' +
      `pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { WAXWING_E2E: '1' },
  },
})

import { defineConfig, devices } from '@playwright/test'

/**
 * M5.15 WebKit smoke suite — the ONE suite in this repo that does not run on Chromium.
 *
 * It exists because two Safari-only defects shipped: the mail screen failed to render at all, and no
 * link in a message opened. Both passed every Chromium suite here, because the engines differ in
 * exactly the two places those defects lived — IndexedDB cursor support and event delivery out of a
 * sandboxed frame. `tests/webkit.spec.ts` says which, at length.
 *
 * Same fixture, same seeded corpus and the same `webServer` as the read suite, on its own port so
 * the two can run side by side. Keep it small: everything that behaves identically in both engines
 * belongs in the Chromium suites, which are faster and already own it.
 *
 * Run: `pnpm e2e:webkit` (self-manages the fixture). The browser needs `playwright install webkit`.
 */
const PORT = 4187
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/webkit.spec.ts'],
  fullyParallel: false,
  workers: 1,
  // A live login plus the initial sync against the real server, on a slower engine.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './webkit.setup.mjs',
  globalTeardown: './read.teardown.mjs',
  use: {
    // Pinned for the same reason every other config here pins it: the specs assert English labels,
    // and with no `locale` Playwright inherits the host — `de` on this machine, `en-US` on CI.
    locale: 'en-US',
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @waxwing/web build && ' +
      `pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { WAXWING_E2E: '1' },
  },
})

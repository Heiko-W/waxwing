import { defineConfig, devices } from '@playwright/test'

/**
 * The WebKit suite — the ONE run in this repo that does not use Chromium (M5.15, widened by B11).
 *
 * It exists because two Safari-only defects shipped: the mail screen failed to render at all, and no
 * link in a message opened. Both passed every Chromium suite here, because the engines differ in
 * exactly the two places those defects lived — IndexedDB cursor support and event delivery out of a
 * sandboxed frame. `tests/webkit.spec.ts` says which, at length.
 *
 * Same fixture, same seeded corpus and the same `webServer` as the read suite, on its own port so
 * the two can run side by side.
 *
 * **It runs the whole READ suite as well as its own smoke tests (B11).** M5.15 kept this to four
 * tests on the argument that anything behaving identically in both engines belongs in the faster
 * Chromium suites — reasonable, and it left the claim "the reading pane works" a Chromium claim,
 * which is exactly where the two shipped Safari defects lived. `read.spec.ts` is the suite that
 * exercises the sanitizer, the reading pane, the split pane at desktop width and the message list,
 * and it costs about 90 seconds here. One test in it is skipped on WebKit with a reason at the skip
 * (ADR-029: the frame delivers the outer page no click events, so the phishing interstitial cannot
 * be raised); everything else passes on both engines.
 *
 * **What is still Chromium-only, said plainly:** the NARROW layouts. `narrow.spec.ts` and
 * `viewports.spec.ts` get their sizes from dedicated PROJECTS in the read config, not from
 * `test.use`, so adding them here without those projects measures a desktop viewport under a
 * phone's name — tried, and it does exactly that. Giving them WebKit projects of their own is the
 * next step for anyone who wants it; it roughly doubles this run.
 *
 * Run: `pnpm e2e:webkit` (self-manages the fixture); `verify:e2e` runs it, so it is gated. The
 * browser needs `playwright install webkit`, which that script now does.
 */
const PORT = 4187
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/webkit.spec.ts', '**/read.spec.ts'],
  fullyParallel: false,
  workers: 1,
  // A live login plus the initial sync against the real server, on a slower engine. The read suite
  // brings its own long waits, and WebKit is consistently the slower of the two engines here.
  timeout: 120_000,
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

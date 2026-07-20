import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://localhost:${PORT}`

// P0.3 placeholder E2E harness. This suite is deliberately self-contained and needs NO
// JMAP server: Playwright builds and previews the static apps/web bundle and asserts the
// placeholder shell renders. Fixture-backed specs (real login, mailbox listing, send /
// receive round-trips) arrive with P0.4 (the Stalwart Docker fixture) and M1.9 (the read
// E2E suite); those will replace the webServer below with the provisioned Stalwart stack.
export default defineConfig({
  testDir: './tests',
  // ALLOWLIST, not a denylist — and this distinction is load-bearing, because the denylist
  // form silently rotted. Until M3.10 this config carried only `testIgnore: ['**/demo.spec.ts']`
  // and no `testMatch`, so Playwright's default `**/*.@(spec|test).?(c|m)[jt]s?(x)` collected
  // EVERY other spec: read, write, keyboard, swipe and settings — 40 tests across 6 files, five
  // of which need the Stalwart fixture (port 18080), the `WAXWING_E2E=1` same-origin proxy and
  // (for swipe) a `hasTouch` project, none of which this self-contained config provides. Since
  // `scripts/verify-e2e.mjs` runs this suite BEFORE it brings the fixture up, `pnpm verify:e2e`
  // — the project's own full E2E gate — had been red from the moment the specs grew past
  // shell.spec.ts, and nobody noticed because the read/write suites were always run directly.
  //
  // A denylist has to be edited every time a spec file is added and fails OPEN when it is not;
  // an allowlist fails CLOSED (a new spec is simply not collected here until someone opts it
  // in). Same allowlist-vs-preference reasoning as BROWSER_PUSH_TRANSPORTS in
  // apps/web/src/sync/engine/engine.ts, where a `prefer:` ordering silently readmitted the
  // transport it was meant to exclude. Fixture-backed specs belong to playwright.read.config.ts
  // / playwright.write.config.ts; the SP.4 demo spec to playwright.demo.config.ts.
  testMatch: ['**/shell.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // Browser binaries are pinned to the exact @playwright/test version in
      // package.json; install the matching build with `pnpm exec playwright install
      // chromium`.
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build the static bundle, then serve it with `vite preview` on the single PORT
    // constant that also drives BASE_URL / use.baseURL above (one source of truth).
    command: `pnpm --filter @waxwing/web exec vite build && pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Reuse tradeoff: locally (non-CI) an already-running preview on this port is reused
    // as-is, so the `vite build` step above is skipped and a STALE bundle can be tested.
    // CI disables reuse and always rebuilds. If you change app code and reuse a running
    // server locally, restart it (or run with CI=1) to force a rebuild.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

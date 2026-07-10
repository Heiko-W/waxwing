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
  // The SP.4 demo spec has its own config (playwright.demo.config.ts): it needs `pnpm demo`
  // running (fixture + demo dev server), which this self-contained `vite preview` webServer
  // does not provide. Keep it out of the default suite.
  testIgnore: ['**/demo.spec.ts'],
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

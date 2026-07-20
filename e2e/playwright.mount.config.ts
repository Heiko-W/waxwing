import { defineConfig, devices } from '@playwright/test'

// M3.10 `/mail/` MOUNT suite. The app served under a PATH PREFIX instead of the origin root,
// which is the deployment shape Stalwart actually produces (FR-DEP-02) and the one no suite in
// this repo had ever exercised — every other config drives `vite preview`, which only serves at
// `/`. See mount-server.mjs for the full reasoning and tests/mount.spec.ts for what it buys.
//
// NO FIXTURE, deliberately. The defect this suite exists for — the `<base>` element, without
// which a deep-link reload resolves `./assets/*.js` against the route path and white-screens —
// is a static-serving defect and reproduces with no JMAP server at all. Keeping the fixture out
// makes this the second-cheapest suite in the repo (a build plus a few seconds) and lets it run
// BEFORE the Docker-backed suites, so a broken bundle fails fast. The mount server does carry
// the Stalwart proxy for the later M3.10 waves that sign in under the mount; this suite simply
// does not exercise it.
const PORT = 4185
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/mount.spec.ts'],
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
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build the shipping bundle, then serve it under the mount instead of at the root.
    command: `pnpm --filter @waxwing/web exec vite build && node mount-server.mjs --port ${PORT}`,
    // The mount server 302s `/` to the mount, so the readiness probe on the origin root
    // resolves without needing the prefix here.
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})

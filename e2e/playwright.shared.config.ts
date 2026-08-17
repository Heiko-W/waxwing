import { defineConfig, devices } from '@playwright/test'

// M4.4 shared-account (delegated mailbox) E2E suite. The production bundle against the live Stalwart
// fixture, with two real shares granted by the setup: bob's inbox READ-WRITE to alice, carol's inbox
// READ-ONLY. It exists because M4.4's "Done when" — *a fixture delegation setup shows the shared
// mailbox; actions respect rights; primary-account UX unchanged* — cannot be asserted anywhere else:
// without a delegated account `secondaryMailAccounts()` returns `[]` and every M4.4 path is dead code.
//
// Its own port and config rather than a project inside the read config, because the delegation is
// fixture STATE, not a browser setting: it changes what alice's session contains, so it cannot be
// switched per project within one run.
//
// Run: `pnpm e2e:shared`.
const PORT = 4186
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/shared.spec.ts'],
  // One account, stateful mutations across two shared mailboxes — serial, and reseeded per test.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './shared.setup.mjs',
  globalTeardown: './shared.teardown.mjs',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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

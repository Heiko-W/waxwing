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
  // `delegation.spec.ts` (S-4/S-5) belongs here for the same reason as the other two: it needs a
  // second real account to have shared something, and it revokes the suite's mail delegations
  // mid-run to prove a files-only share grows no mail section — which nothing outside a
  // delegation-aware, serial suite may do.
  testMatch: ['**/shared.spec.ts', '**/sharing.spec.ts', '**/delegation.spec.ts'],
  // One account, stateful mutations across two shared mailboxes — serial, and reseeded per test.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './shared.setup.mjs',
  globalTeardown: './shared.teardown.mjs',
  // Pin the browser locale. Playwright does NOT default to en-US: with no `locale` it inherits the
  // host, and on a German machine `navigator.language` comes back as `de` — bare, which even the
  // old exact-match resolver accepted. So every suite here, which asserts English labels
  // (`getByLabel('Username')`, `name: 'Sign in'`), has been quietly depending on the developer's
  // system language. It passes on CI because the runners are en-US, which is the worst version of
  // this: local and hosted disagree and only one of them is checked.
  use: {
    locale: 'en-US',
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

import { defineConfig, devices } from '@playwright/test'

// M2.9 write E2E suite — the REAL production bundle against the live Stalwart fixture, driving the
// composer to COMPOSE + SEND and verifying the outcome over JMAP (see write.setup.mjs +
// seed-write.mjs). Mirrors the M1.9 read config but on its own port (4184) so the two suites'
// preview servers never collide.
const PORT = 4184
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: [
    '**/write.spec.ts',
    '**/settings.spec.ts',
    // Account & security (X-1..X-6): creates and revokes a credential on alice and moves her
    // account locale, so it belongs with the other stateful suites rather than the read harness.
    '**/security.spec.ts',
    '**/contacts.spec.ts',
    '**/calendar.spec.ts',
    // Stateful like the three above, and cleans up after itself for the same reason: there is no
    // file seed for the setup to reset. See the header of `files.spec.ts` on what it owns.
    '**/files.spec.ts',
  ],
  // One shared fixture, stateful sends → serial + per-test reset (see write.spec.ts beforeEach).
  fullyParallel: false,
  workers: 1,
  // Live login + send + a JMAP delivery poll take a few seconds against the real server.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './write.setup.mjs',
  globalTeardown: './write.teardown.mjs',
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

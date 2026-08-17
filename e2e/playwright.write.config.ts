import { defineConfig, devices } from '@playwright/test'

// M2.9 write E2E suite — the REAL production bundle against the live Stalwart fixture, driving the
// composer to COMPOSE + SEND and verifying the outcome over JMAP (see write.setup.mjs +
// seed-write.mjs). Mirrors the M1.9 read config but on its own port (4184) so the two suites'
// preview servers never collide.
const PORT = 4184
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/write.spec.ts', '**/settings.spec.ts', '**/contacts.spec.ts'],
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

import { defineConfig, devices } from '@playwright/test'

// SP.4 raw-demo E2E config. Unlike the default config, it does NOT start its own server: it
// drives a running `pnpm demo` (the Stalwart fixture + the demo dev server, coupled by
// STALWART_PUBLIC_URL = the browser origin). Point it at that origin via WAXWING_DEMO_ORIGIN
// (default http://localhost:5173). The spec skips cleanly when the origin is unreachable, so
// it never fails just because the demo isn't up.
//
//   pnpm demo                # terminal 1 (localhost, secure context)
//   pnpm e2e:demo            # terminal 2
const BASE_URL = process.env.WAXWING_DEMO_ORIGIN ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/demo.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
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
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

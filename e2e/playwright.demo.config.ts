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
})

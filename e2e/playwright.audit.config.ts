import { defineConfig, devices } from '@playwright/test'

/**
 * TEMPORARY capture config for the UI audit (not part of `pnpm verify`, not committed).
 *
 * Unlike playwright.shots.config.ts it brings NOTHING up: the Stalwart fixture and the dev server
 * on 4183 are already running, so there is no webServer and no globalSetup to re-seed underneath a
 * session that is already signed in.
 *
 * The phone project sets `isMobile` + `hasTouch` deliberately: without them the context reports
 * `pointer: fine`, tokens.css keeps `--waxwing-control-min` at its 34 px desktop value, and every
 * screenshot understates how much room the chrome actually takes on a phone.
 */
const BASE_URL = 'http://localhost:4183'

export default defineConfig({
  testDir: './audit',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    locale: 'de-DE',
    baseURL: BASE_URL,
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      // The middle tier (40em-64em): a folder DRAWER plus the list|reading split. No suite in the
      // repo has ever run at this width - `narrow.spec.ts` is 390 px and everything else is 1280 px.
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 834, height: 1112 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
})

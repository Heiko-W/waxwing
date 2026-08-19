import { defineConfig, devices } from '@playwright/test'

// Project-site screenshots — an ARTEFACT run, not a verification run.
//
// This is the only config in this directory whose output is files a human looks at rather than
// assertions a machine checks. It lives here, and not in a standalone script, for the reason
// ADR-003 gives: bringing up the Stalwart fixture, seeding alice's inbox, building the shipping
// bundle and serving it behind the same-origin proxy is four things that already work exactly
// once in this repository. A screenshot script that reimplemented them would drift from them,
// and the first sign would be a marketing image of a version nobody ships.
//
// `docs/site/shots/README.md` says when to re-run it and what each image is for.
//
//   pnpm shots        capture + convert to WebP
//
// The suite is in `./shots`, NOT `./tests` — the allowlist in every other config would not
// collect it either way, but the directory split says which files are load-bearing: a test that
// stops matching is a defect, a screenshot that stops matching is a stale picture.
const PORT = 4183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './shots',
  // Serial: the fixture is one seeded account and several of these mutate what they photograph
  // (opening a message marks it read). Reseeded per test, same as read.spec.ts.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  // No retries. A flaky screenshot is a wrong screenshot, and a retry would hide which.
  retries: 0,
  reporter: [['list']],
  globalSetup: './read.setup.mjs',
  globalTeardown: './read.teardown.mjs',
  use: {
    // Same reason as every other config here: without this, `navigator.language` is the
    // developer's, and the app would be photographed in whatever language the machine speaks.
    // These images are published, so that failure mode would be visible to everyone but the
    // person who produced them.
    locale: 'en-US',
    baseURL: BASE_URL,
  },
  projects: [
    {
      // 1440×900 at 2× — a laptop, not a 4K desktop, because the site renders these at ~736 px
      // and a wider capture only shrinks the type further.
      name: 'desktop',
      testMatch: '**/desktop.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
    {
      // 834×1112 — an iPad in portrait, and the only width where the two shell breakpoints
      // disagree: past 40em (icon rail, not a bottom bar) and short of 64em (folder rail still a
      // drawer). Neither of the other two projects photographs that combination.
      name: 'tablet',
      testMatch: '**/tablet.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 834, height: 1112 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // The phone shots are the point of this run. 390×844 is the iPhone 14/15 class viewport the
      // swipe suite already uses, and it sits below BOTH shell breakpoints (40em icon rail,
      // 64em persistent folder rail), so it photographs the bottom-nav-plus-drawer layout rather
      // than a squeezed desktop. `isMobile` + `hasTouch` are load-bearing, not decoration: the
      // token sheet keys `@media (pointer: coarse)` off them for touch target sizes.
      name: 'phone',
      testMatch: '**/phone.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
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

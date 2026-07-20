import { defineConfig, devices } from '@playwright/test'

// M1.9 read E2E suite. Unlike the self-contained placeholder config, this drives the REAL
// production bundle against the live Stalwart fixture:
//   - the webServer builds apps/web and serves it with `vite preview` PLUS the same-origin
//     Stalwart proxy (WAXWING_E2E=1 → vite.config preview.proxy), so the browser only ever
//     talks to this one origin (no CORS, no cross-origin loopback);
//   - globalSetup brings the fixture up advertising THIS origin (STALWART_PUBLIC_URL) and seeds
//     alice's inbox; globalTeardown tears it down (skip with WAXWING_KEEP_FIXTURE=1).
//
// Run: `pnpm e2e:read` (self-manages the fixture) — see scripts/verify-read-e2e.mjs for the
// chromium-install + teardown-guaranteed wrapper used by `pnpm verify:e2e`.
const PORT = 4183
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  // The M3.8 keyboard suite rides along here: it needs exactly this fixture (a seeded inbox with
  // several messages, an Archive and a Trash folder) and reseeds per test like read.spec does.
  testMatch: [
    '**/read.spec.ts',
    '**/keyboard.spec.ts',
    '**/swipe.spec.ts',
    '**/offline.spec.ts',
    '**/push.spec.ts',
    '**/pwa.spec.ts',
    '**/notify.spec.ts',
  ],
  // One seeded account, stateful mutations (flag/move/delete/live-deliver) → keep it serial and
  // reseed per test (see read.spec.ts beforeEach), so ordering never makes a test flaky.
  fullyParallel: false,
  workers: 1,
  // Live login + initial sync + reading take a few seconds against the real server.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './read.setup.mjs',
  globalTeardown: './read.teardown.mjs',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The swipe suite needs a touchscreen; a desktop context cannot dispatch a touch at all, and
      // the notify suite needs a browser build that can show a notification at all (see below).
      testIgnore: ['**/swipe.spec.ts', '**/notify.spec.ts'],
    },
    {
      // M3.9 step 5 (FR-LST-06). A phone-shaped context with a real touchscreen, because the two
      // things the unit tests are structurally blind to are exactly the two that decide whether the
      // gesture works on a device: `touch-action: pan-y` (jsdom computes no CSS, so it cannot tell
      // a swipe from a scroll) and the browser's own scroll disambiguation. Driven through CDP
      // Input.dispatchTouchEvent — Playwright has no swipe primitive, and page.touchscreen only taps.
      name: 'chromium-touch',
      testMatch: '**/swipe.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      // M3.10 wave 3 (FR-NOTIF-01/03, FR-AUTH-05). Two `use` settings, and BOTH are load-bearing —
      // without either one the whole notification suite is green and proves nothing.
      //
      // `channel: 'chromium'` — because `devices['Desktop Chrome']` sets NO channel, so every other
      // project in this repo runs on Playwright's default browser: the chromium HEADLESS SHELL. The
      // shell has no notification platform at all. Measured, on this machine, with that exact device
      // config: `Notification.permission` is **denied** (grantPermissions notwithstanding),
      // `registration.showNotification()` throws a TypeError, and `getNotifications()` returns 0.
      // The full chromium build grants, shows and lists. `playwright install chromium` already
      // installs both binaries, so the verify:e2e gate needs no change for this.
      //
      // The trap this avoids is specific and was measured: an `addInitScript` spy on
      // `showNotification` records the call in BOTH browsers — including the one that refused
      // outright. A suite built on the spy alone, under the default project, would pass every
      // positive assertion with zero notifications ever having existed.
      //
      // `permissions` — the notifier never asks; the Settings switch does, and only from a real
      // click (NotificationsSection.tsx). Granting at the context level makes `permission.state`
      // 'granted' before the switch is touched, so the switch takes its no-prompt branch.
      name: 'chromium-notify',
      testMatch: '**/notify.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        permissions: ['notifications'],
      },
    },
  ],
  webServer: {
    // Build the shipping bundle, then preview it with the same-origin Stalwart proxy switched on.
    command:
      'pnpm --filter @waxwing/web exec vite build && ' +
      `pnpm --filter @waxwing/web exec vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { WAXWING_E2E: '1' },
  },
})

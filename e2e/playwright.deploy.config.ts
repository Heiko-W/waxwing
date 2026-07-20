import { defineConfig, devices } from '@playwright/test'

// M3.10 DEPLOY suite — the two things a static-only client promises a hoster, neither of which any
// existing harness can express (FR-DEP-04, FR-OFF-01; handed over from M3.5):
//
//   1. edit config.json / manifest.json in the deployed directory and the branding changes on the
//      next load, with NO rebuild;
//   2. push a new build over the old one and the running tab is OFFERED it — a sticky toast, never
//      a forced reload — and accepting flushes open drafts before it goes.
//
// Both need a document root the test can REWRITE UNDER THE RUNNING SERVER, and `vite preview`
// cannot give one: it is a single immutable tree per run, and a second preview on a second port is
// a different ORIGIN, hence a different service-worker registration — which is precisely the thing
// under test. So this suite serves its own root (mount-server.mjs `--root`) out of a directory
// pwa-build.mjs owns, at the ORIGIN ROOT (`--mount /`), because a deployment shape is not what
// these tests are about — tests/mount.spec.ts covers that.
//
// WITH the fixture: the draft-flush half needs a real session and a real composer, and there is no
// way to have those without a JMAP server. That is also why this suite cannot simply be folded into
// the fixture-free mount suite.
//
// Serial and single-worker, and this is load-bearing rather than caution: the served directory is
// SHARED MUTABLE STATE. Two tests staging different builds into it concurrently is a guaranteed
// heisenbug, and the beforeEach that resets it to build A only works if nothing else is running.
const PORT = 4186
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/deploy.spec.ts'],
  fullyParallel: false,
  workers: 1,
  // A staged deploy is a build, a worker install, a toast, a composer and a reload end to end.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './pwa.setup.mjs',
  globalTeardown: './pwa.teardown.mjs',
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
    // The build runs HERE rather than in globalSetup, so the document root provably exists before
    // the readiness probe hits it — Playwright does not guarantee that globalSetup precedes the
    // webServer, and a server whose root is missing fails in a way that reads as a network problem.
    command: `node pwa-build.mjs && node mount-server.mjs --port ${PORT} --mount / --root .pwa/root`,
    url: BASE_URL,
    // NEVER reuse. The whole suite is about which bytes are on disk behind this server, and a
    // leftover server from an earlier run is serving an earlier `.pwa/root` — the one failure mode
    // that would make every assertion here quietly meaningless.
    reuseExistingServer: false,
    timeout: 120_000,
  },
})

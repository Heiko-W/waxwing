import { defineConfig } from 'vitest/config'

// Dedicated config for the SP.1 live-fixture integration suite. It is intentionally NOT a
// project of the root `vitest.config.ts`, so `pnpm test` / `pnpm verify` stay hermetic and
// offline. Run it explicitly with `pnpm --filter @waxwing/jmap test:integration` after
// `pnpm e2e:server` is up.
//
// The suite imports `@waxwing/jmap` (the public entry) so it exercises exactly the surface an
// app consumes; the alias points that specifier at the package source, avoiding a build step
// and any stale `dist`.
export default defineConfig({
  resolve: {
    alias: {
      '@waxwing/jmap': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    name: 'jmap-integration',
    environment: 'node',
    // ONLY the integration suffix, under test/ — never the co-located unit specs in src/.
    include: ['test/integration/**/*.integration.test.ts'],
    // Network + a cold Stalwart container: give calls generous headroom.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /*
     * ONE FILE AT A TIME. These suites share a single live Stalwart, and vitest runs files in
     * parallel by default — so their setups compete for the same server with no coordination at all.
     *
     * That was theoretical until B17's suite arrived: it seeds 120 messages to build a result set
     * larger than the client's window, and on the hosted runner the sharing suite's `beforeAll`
     * came back `TypeError: fetch failed` / `SocketError: other side closed` while it ran. Nine
     * tests skipped, on a green local run — the difference being how much the machine can do at
     * once, which is exactly the kind of thing a shared fixture must not depend on.
     *
     * Every Playwright config against this fixture already says `workers: 1` for the same reason.
     * This is that decision, for the suites that talk to it without a browser.
     */
    fileParallelism: false,
  },
})

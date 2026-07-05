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
  },
})

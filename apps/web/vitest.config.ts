import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// The web unit/component project: jsdom + Testing Library. It reuses the app's Vite
// config (React plugin, module resolution, CSS Modules) and layers the test
// environment on top. `fake-indexeddb/auto` is included here too because the Dexie
// replica and its unit tests live in apps/web/src/sync (M1.2), so those tests get a
// working IndexedDB without extra setup.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'web',
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./vitest.setup.ts', 'fake-indexeddb/auto'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      restoreMocks: true,
      // No passWithNoTests: the App example tests always exist, so a zero-test
      // collection here should fail loudly rather than report a false green.
    },
  }),
)

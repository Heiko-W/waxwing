import { defineConfig } from 'vitest/config'

// Vitest 4 test projects. The standalone `vitest.workspace` file was removed in v4;
// `test.projects` in the root config is the current idiom. One project per runtime:
//
//  - "unit": Node environment for packages/*. `fake-indexeddb/auto` is preloaded so
//    Dexie-touching unit tests get a working IndexedDB with no per-test wiring (P0.3);
//    the first real consumers land in SP.1 / M1.2.
//  - "web":  jsdom + Testing Library, configured in apps/web/vitest.config.ts so the
//    Vite React plugin, jsdom and RTL all resolve from the app package.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.{test,spec}.ts'],
          setupFiles: ['fake-indexeddb/auto'],
          // No passWithNoTests: this project spans all packages/* and jmap always
          // supplies a test, so a zero-test collection should fail loudly (it would mean
          // the include glob or the example test broke — exactly what P0.3 guards).
        },
      },
      './apps/web/vitest.config.ts',
    ],
  },
})

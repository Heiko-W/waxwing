import { defineConfig } from 'vitest/config'

// Vitest 4 test projects. The standalone `vitest.workspace` file was removed in v4;
// `test.projects` in the root config is the current idiom. One project per runtime:
//
//  - "unit": Node environment for packages/* and apps/web's non-DOM logic.
//    `fake-indexeddb/auto` is preloaded so Dexie/IndexedDB-touching unit tests get a
//    working IndexedDB with no per-test wiring (P0.3); the first real consumers land in
//    SP.1 / M1.2. The apps/web `auth` module (SP.2) runs here too: it is pure logic over
//    WebCrypto + IndexedDB + injected DOM hooks (no jsdom needed), and oauth4webapi's
//    PKCE digest hits a jsdom cross-realm `ArrayBuffer` bug — a single-realm Node run is
//    both correct and faster. These files are excluded from the "web" project below.
//  - "web":  jsdom + Testing Library, configured in apps/web/vitest.config.ts so the
//    Vite React plugin, jsdom and RTL all resolve from the app package.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.{test,spec}.ts',
            'apps/web/src/auth/**/*.{test,spec}.ts',
            // Static analysis over the app's shipped stylesheets — no DOM. These live here
            // (not the jsdom "web" project) so they can read the CSS from disk; vitest stubs
            // `.css` imports to empty under jsdom. `*.contrast.test.ts` is the colour math;
            // `*.css.test.ts` is the B5 family (token references, focus indicators), which
            // walks every *.css under apps/web with plain node:fs.
            'apps/web/src/ui/**/*.contrast.test.ts',
            'apps/web/src/ui/**/*.css.test.ts',
          ],
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

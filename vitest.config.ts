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
            // Any `*.css.test.ts`, not only `ui/`'s: a feature area may need to pin an invariant
            // about its OWN stylesheet next to the code it governs (settings does), and the reason
            // these run here — reading the shipped CSS from disk — has nothing to do with where the
            // file sits.
            'apps/web/src/**/*.css.test.ts',
            // `*.shipped.test.ts` — assertions about DEPLOYMENT files (public/config.json and
            // friends) read from disk. Same reason as the CSS family: the jsdom project cannot
            // read them, and what ships is the thing worth checking.
            'apps/web/src/**/*.shipped.test.ts',
            // `*.source.test.ts` — static analysis over the app's own TypeScript, for the cases
            // where one file has to STAY IN STEP with another and no type can say so: the cheat
            // sheet's grid-key table against the switch statement it documents (B21). Here for the
            // same mechanical reason as the two families above — these read the source with
            // `node:fs` off `import.meta.url`, and under jsdom that URL is not a file: URL.
            'apps/web/src/**/*.source.test.ts',
            // Repository-level checks: the workspace manifests, the CI workflows, the Playwright
            // gate configs and the operator documentation. They belong to no package — every one
            // of them is about a file at the repo root or under .github/ — and they read it with
            // `node:fs`, so they run here for the same mechanical reason as the three families
            // above. The scripts they sit next to are `.mjs`; only the tests are TypeScript, and
            // the root tsconfig includes exactly them.
            'scripts/**/*.test.ts',
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

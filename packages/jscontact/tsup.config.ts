import { defineConfig } from 'tsup'

// ESM-only library build for @waxwing/jscontact, mirroring @waxwing/jmap's. Emits
// `dist/index.js` + `dist/index.d.ts` consumed via the package `exports` map.
//
// `src/corpus.ts` and every `*.test.ts` stay out of the bundle by construction: only
// `src/index.ts` is an entry, nothing exported from it reaches the corpus, and tree-shaking
// drops the rest. That matters — the corpus is several kilobytes of sample vCards whose only
// job is to be imported by tests.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2023',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
})

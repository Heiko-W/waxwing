import { defineConfig } from 'tsup'

// ESM-only library build for @waxwing/jmap. Emits `dist/index.js` + `dist/index.d.ts`
// consumed via the package `exports` map. Zero runtime dependencies, so nothing is
// bundled in; the output is our own source transpiled to ES2023.
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

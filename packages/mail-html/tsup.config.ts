import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2023',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Bundle DOMPurify into the lib so the published package is self-contained (the size budget in
  // .size-limit.js measures the emitted dist, which is expected to include the sanitizer).
  noExternal: ['dompurify'],
})

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
  // DOMPurify stays EXTERNAL. It used to be inlined here "so the published package is
  // self-contained", but this package is `private: true` and is never published; the only consumer
  // is apps/web, which depends on `dompurify` itself for the composer's editor instance. Inlining
  // therefore shipped the sanitizer TWICE (once in the eager chunk via this dist, once in the lazy
  // composer chunk) and created two places an advisory would have to be fixed. Left external, Vite
  // resolves both importers to the one copy in the graph.
})

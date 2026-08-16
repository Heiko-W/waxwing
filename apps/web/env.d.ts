/// <reference types="vite/client" />

// Extra Vite env vars consumed by the dev-only SP.4 raw demo (apps/web/src/demo, gated on
// import.meta.env.DEV && VITE_WAXWING_DEMO === '1'). `scripts/demo.mjs` sets them before it
// spawns Vite; they never appear in a production build (the demo branch is dead-code
// eliminated via import.meta.env.DEV — see src/main.tsx). Optional so a normal `pnpm dev`
// (flag unset) type-checks fine.
interface ImportMetaEnv {
  /** `'1'` turns the raw demo on in the dev server. */
  readonly VITE_WAXWING_DEMO?: string
  /** `'1'` mounts the M1.1 component gallery in the dev server (dead-code-eliminated in prod). */
  readonly VITE_WAXWING_GALLERY?: string
  /** Pre-fills the demo Basic-login username (fixture account). Never a literal in src. */
  readonly VITE_WAXWING_DEMO_USER?: string
  /** Pre-fills the demo Basic-login password (fixture password). Never a literal in src. */
  readonly VITE_WAXWING_DEMO_PASS?: string
  /** Overrides the demo's default server origin (default: window.location.origin). */
  readonly VITE_WAXWING_DEMO_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The shipped app version, injected by vite from apps/web/package.json (M4.5). */
declare const __WAXWING_VERSION__: string

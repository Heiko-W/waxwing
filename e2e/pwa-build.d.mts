// Types for the deploy-suite build helper so the TypeScript spec can import it (Bundler resolution),
// matching the seed-read / seed-write pattern.

/** `e2e/.pwa` — everything the deploy suite builds. */
export const PWA_DIR: string
/** Build A: the app exactly as it ships. */
export const DIST_A: string
/** Build B: a genuinely different deploy (see pwa-stage.vite.config.mjs). */
export const DIST_B: string
/** The directory the deploy suite's server serves, and which its tests rewrite. */
export const SERVED_ROOT: string

export function buildDeployments(): void
/** Reset {@link SERVED_ROOT} to build A. */
export function stageBuildA(): void

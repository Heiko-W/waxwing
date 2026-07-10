/**
 * Dev-only entry for the SP.4 raw demo. Loaded via a DYNAMIC import from src/main.tsx that is
 * guarded by `import.meta.env.DEV && import.meta.env.VITE_WAXWING_DEMO === '1'`, so this whole
 * subtree — and its {@link DEMO_MARKER} — is dead-code-eliminated from every production build.
 *
 * No <StrictMode>: the boot-time OAuth-callback effect must run exactly once (StrictMode
 * double-invokes effects in dev), so the throwaway demo opts out.
 */

import { createRoot } from 'react-dom/client'
import { DemoApp } from './DemoApp'
import { registerDemoI18n } from './i18n'

export function mountDemo(container: HTMLElement): void {
  // Demo-only strings live here (not in the shipped common.json), so register them before
  // rendering — the whole demo subtree is DCE'd from production builds.
  registerDemoI18n()
  createRoot(container).render(<DemoApp />)
}

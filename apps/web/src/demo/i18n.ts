/**
 * Registers the SP.4 raw demo's translation strings into the shared `common` namespace at
 * runtime.
 *
 * These keys are deliberately kept OUT of apps/web/src/i18n/locales/{en,de}/common.json so
 * they never ship in the production locale bundle: that JSON is imported unconditionally by
 * src/i18n/index.ts for the active language, whereas this module (and its two JSON files) is
 * only ever reached through the DEV-gated dynamic `import('./demo/main')` in src/main.tsx,
 * which Rollup dead-code-eliminates from every `vite build`. The demo component tree is the
 * only consumer of these strings, and it never mounts in production.
 *
 * Called by {@link mountDemo} (dev server) and by the demo unit tests (which render the demo
 * views directly and so must have the strings available on the shared i18next instance).
 */

import i18next from '../i18n'
import demoDe from './locales/de.json'
import demoEn from './locales/en.json'

let registered = false

/** Merges the demo strings into the `common` namespace for both locales (idempotent). */
export function registerDemoI18n(): void {
  if (registered) return
  registered = true
  // deepMerge + overwrite: fold `{ demo: {...} }` into the existing `common` resources so the
  // demo's `t('demo.*')` lookups resolve alongside the app's own shared keys.
  i18next.addResourceBundle('en', 'common', demoEn, true, true)
  i18next.addResourceBundle('de', 'common', demoDe, true, true)
}

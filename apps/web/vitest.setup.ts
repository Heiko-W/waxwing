import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { initI18n } from './src/i18n'

// Initialise the real i18next instance once for the whole test run so components using
// `useTranslation` render translated strings (and their aria-labels resolve) instead of
// suspending on a missing bundle. The active language's resources are provided
// synchronously by initI18n, so there is no Suspense boundary to manage in tests.
await initI18n()

// jsdom implements no layout, so it ships no `scrollIntoView` — calling it throws. Components that
// keep an active option in view (the command palette, the recipient combobox) legitimately call it,
// so stub it as the no-op it effectively is without layout. A test that cares WHETHER it was called
// spies on it locally; this only stops an unrelated render from crashing.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

// React Testing Library does not auto-clean between tests when globals are disabled.
afterEach(() => {
  cleanup()
})

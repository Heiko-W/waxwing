import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { loadConfig } from './app/config'
import { applyBranding, initTheme, loadThemeOverride } from './app/theme'
import { initI18n } from './i18n'
import './ui/global.css'

async function boot(): Promise<void> {
  // Runtime configuration first: branding + theme depend on it (FR-DEP-04).
  const config = await loadConfig()
  // White-label token override from the deployment directory (FR-THEME-01), appended
  // after the bundled CSS so its :root tokens win.
  loadThemeOverride()
  applyBranding(config)
  initTheme(config.branding.defaultTheme)
  await initI18n()

  const container = document.getElementById('root')
  if (!container) {
    throw new Error('Root container #root is missing from index.html')
  }

  // SP.4 raw end-to-end demo (dev-only). Rendered INSTEAD of <App> when the flag is set,
  // via a DYNAMIC import so the whole demo tree stays out of the normal graph. The guard is
  // deliberately `import.meta.env.DEV && …`: `import.meta.env.DEV` is a build-time literal
  // (`false` in every `vite build`), so Rollup dead-code-eliminates this branch — and the
  // dynamic `import('./demo/main')` chunk — from every production bundle. `VITE_WAXWING_DEMO`
  // then only decides whether the demo shows in the dev server (set by scripts/demo.mjs).
  //
  // It is NOT a URL route: the OAuth redirect_uri is computeRedirectUri(document.baseURI)
  // (= app root, no query/hash), so a query- or hash-based route would be lost across the
  // redirect back from Stalwart. A boot-time flag survives it.
  if (import.meta.env.DEV && import.meta.env.VITE_WAXWING_DEMO === '1') {
    const { mountDemo } = await import('./demo/main')
    mountDemo(container)
    return
  }

  createRoot(container).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
}

void boot()

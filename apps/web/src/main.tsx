import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { initAccent } from './app/accent'
import { loadConfig } from './app/config'
import { applyBranding, initTheme, loadThemeOverride } from './app/theme'
import { initI18n } from './i18n'
import { initInstallCapture } from './pwa/install/use-install-prompt'
import { initScrollbarMetrics } from './ui/scrollbar-metrics'
import { initViewportMetrics } from './ui/viewport-metrics'
import './ui/global.css'

async function boot(): Promise<void> {
  // BEFORE the first await: `beforeinstallprompt` fires once and is never replayed, and on a repeat
  // visit (the worker is already registered, so the app is already installable) Chromium can fire it
  // while we are still waiting on config.json. A listener attached after that is a listener that
  // never hears it — and the install offer would simply never appear (M3.5).
  initInstallCapture()

  // Runtime configuration first: branding + theme depend on it (FR-DEP-04).
  const config = await loadConfig()
  // White-label token override from the deployment directory (FR-THEME-01), appended
  // after the bundled CSS so its :root tokens win.
  loadThemeOverride()
  applyBranding(config)
  initTheme(config.branding.defaultTheme)
  // After the theme, before first paint: the palette writes per-theme slots that `initTheme`'s
  // `data-theme` then selects between (FR-THEME-03). A locked deployment clears any stale choice.
  initAccent({ locked: config.branding.accentLocked })
  // Measure the platform's scrollbar before anything that has to keep clear of it paints — see
  // `scrollbar-metrics.ts` for the defect this exists for (an overlay bar drawn in pieces).
  initScrollbarMetrics()
  initViewportMetrics()
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
  // Dev-only component gallery (M1.1). Same dead-code-elimination guard as the demo below:
  // `import.meta.env.DEV` is a build-time literal, so the branch and its dynamic import are
  // stripped from production; VITE_WAXWING_GALLERY then just gates it in the dev server.
  if (import.meta.env.DEV && import.meta.env.VITE_WAXWING_GALLERY === '1') {
    const { mountGallery } = await import('./ui/gallery/main')
    mountGallery(container)
    return
  }

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

/**
 * The last-resort screen, in the one situation where nothing else can draw one.
 *
 * `boot()` is async and was started with a bare `void`. Only `loadConfig` guards itself; a throw
 * from `loadThemeOverride`, `applyBranding`, `initTheme`, `initAccent`, the metric probes or —
 * most likely of all — `await initI18n()` and its dynamic locale chunk left the page completely
 * blank, with an unhandled rejection in the console as the only sign. React's ErrorBoundary cannot
 * help: `createRoot().render()` is on the far side of those awaits and never runs.
 *
 * Deliberately UNTRANSLATED and free of every app dependency, because the failing step is most
 * likely the one that loads the translations. English plus a reload button beats a blank page in
 * any language; `index.html` carries the same sentence as static markup for the case where even
 * this module fails to load.
 */
function renderBootFailure(error: unknown): void {
  console.error('[waxwing] start-up failed', error)
  const container = document.getElementById('root')
  if (!container) return
  container.textContent = ''
  const wrap = document.createElement('div')
  wrap.setAttribute('role', 'alert')
  wrap.style.cssText =
    'font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111'
  const heading = document.createElement('h1')
  heading.style.cssText = 'font-size:1.25rem;margin:0 0 .5rem'
  // No product name: `applyBranding` may be the very step that threw, and FR-THEME-02 says a
  // white-label deployment never shows this project's name. The guard test enforces it.
  heading.textContent = 'This app could not start'
  const body = document.createElement('p')
  body.style.cssText = 'margin:0 0 1rem'
  body.textContent =
    'Reloading usually fixes this — a part of the app failed to load, which most often happens right after an update. If it keeps happening, contact whoever runs this server.'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Reload'
  button.style.cssText =
    'font:inherit;padding:.5rem 1rem;border:1px solid currentColor;border-radius:.375rem;background:transparent;cursor:pointer'
  button.addEventListener('click', () => {
    window.location.reload()
  })
  wrap.append(heading, body, button)
  container.append(wrap)
}

void boot().catch(renderBootFailure)

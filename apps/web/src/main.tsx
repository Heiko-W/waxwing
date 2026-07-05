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

  createRoot(container).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
}

void boot()

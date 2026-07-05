/**
 * Theme + branding boot (FR-THEME-02, FR-UI-02).
 *
 * `applyBranding` reflects config.json branding into the document (title + accent
 * token). `initTheme`/`setTheme` manage the light/dark/auto override: `auto` follows
 * the OS via CSS `prefers-color-scheme` (no attribute), while `light`/`dark` stamp a
 * `data-theme` attribute the token sheet keys off. The user's choice is a preference
 * (not a secret), so it is persisted in localStorage.
 */

import type { ThemeSetting, WaxwingConfig } from './config'

const THEME_STORAGE_KEY = 'waxwing.theme'

let currentTheme: ThemeSetting = 'auto'

export function applyBranding(config: WaxwingConfig): void {
  const root = document.documentElement
  document.title = config.branding.productName
  root.style.setProperty('--waxwing-accent', config.branding.accentColor)
}

/**
 * Inject the hoster's white-label override sheet (public/theme.css, FR-THEME-01).
 *
 * Resolved against `document.baseURI` so it loads under any path prefix (FR-DEP-02),
 * and appended to <head> AFTER the bundled app stylesheet so its `:root` token
 * re-declarations win over the built-in tokens on the cascade. It ships next to
 * index.html and is loaded network-first (never precached — enforce in the service
 * worker when P4 lands) so edits take effect on the next load without a rebuild. A
 * missing file yields a harmless 404 and the app keeps its built-in tokens.
 */
export function loadThemeOverride(): void {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('theme.css', document.baseURI).href
  document.head.append(link)
}

function applyTheme(setting: ThemeSetting): void {
  const root = document.documentElement
  if (setting === 'auto') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', setting)
  }
}

function isThemeSetting(value: string | null): value is ThemeSetting {
  return value === 'auto' || value === 'light' || value === 'dark'
}

function readStoredTheme(): ThemeSetting | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeSetting(value) ? value : null
  } catch {
    return null
  }
}

/** Apply the initial theme: a persisted user override wins over the hoster default. */
export function initTheme(setting: ThemeSetting): void {
  currentTheme = readStoredTheme() ?? setting
  applyTheme(currentTheme)
}

export function setTheme(setting: ThemeSetting): void {
  currentTheme = setting
  applyTheme(setting)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, setting)
  } catch {
    // Ignore persistence failures (private mode / storage disabled).
  }
}

export function getTheme(): ThemeSetting {
  return currentTheme
}

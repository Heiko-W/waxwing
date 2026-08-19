/**
 * i18next scaffold (FR-I18N-01: full i18n from day one, English + German).
 *
 * Only the ACTIVE language's JSON bundle is loaded, via dynamic import() — no
 * http-backend, no bundling of every locale up front. The detected language is
 * resolved to a supported one, its bundle is imported, and i18next is initialised
 * with just that resource. `changeLanguage` imports + registers further bundles on
 * demand. Interpolation escaping is off because React already escapes output.
 */

import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const DEFAULT_LANGUAGE: SupportedLanguage = 'en'
const NAMESPACE = 'common'

const DETECTION_ORDER = ['querystring', 'localStorage', 'navigator', 'htmlTag'] as const

function isSupported(value: string | undefined): value is SupportedLanguage {
  return value !== undefined && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Resolve whatever the detector produced to a language we actually ship.
 *
 * `navigator.language` is a BCP-47 tag, so a German browser reports `de-DE` — or `de-AT`, or
 * `de-CH` — and never a bare `de`. This used to be `isSupported(first) ? first : DEFAULT_LANGUAGE`,
 * an exact-match test, so every one of those missed and every German speaker got English. The app
 * ships a complete, tested German bundle that almost nobody was being shown.
 *
 * Split on the subtag separator rather than matching a prefix: `den` (Slave) starts with `de` and
 * is not German. `-` and `_` both, because a value that came back out of localStorage need not be
 * normalised.
 */
export function resolveLanguage(value: string | undefined): SupportedLanguage {
  if (value === undefined) return DEFAULT_LANGUAGE
  const normalised = value.toLowerCase()
  if (isSupported(normalised)) return normalised
  const base = normalised.split(/[-_]/)[0]
  return isSupported(base) ? base : DEFAULT_LANGUAGE
}

async function loadLocale(lng: SupportedLanguage): Promise<Record<string, unknown>> {
  const module = await import(`./locales/${lng}/common.json`)
  return module.default as Record<string, unknown>
}

function detectLanguage(): SupportedLanguage {
  const detector = new LanguageDetector()
  detector.init(undefined, { order: [...DETECTION_ORDER] })
  const detected = detector.detect()
  const first = Array.isArray(detected) ? detected[0] : detected
  return resolveLanguage(first)
}

/**
 * Languages written right-to-left (FR-I18N-02).
 *
 * **Populated in advance, on purpose.** None of these ships yet — Waxwing has `en` and `de` — so
 * every entry is inert today. That is the point: "RTL-ready" meant a list someone still had to
 * remember to edit, and the person who adds an Arabic bundle is the person least likely to know
 * that this file decides which way the document runs. Now adding the bundle is the whole change,
 * and `[dir='rtl']` in tokens.css applies the moment it lands.
 *
 * The set is the scripts, not the countries: Arabic, Hebrew, Persian, Urdu, Pashto, Sindhi,
 * Yiddish, Dhivehi.
 */
const RTL_LANGUAGES: readonly string[] = ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv']

/** Apply a language to the document: what it IS, and which way it runs. */
function applyLanguage(lng: string): void {
  document.documentElement.lang = lng
  document.documentElement.dir = RTL_LANGUAGES.includes(lng) ? 'rtl' : 'ltr'
}

export async function initI18n(): Promise<void> {
  const lng = detectLanguage()
  const bundle = await loadLocale(lng)

  await i18next
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      ns: [NAMESPACE],
      defaultNS: NAMESPACE,
      resources: { [lng]: { [NAMESPACE]: bundle } },
      detection: { order: [...DETECTION_ORDER], caches: ['localStorage'] },
      interpolation: { escapeValue: false },
    })

  applyLanguage(lng)
}

export async function changeLanguage(lng: SupportedLanguage): Promise<void> {
  if (!i18next.hasResourceBundle(lng, NAMESPACE)) {
    const bundle = await loadLocale(lng)
    i18next.addResourceBundle(lng, NAMESPACE, bundle, true, true)
  }
  await i18next.changeLanguage(lng)
  applyLanguage(lng)
}

export default i18next

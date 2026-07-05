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

async function loadLocale(lng: SupportedLanguage): Promise<Record<string, unknown>> {
  const module = await import(`./locales/${lng}/common.json`)
  return module.default as Record<string, unknown>
}

function detectLanguage(): SupportedLanguage {
  const detector = new LanguageDetector()
  detector.init(undefined, { order: [...DETECTION_ORDER] })
  const detected = detector.detect()
  const first = Array.isArray(detected) ? detected[0] : detected
  return isSupported(first) ? first : DEFAULT_LANGUAGE
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

  document.documentElement.lang = lng
}

export async function changeLanguage(lng: SupportedLanguage): Promise<void> {
  if (!i18next.hasResourceBundle(lng, NAMESPACE)) {
    const bundle = await loadLocale(lng)
    i18next.addResourceBundle(lng, NAMESPACE, bundle, true, true)
  }
  await i18next.changeLanguage(lng)
  document.documentElement.lang = lng
}

export default i18next

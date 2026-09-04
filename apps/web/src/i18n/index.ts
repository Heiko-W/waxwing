/**
 * i18next scaffold (FR-I18N-01: full i18n from day one).
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
import { formatNumber } from './formatters'

/**
 * Every language with a bundle under `./locales/<tag>/common.json`, alphabetical by tag.
 *
 * Order is the picker's order only after {@link languageName} has been applied and the list
 * re-sorted by what the reader actually sees — "Čeština" and "中文" do not sort like `cs` and `zh`.
 * Keep this list and the directory in step; `guards.test.ts` globs the directory and fails on a
 * bundle that no tag reaches, or a tag with no bundle.
 */
export const SUPPORTED_LANGUAGES = [
  'cs',
  'de',
  'en',
  'es',
  'fr',
  'it',
  'ja',
  'nl',
  'pl',
  'pt',
  'ru',
  'tr',
  'uk',
  'zh',
] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/**
 * The source language and the fallback, exported because two gates need to name it: `en` is the
 * bundle every other one is translated FROM, so it is the tree the parity and placeholder checks
 * compare against. Reading it off `SUPPORTED_LANGUAGES[0]` worked only while that array happened to
 * start with `en`; it now starts with `cs`.
 */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en'
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
 *
 * Collapsing to the base subtag is right for `de-AT` and `pt-BR` and **lossy for `zh`**: a
 * `zh-TW` or `zh-HK` browser resolves to the `zh` bundle, which is written in Simplified Chinese.
 * That is a deliberate "something readable now" rather than a claim to be correct — a Traditional
 * bundle is a `zh-Hant` directory and a tag in the list away, and the day it exists this function
 * needs to prefer the full tag over the base before the split.
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

/**
 * A language tag as its own name — the ENDONYM: `de` → "Deutsch", `ru` → "Русский", `ja` → "日本語".
 *
 * The picker used to translate the names (`t('language.de')`), which reads fine until the list is
 * longer than two: a reader who has landed in the wrong language is looking for their own, and a
 * Japanese name for it spelled in Czech does not help them find it. Every browser's own picker
 * shows endonyms for this reason. It also collapses what used to be a table of n² strings — 14
 * languages naming 14 languages — into nothing at all.
 *
 * `Intl.DisplayNames` rather than a hand-written table, following `settings/stalwart-model.ts`'s
 * `languageLabel`: the names are already in the platform, and a table of endonyms goes stale
 * silently. It returns the tag itself when the platform has no answer, which is honest.
 *
 * The first letter is upper-cased for the LIST, not for the language: CLDR gives "русский" and
 * "français" lowercase because that is how they are written mid-sentence, and a picker in which
 * half the rows are capitalised and half are not looks broken. `toLocaleUpperCase(tag)` rather than
 * `toUpperCase()` so Turkish `i` becomes `İ`.
 */
export function languageName(tag: string): string {
  let name: string
  try {
    name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag
  } catch {
    // `Intl.DisplayNames` throws RangeError on a malformed tag rather than returning anything.
    return tag
  }
  // No data: `of()` hands the tag back. Return it as it was written rather than title-cased — a
  // capitalised `Xx` looks like a name and is not one, and this is the branch a runtime built with
  // small-icu takes for EVERY language.
  if (name.toLowerCase() === tag.toLowerCase()) return tag
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
}

/** Apply a language to the document: what it IS, and which way it runs. */
function applyLanguage(lng: string): void {
  document.documentElement.lang = lng
  document.documentElement.dir = RTL_LANGUAGES.includes(lng) ? 'rtl' : 'ltr'
}

/**
 * `{{count, number}}` — a number in a sentence, written the way the reader's language writes it.
 *
 * WHY IN THE INTERPOLATOR and not at the call site. The obvious shape,
 * `t('list.selected', { count: formatNumber(count) })`, breaks the sentence it is formatting:
 * i18next picks the plural form FROM `count`, and a string selects nothing — Russian would then
 * serve one form for 1, 2 and 5, in a bundle that has all four. The format spec keeps `count` a
 * number for the resolver and formats it only on the way into the text, which is what the spec is
 * for. (Where there is no plural to resolve, handing over a pre-formatted string stays fine and
 * four call sites still do it: `QuotaPanel`, `ServerSection`, the demo mailbox list.)
 *
 * WHY OVERRIDE a formatter i18next already has — and it does, `number` is built in and would make
 * the bundles above work with this function deleted (verified by removing it: the tests stay
 * green). The reason is not function but SINGULARITY: i18next builds `Intl.NumberFormat` out of its
 * own cache, `formatNumber` is the one this codebase documents, tests and tunes, and two of them are
 * two things that can disagree the day either grows an option.
 *
 * It also formats in the language the READER is in rather than the one the string was resolved in —
 * `formatNumber` reads `i18next.resolvedLanguage`, while what i18next passes a formatter is the
 * language the lookup landed in. Those differ only on a fallback, which a complete bundle set (the
 * locale gate enforces one) does not produce today; the point is that the number and the words
 * around it cannot disagree about the locale.
 */
function registerNumberFormat(): void {
  i18next.services.formatter?.add('number', (value) =>
    typeof value === 'number' ? formatNumber(value) : String(value),
  )
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

  registerNumberFormat()
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

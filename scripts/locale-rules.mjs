/**
 * What makes a locale bundle correct — as pure functions over parsed JSON, no filesystem.
 *
 * Two callers need the same answer and must not drift apart:
 *
 *   * `scripts/check-locales.mjs`, the fast pre-flight a translator (or a translating agent) runs
 *     in a loop while a bundle is still half-written. It reads the files off disk and reports one
 *     language at a time, so a language nobody has started yet does not drown the one being worked
 *     on in noise.
 *   * `apps/web/src/i18n/locales.test.ts`, the gate, which sees the very JSON the app bundles
 *     (`import.meta.glob`) and fails `pnpm verify`.
 *
 * Plain `.mjs` rather than TypeScript because the CLI half has to run as `node scripts/…` with no
 * build step; vitest imports it across the workspace root without complaint.
 *
 * ── WHY THESE RULES AND NOT A SPELLCHECKER ────────────────────────────────────────────────────
 *
 * None of this judges whether a translation is GOOD — no automated check can, and
 * `docs/translating.md` is blunt about it ("a string nobody has read is not a translation"). What
 * these catch is the class of defect that is invisible on review and fatal at run time: a key that
 * does not exist renders as its own path, a plural form a language needs and does not have falls
 * back to English mid-sentence, an invented `{{placeholder}}` renders as literal braces, and a
 * dropped `{{product}}` bakes one hoster's brand into another's deployment.
 */

/** The CLDR plural categories, in Intl's own order. i18next appends these as `_suffix`. */
export const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

/** Which plural categories a language actually selects — the platform's answer, not a table. */
export function pluralCategories(language) {
  const selected = new Intl.PluralRules(language).resolvedOptions().pluralCategories
  // Sorted into PLURAL_SUFFIXES order so two lists of the same categories compare equal.
  return PLURAL_SUFFIXES.filter((category) => selected.includes(category))
}

/**
 * Dotted path → value, with arrays kept WHOLE.
 *
 * `compose.attachMentionKeywords` is the one array in the bundle (the words that make "did you
 * forget the attachment?" fire). Flattening it per index would demand that every language use
 * exactly five words, which is wrong — German needs "anbei" and "beigefügt" where English has one
 * "attached" — so it is a leaf here and checked as a list of its own.
 */
export function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out)
    } else {
      out.set(path, value)
    }
  }
  return out
}

/** `settings.offline.pinned_one` → `settings.offline.pinned`; anything else unchanged. */
export function stripPlural(path) {
  const cut = path.lastIndexOf('_')
  if (cut === -1) return path
  return PLURAL_SUFFIXES.includes(path.slice(cut + 1)) ? path.slice(0, cut) : path
}

/**
 * The base keys the SOURCE pluralises.
 *
 * Derived from `en` rather than guessed from the suffix, because the suffix alone is ambiguous: a
 * key could legitimately end in `_one` without being a plural at all, and a language with four
 * forms has three keys `en` has never heard of. Anchoring on the source makes both directions
 * decidable.
 */
export function pluralBases(source) {
  const bases = new Set()
  for (const path of flatten(source).keys()) {
    const base = stripPlural(path)
    if (base !== path) bases.add(base)
  }
  return bases
}

/** Every `{{name}}` in a string, sorted — the set that must survive translation. */
export function placeholders(text) {
  return [...String(text).matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1] ?? '').sort()
}

/**
 * Every problem with one locale, as human-readable lines. Empty array ⇒ the bundle is shippable.
 *
 * `language` is the BCP-47 tag (it decides the plural categories), `tree` the parsed bundle,
 * `source` the parsed `en` bundle. Checking `en` against itself is meaningful and cheap: it still
 * runs the typography and structural rules.
 */
export function checkLocale(language, tree, source) {
  const problems = []
  const isSource = language === 'en'
  const theirs = flatten(tree)
  const ours = flatten(source)
  const bases = pluralBases(source)
  const categories = pluralCategories(language)

  // ── 1. Keys ─────────────────────────────────────────────────────────────────────────────────
  // Compared after collapsing plural variants, because a locale with four forms is SUPPOSED to
  // have more keys than the source. The forms themselves are checked in step 2.
  const wanted = new Set([...ours.keys()].map(stripPlural))
  const got = new Set([...theirs.keys()].map(stripPlural))
  for (const key of wanted) if (!got.has(key)) problems.push(`missing key: ${key}`)
  for (const key of got) if (!wanted.has(key)) problems.push(`key that en does not have: ${key}`)

  // ── 2. Plural forms ─────────────────────────────────────────────────────────────────────────
  // Exactly the categories this language selects — no fewer (a missing form falls back to English
  // mid-sentence) and no more (a form Intl never selects is dead weight that reads as translated).
  for (const base of bases) {
    if (!got.has(base)) continue
    const present = PLURAL_SUFFIXES.filter((c) => theirs.has(`${base}_${c}`))
    for (const category of categories) {
      if (!present.includes(category)) problems.push(`missing plural form: ${base}_${category}`)
    }
    for (const category of present) {
      if (!categories.includes(category)) {
        problems.push(`plural form ${language} never selects: ${base}_${category}`)
      }
    }
  }

  // ── 3. Values ───────────────────────────────────────────────────────────────────────────────
  for (const [path, value] of theirs) {
    // The English string this one came from. The fallback chain matters: a Russian `_few` has no
    // counterpart in `en` under its own name OR under its base (English has only `_one`/`_other`),
    // so without the last two steps `origin` came back undefined and EVERY check below was silently
    // skipped for exactly the forms only the four-form languages have — the ones nobody reviewing
    // an English diff would ever look at.
    const base = stripPlural(path)
    const origin =
      ours.get(path) ?? ours.get(base) ?? ours.get(`${base}_other`) ?? ours.get(`${base}_one`)
    if (Array.isArray(origin)) {
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${path}: en has a non-empty list here`)
      } else if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
        problems.push(`${path}: every entry must be a non-empty string`)
      }
      continue
    }
    if (typeof value !== 'string') {
      problems.push(
        `${path}: expected a string, got ${Array.isArray(value) ? 'a list' : typeof value}`,
      )
      continue
    }
    if (value.trim() === '') problems.push(`${path}: empty — renders as a blank button`)
    if (typeof origin === 'string') {
      // ASYMMETRIC, deliberately. A translation may DROP a placeholder — the singular form rarely
      // needs to repeat the number — but one it INVENTS has nothing to interpolate, so i18next
      // renders the braces and the reader sees `{{count}}` on screen.
      const invented = placeholders(value).filter((n) => !placeholders(origin).includes(n))
      if (invented.length > 0) problems.push(`${path}: invents {{${invented.join('}}, {{')}}}`)
      // `{{product}}` is the one that may NOT be dropped: writing the brand out defeats the
      // white-labelling the placeholder exists for (FR-DEP-04).
      if (placeholders(origin).includes('product') && !placeholders(value).includes('product')) {
        problems.push(`${path}: drops {{product}} — the brand must stay interpolated`)
      }
    }
    if (/waxwing/i.test(value)) problems.push(`${path}: names Waxwing — use {{product}}`)
  }

  // ── 4. Typography ───────────────────────────────────────────────────────────────────────────
  // One spelling per mark, across every language: two of them on the same screen is what makes
  // either look like a typo. The rules are the ones `locales.test.ts` established for en/de.
  for (const [path, value] of theirs) {
    if (typeof value !== 'string') continue
    if (/\p{L}'\p{L}/u.test(value)) problems.push(`${path}: use ’ (U+2019), not '`)
    if (value.includes('...')) problems.push(`${path}: use … (U+2026), not three periods`)
    if (/\s…\s*$/.test(value)) problems.push(`${path}: write "Loading…", not "Loading …"`)
  }

  // ── 5. Not a copy of the source ─────────────────────────────────────────────────────────────
  // Not a quality measure — short labels are legitimately identical across languages, and Dutch
  // has a lot of them. It is a check that the FILE was translated rather than duplicated, so the
  // threshold is set where no real translation can reach it.
  if (!isSource) {
    const comparable = [...theirs].filter(([p, v]) => typeof v === 'string' && ours.has(p))
    const same = comparable.filter(([p, v]) => v === ours.get(p))
    if (comparable.length > 0 && same.length / comparable.length > 0.5) {
      const percent = Math.round((same.length / comparable.length) * 100)
      problems.push(`${percent}% of values are the English string verbatim — untranslated`)
    }
  }

  // ── 6. One word, one meaning ────────────────────────────────────────────────────────────────
  // The shortcut GROUP and the sort control must not end up with the same name: a heading that
  // says "Sort" over Archive/Trash/Move promises something those keys do not do. German shipped
  // exactly that collision once (M9).
  const group = theirs.get('shortcuts.groups.triage')
  const sort = theirs.get('list.sort.label')
  if (group !== undefined && group === sort) {
    problems.push(`shortcuts.groups.triage is named after sorting ("${group}")`)
  }

  return problems
}

#!/usr/bin/env node
/**
 * Locale pre-flight — the same rules `pnpm verify` enforces, one language at a time and in about a
 * second (see `scripts/locale-rules.mjs` for what is checked and why).
 *
 *   node scripts/check-locales.mjs          # every bundle under apps/web/src/i18n/locales
 *   node scripts/check-locales.mjs ru pl    # just these
 *
 * Exists because the gate is the wrong tool for the inner loop: `pnpm verify` builds first and
 * reports every language at once, so a translator working on Russian reads three screens of
 * Ukrainian. Exit code is 1 if anything is wrong, so CI or a pre-commit hook can use it too.
 *
 * Documented for translators in `docs/translating.md`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLocale, pluralCategories } from './locale-rules.mjs'

const LOCALES = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/src/i18n/locales')
const SOURCE = 'en'

function read(language) {
  const path = join(LOCALES, language, 'common.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`✗ ${language}: ${error.message}`)
    return null
  }
}

const available = readdirSync(LOCALES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const requested = process.argv.slice(2)
const languages = requested.length > 0 ? requested : available

const source = read(SOURCE)
if (source === null) process.exit(1)

let failed = false
for (const language of languages) {
  if (!available.includes(language)) {
    console.error(`✗ ${language}: no bundle — expected ${join(LOCALES, language, 'common.json')}`)
    failed = true
    continue
  }
  const tree = read(language)
  if (tree === null) {
    failed = true
    continue
  }
  const problems = checkLocale(language, tree, source)
  const forms = pluralCategories(language).join('/')
  if (problems.length === 0) {
    console.log(`✓ ${language}  (plural forms: ${forms})`)
    continue
  }
  failed = true
  console.error(`✗ ${language}  (plural forms: ${forms}) — ${problems.length} problem(s)`)
  // Capped: a bundle that has not been started yet reports 1600 missing keys, and a wall of them
  // hides the two real ones in a bundle that is nearly done.
  for (const problem of problems.slice(0, 40)) console.error(`    ${problem}`)
  if (problems.length > 40) console.error(`    … and ${problems.length - 40} more`)
}

process.exit(failed ? 1 : 0)

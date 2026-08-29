/**
 * Types for `locale-rules.mjs`, hand-written because that module is plain `.mjs`: its CLI half
 * (`check-locales.mjs`) has to run as `node scripts/…` with no build step, while its test half
 * (`apps/web/src/i18n/locales.test.ts`) is TypeScript under `strict`. One implementation, so the
 * gate and the pre-flight can never disagree about what "correct bundle" means.
 */

/** A parsed locale bundle: nested objects, string leaves, one array leaf. */
export type LocaleTree = { [key: string]: string | readonly string[] | LocaleTree }

export declare const PLURAL_SUFFIXES: readonly string[]
export declare function pluralCategories(language: string): string[]
export declare function flatten(
  tree: LocaleTree,
  prefix?: string,
  out?: Map<string, unknown>,
): Map<string, unknown>
export declare function stripPlural(path: string): string
export declare function pluralBases(source: LocaleTree): Set<string>
export declare function placeholders(text: string): string[]
/** Every problem with one bundle, as human-readable lines. Empty ⇒ shippable. */
export declare function checkLocale(
  language: string,
  tree: LocaleTree,
  source: LocaleTree,
): string[]

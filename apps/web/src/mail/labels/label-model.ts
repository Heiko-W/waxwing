/**
 * Label/keyword model (M3.2) — pure (no React/i18n/DOM) so the slug/validate/merge rules are
 * exhaustively unit-tested. A Waxwing "label" is a curated view over a JMAP custom keyword: a
 * stored, immutable wire `keyword` (an IMAP-safe slug) plus a free-text display `name` and a
 * palette `color`. The authoritative registry lives in `localPrefs['labels']`; it is MERGED
 * read-only with custom keywords discovered on cached mail (via the `akw` index) so labels that
 * only exist on the server still show up (greyed, name = the bare keyword).
 *
 * Owner decisions encoded here: renaming edits the display name only (the keyword never changes);
 * a leading `$` (the system-keyword namespace) is rejected; and slugging collapses every run of
 * IMAP-unsafe characters to a single `_`.
 */

/** The fixed 7-key palette (Apple flag colors). Stored as the KEY, never a hex value. */
export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

/** A curated registry entry: the immutable wire keyword + its local display name and color. */
export interface LabelPref {
  readonly keyword: string
  readonly name: string
  readonly color: LabelColor
}

/** localPrefs key under which the {@link LabelPref}[] registry is stored. */
export const LABELS_PREF_KEY = 'labels'

/** Maximum wire-keyword length (an IMAP flag-name safety bound). */
export const MAX_KEYWORD_LENGTH = 64

/** RFC 8621 system keywords — never treated as user labels. */
export const SYSTEM_KEYWORDS: ReadonlySet<string> = new Set([
  '$seen',
  '$flagged',
  '$draft',
  '$answered',
  '$forwarded',
  '$junk',
  '$notjunk',
])

/** The merged display model: a registry label, or a discovered-but-unregistered custom keyword. */
export interface DisplayLabel {
  readonly keyword: string
  readonly name: string
  readonly color: LabelColor
  /** True for a keyword found on cached mail that is not in the registry (rendered gray). */
  readonly discovered: boolean
}

export type LabelNameError = 'empty' | 'tooLong' | 'taken'

/**
 * A single IMAP-unsafe character: anything outside printable ASCII `0x21–0x7E`, or one of the
 * flag-name specials (`( ) { } % * " \ ]`). Space (`0x20`) and control chars fall outside the
 * printable range, so they are covered by the first alternative.
 */
const UNSAFE_CHAR = /[^!-~]|[(){}%*"\\\]]/

/** True when a keyword is a user label (not a system `$…` keyword). */
export function isCustomKeyword(keyword: string): boolean {
  return keyword !== '' && !keyword.startsWith('$') && !SYSTEM_KEYWORDS.has(keyword)
}

/**
 * Derive the wire keyword from a display name: lower-case, each maximal run of IMAP-unsafe
 * characters collapsed to a single `_`, then leading/trailing `_` trimmed. Returns `null` when
 * nothing usable remains (an empty slug).
 */
export function slugKeyword(name: string): string | null {
  let out = ''
  let pendingUnderscore = false
  for (const char of name.toLowerCase()) {
    if (UNSAFE_CHAR.test(char)) {
      pendingUnderscore = true
      continue
    }
    if (pendingUnderscore && out !== '') out += '_'
    pendingUnderscore = false
    out += char
  }
  // A trailing run of unsafe chars leaves `pendingUnderscore` set but adds no `_` (trailing trim).
  return out === '' ? null : out
}

/**
 * Validate a proposed NEW label name against the existing label keywords. Returns the first failure
 * or `null` when the name is acceptable. A slug that is empty, too long, begins with `$`, or collides
 * case-insensitively with an existing keyword is rejected. (A leading `$` maps to `taken` — the
 * system namespace is effectively reserved.)
 */
export function validateLabelName(
  name: string,
  existingKeywords: readonly string[],
): LabelNameError | null {
  const slug = slugKeyword(name)
  if (slug === null) return 'empty'
  if (slug.length > MAX_KEYWORD_LENGTH) return 'tooLong'
  if (slug.startsWith('$')) return 'taken'
  const lower = slug.toLowerCase()
  if (existingKeywords.some((keyword) => keyword.toLowerCase() === lower)) return 'taken'
  return null
}

/**
 * Build a validated {@link LabelPref} from a name + color, or `null` when the name is invalid.
 * The stored `name` is the trimmed free-text display; the `keyword` is its slug.
 */
export function makeLabel(
  name: string,
  color: LabelColor,
  existingKeywords: readonly string[],
): LabelPref | null {
  if (validateLabelName(name, existingKeywords) !== null) return null
  const keyword = slugKeyword(name)
  if (keyword === null) return null
  return { keyword, name: name.trim(), color }
}

/**
 * Merge the curated registry with keywords discovered on cached mail: registry entries first (in
 * stored order), then each discovered custom keyword not already registered, as a gray
 * `discovered` label whose name is the bare keyword. System keywords are excluded, and discovered
 * keywords are de-duplicated case-insensitively against the registry and each other.
 *
 * NOTE: discovered labels reflect only the windowed replica subset — a keyword used only on mail
 * outside the offline horizon will not appear until that mail is synced.
 */
export function mergeLabels(
  registry: readonly LabelPref[],
  discovered: readonly string[],
): DisplayLabel[] {
  const out: DisplayLabel[] = registry.map((label) => ({
    keyword: label.keyword,
    name: label.name,
    color: label.color,
    discovered: false,
  }))
  const known = new Set(registry.map((label) => label.keyword.toLowerCase()))
  for (const keyword of discovered) {
    if (!isCustomKeyword(keyword)) continue
    const lower = keyword.toLowerCase()
    if (known.has(lower)) continue
    known.add(lower)
    out.push({ keyword, name: keyword, color: 'gray', discovered: true })
  }
  return out
}

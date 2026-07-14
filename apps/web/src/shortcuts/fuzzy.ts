/**
 * The command palette's fuzzy matcher (M3.8) — ~60 lines, zero dependencies.
 *
 * A palette match is a SUBSEQUENCE match ("arch" matches "Archive", "gtf" matches "Go to Folder"),
 * scored so that the ranking feels obvious: a tight, word-initial run beats characters scattered
 * across the string. Matching runs over a folded form (lowercased, combining marks stripped, ß→ss),
 * so `entwurfe` finds "Entwürfe" and `grussen` finds "Grüßen" — the two things a German user typing
 * on a hurry actually does.
 *
 * `positions` are indices into the ORIGINAL text (not the folded one), which is what lets the palette
 * wrap the matched characters in `<mark>`. That mapping is why folding is done per character.
 *
 * LAZY: imported only by the palette chunk. Nothing in the eager graph may import this file.
 */

/** +16 per matched character. */
const MATCH = 16
/** +10 when a match directly follows the previous one (a consecutive run). */
const CONSECUTIVE = 10
/** +8 when a match starts a word (string start, or preceded by a space / `-` / `/`). */
const BOUNDARY = 8
/** −1 per character skipped before the final match. */
const SKIP = -1

/** Lowercase, strip combining marks, ß→ss. Idempotent; may change length (ß → two chars). */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
}

/** Fold per character, keeping a map from each folded index back to its source index. */
function foldWithMap(text: string): { readonly folded: string; readonly map: readonly number[] } {
  let folded = ''
  const map: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) continue
    for (const produced of fold(char)) {
      folded += produced
      map.push(index)
    }
  }
  return { folded, map }
}

function isBoundary(char: string | undefined): boolean {
  return char === ' ' || char === '-' || char === '/'
}

export interface FuzzyMatch {
  readonly score: number
  /** Indices into the ORIGINAL `text` of the matched characters (ascending, deduped). */
  readonly positions: readonly number[]
}

/**
 * Score `query` against `text`; `null` when `query` is not a subsequence of `text`. An empty query
 * matches everything with score 0 (the palette then ranks by recency alone).
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = fold(query)
  if (needle === '') return { score: 0, positions: [] }

  const { folded, map } = foldWithMap(text)
  const positions: number[] = []
  let score = 0
  let cursor = 0
  let previous = -2 // -2 so `previous === index - 1` is false for index 0

  for (let index = 0; index < folded.length && cursor < needle.length; index += 1) {
    if (folded[index] !== needle[cursor]) {
      score += SKIP
      continue
    }
    score += MATCH
    if (previous === index - 1) score += CONSECUTIVE
    if (index === 0 || isBoundary(folded[index - 1])) score += BOUNDARY
    const source = map[index]
    if (source !== undefined && positions.at(-1) !== source) positions.push(source)
    previous = index
    cursor += 1
  }

  if (cursor < needle.length) return null
  return { score, positions }
}

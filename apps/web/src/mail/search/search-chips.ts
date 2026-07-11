/**
 * Chip derivation for the search box (M3.1). Chips are a DERIVED view of the parsed tokens — only
 * HONORED operator tokens become removable chips; free text and degraded operators stay in the input
 * text (so the box and the chips can never drift). Removing a chip drops that token from the query.
 */

import { operatorCondition, type SearchContext, type SearchToken } from './search-query'

/** i18n translate shape this module needs (a subset of react-i18next's `t`). */
export type ChipTranslate = (key: string, opts?: { value?: string; filter?: string }) => string

export interface SearchChip {
  /** Index into the token array — removing this chip drops the token at this index. */
  readonly index: number
  readonly label: string
}

/** The removable chips for `tokens`: one per honored operator (`from:`, `is:unread`, `in:archive`, …). */
export function searchChips(
  tokens: SearchToken[],
  ctx: SearchContext,
  t: ChipTranslate,
): SearchChip[] {
  const chips: SearchChip[] = []
  tokens.forEach((token, index) => {
    if (token.type !== 'op') return
    if (operatorCondition(token, ctx) === null) return // degraded → it shows as text, not a chip
    chips.push({ index, label: chipLabel(token, t) })
  })
  return chips
}

function chipLabel(token: Extract<SearchToken, { type: 'op' }>, t: ChipTranslate): string {
  switch (token.op) {
    case 'from':
    case 'to':
    case 'cc':
    case 'subject':
    case 'body':
    case 'in':
    case 'before':
    case 'after':
      return t(`search.chip.${token.op}`, { value: token.value })
    case 'has':
      return t('search.chip.hasAttachment')
    case 'is': {
      const flag = token.value.toLowerCase()
      const key = flag === 'starred' ? 'flagged' : flag // unread | read | flagged
      return t(`search.chip.${key}`)
    }
  }
}

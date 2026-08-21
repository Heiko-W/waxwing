/**
 * Chip derivation for the search box (M3.1). Chips are a DERIVED view of the parsed tokens — only
 * HONORED operator tokens become removable chips; free text, the `OR` connector and degraded
 * operators stay in the input text (so the box and the chips can never drift). Removing a chip drops
 * that token from the query.
 */

import type { EmailFilterCondition } from '@waxwing/jmap'
import { formatBytes } from '../../i18n/formatters'
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
    const condition = operatorCondition(token, ctx)
    if (condition === null) return // degraded → it shows as text, not a chip
    const label = chipLabel(token, condition, t)
    // A negated filter reads as a filter of its own, not as a missing one: the chip says so in
    // words rather than in a symbol nobody can hear or hit.
    chips.push({
      index,
      label: token.negated === true ? t('search.chip.not', { filter: label }) : label,
    })
  })
  return chips
}

function chipLabel(
  token: Extract<SearchToken, { type: 'op' }>,
  condition: EmailFilterCondition,
  t: ChipTranslate,
): string {
  switch (token.op) {
    case 'from':
    case 'to':
    case 'cc':
    case 'bcc':
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
    case 'thread': {
      const flag = token.value.toLowerCase()
      const key = flag === 'starred' ? 'flagged' : flag // unread | read | flagged
      return t(`search.chip.thread.${key}`)
    }
    // Show the SIZE the filter actually uses, formatted the way the message list shows it — the
    // typed `10M` and the row's "10.4 MB" have to be recognisably the same number.
    case 'larger':
      return t('search.chip.larger', { value: formatBytes(condition.minSize ?? 0) })
    case 'smaller':
      return t('search.chip.smaller', { value: formatBytes(condition.maxSize ?? 0) })
  }
}

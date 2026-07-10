/**
 * Message-list timestamp formatting (M1.6, FR-LST-03): a compact, localized, age-dependent label —
 * a relative phrase for the last day ("2h ago", "yesterday"), a short weekday within the week
 * ("Mon"), a month/day for older-this-year ("Mar 3"), and a full date across years. Built on the
 * shared Intl helpers so it follows the active locale.
 */

import { formatDate, formatRelativeTime } from '../i18n/formatters'

const DAY_MS = 86_400_000

export function formatMessageTime(iso: string, now: number = Date.now()): string {
  const date = new Date(iso)
  const age = now - date.getTime()
  if (age < DAY_MS) return formatRelativeTime(date, now)
  if (age < 7 * DAY_MS) return formatDate(date, { weekday: 'short' })
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return formatDate(date, { month: 'short', day: 'numeric' })
  }
  return formatDate(date, { year: 'numeric', month: 'short', day: 'numeric' })
}

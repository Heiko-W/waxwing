/**
 * Pure paging arithmetic for the SP.4 demo message list. `Email/query` windows are 0-based
 * (`position` is the index of the first item, RFC 8620 §5.5); the UI shows a 1-based
 * "from–to of total" and disables the ends. Kept pure so it is unit-tested without a client.
 */

/** Messages per page in the demo list. */
export const DEMO_PAGE_SIZE = 10

export interface PageInfo {
  /** A previous page exists (current window does not start at 0). */
  hasPrev: boolean
  /** A next page exists (current window does not reach `total`). */
  hasNext: boolean
  /** 1-based index of the first item on the page (`0` when the page is empty). */
  from: number
  /** 1-based index of the last item on the page (`0` when the page is empty). */
  to: number
  /** The calculated total across all pages. */
  total: number
}

/**
 * Derives the display range and end-guards for a window. `position` is the 0-based start of
 * the current window, `count` how many items actually came back (the last page may be short),
 * `total` the calculated total.
 */
export function pageInfo(position: number, count: number, total: number): PageInfo {
  const from = count === 0 ? 0 : position + 1
  const to = count === 0 ? 0 : position + count
  return {
    hasPrev: position > 0,
    // More items exist beyond this window's last item.
    hasNext: position + count < total,
    from,
    to,
    total,
  }
}

/** Start of the next window, clamped so the last page never over-requests past `total`. */
export function nextPosition(position: number, pageSize: number, total: number): number {
  const next = position + pageSize
  return next < total ? next : position
}

/** Start of the previous window, clamped at 0. */
export function prevPosition(position: number, pageSize: number): number {
  return Math.max(0, position - pageSize)
}

/**
 * Canonical query-key serialization (M1.2). Each watched `Email/query` is cached in
 * {@link QueryCacheRow} under a stable string derived from its `filter` + `sort` +
 * `collapseThreads`, so that two structurally-different-but-semantically-equal queries map to the
 * same cache row (and a genuinely different query never collides).
 *
 * The load-bearing normalizations:
 * - **Sort order is significant** (comparators are applied in sequence) → the array order is kept,
 *   but each comparator's `isAscending` default (`true`, RFC 8620 §5.5) is made explicit and
 *   absent `collation`/`keyword` are dropped, so `{property:'receivedAt'}` ==
 *   `{property:'receivedAt',isAscending:true}`.
 * - **Filter object key order is insignificant** (a condition's fields are ANDed) → object keys are
 *   sorted recursively, and a boolean operator's `conditions` (AND/OR/NOT are all order-independent)
 *   are sorted by their canonical form, so `A AND B` == `B AND A`. Array *values* (e.g. a
 *   `header: [name, value]` pair) keep their order.
 * - `collapseThreads` materially changes the result set, so it is part of the key (default `false`).
 *
 * `accountId` is NOT part of the key — the cache row is keyed `[accountId+key]`, so scoping is on
 * the compound primary key, and the same logical query shares one key string across accounts.
 */

import type { EmailComparator, EmailFilter } from '@waxwing/jmap'

export interface QuerySpec {
  filter?: EmailFilter | null
  sort?: EmailComparator[] | null
  collapseThreads?: boolean
}

/** A deterministic string for `{filter, sort, collapseThreads}`; equal specs → equal strings. */
export function canonicalQueryKey(spec: QuerySpec): string {
  return stableStringify({
    filter: normalizeFilter(spec.filter ?? null),
    sort: normalizeSort(spec.sort ?? null),
    collapseThreads: spec.collapseThreads ?? false,
  })
}

function normalizeSort(sort: EmailComparator[] | null): unknown {
  if (sort === null) return null
  return sort.map((comparator) => {
    const out: Record<string, unknown> = {
      property: comparator.property,
      isAscending: comparator.isAscending ?? true,
    }
    if (comparator.collation !== undefined) out.collation = comparator.collation
    if (comparator.keyword !== undefined) out.keyword = comparator.keyword
    return out
  })
}

function normalizeFilter(filter: EmailFilter | null): unknown {
  if (filter === null) return null
  if ('operator' in filter) {
    const conditions = filter.conditions
      .map((condition) => ({ node: normalizeFilter(condition as EmailFilter) }))
      .map((wrapped) => ({ ...wrapped, key: stableStringify(wrapped.node) }))
      // Codepoint order, NOT localeCompare: collation is not a total order (it returns 0 for
      // distinct-but-collate-equal strings, e.g. a zero-width space) and is locale-dependent, so
      // either would let two equal `A AND B` / `B AND A` filters serialize to different keys.
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((wrapped) => wrapped.node)
    return { operator: filter.operator, conditions }
  }
  // A leaf FilterCondition: keys are sorted by stableStringify; array values keep their order.
  return filter
}

/** JSON with recursively sorted object keys and `undefined` properties dropped. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

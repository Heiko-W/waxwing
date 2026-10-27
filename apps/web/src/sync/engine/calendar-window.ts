/**
 * How a calendar window is asked of the server when recurrences are expanded.
 *
 * **An expanded query takes ONE filter condition — no `AND`, no `OR`.** Stalwart 1.0 answers
 * `{operator: 'AND', conditions: [window, {operator: 'OR', …}]}` with `expandRecurrences: true` as
 * `invalidArguments: "The filter must be a single FilterCondition when expanding recurrences"`, and
 * the whole month fails to load ("The calendar could not be loaded") for everyone who has any
 * calendar switched on. Stalwart 0.16 accepted the operator form, and `calendarFilter` was built on
 * that. Measured on both, 2026-10-27, same fixture:
 *
 * | `expandRecurrences: true`, filter                  | 0.16.27 | 1.0.0 |
 * | ------------------------------------------------- | ------- | ----- |
 * | `{after, before}`                                  | ok      | ok    |
 * | `{after, before, inCalendar}`                      | ok      | ok    |
 * | `AND[{after, before}, OR[{inCalendar}, …]]`        | ok      | **refused** |
 * | `{after, before, inCalendars: [...]}` (the draft)  | refused | refused |
 *
 * So the window is split into one query per calendar, each a single condition both servers take. The
 * UNEXPANDED companion query keeps the operator form — it is accepted on both, and it is not the one
 * that breaks.
 */

function isOperator(filter: unknown): filter is { operator: string; conditions: unknown[] } {
  return (
    typeof filter === 'object' &&
    filter !== null &&
    'operator' in filter &&
    Array.isArray((filter as { conditions?: unknown }).conditions)
  )
}

/**
 * The single-condition queries that together answer `filter` with recurrences expanded.
 *
 * Recognises the one shape `calendarFilter` produces — the window ANDed with an OR of
 * `inCalendar` conditions — and answers one `{...window, inCalendar}` per calendar. Anything else
 * (a bare window, a filter someone else built) is returned as the single query it already is, and
 * the server is left to judge it. Structural on purpose: it does not import the calendar module, and
 * a filter that merely LOOKS similar but carries other conditions is not rewritten.
 */
export function expandedQueries<F extends object | null>(filter: F): F[] {
  if (!isOperator(filter) || filter.operator !== 'AND' || filter.conditions.length !== 2) {
    return [filter]
  }
  const [window, calendars] = filter.conditions
  if (isOperator(window) || typeof window !== 'object' || window === null) return [filter]
  if (!isOperator(calendars) || calendars.operator !== 'OR' || calendars.conditions.length === 0) {
    return [filter]
  }
  const ids: string[] = []
  for (const condition of calendars.conditions) {
    const inCalendar = (condition as { inCalendar?: unknown } | null)?.inCalendar
    if (isOperator(condition) || typeof inCalendar !== 'string') return [filter]
    ids.push(inCalendar)
  }
  return ids.map((inCalendar) => ({ ...window, inCalendar }) as unknown as F)
}

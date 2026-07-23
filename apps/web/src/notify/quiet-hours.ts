/**
 * Quiet hours (FR-NOTIF-03) — pure and DOM-free.
 *
 * Extracted from `notify-model.ts` by M4.0 for one reason: the SERVICE WORKER needs this rule too.
 * A closed-app push banner must respect quiet hours exactly as the live channel does, and `sw.ts`
 * compiles under `tsconfig.sw.json` (`lib: WebWorker`, `types: []`), which `notify-model.ts` cannot
 * satisfy — it reaches `permission.ts` (`window`) and `sync/db.ts` (Dexie).
 *
 * The alternative was a second copy of the midnight-crossing rule in the worker. Two copies of a
 * predicate that is right in a non-obvious way is how the two paths drift apart, and the user would
 * see it as "quiet hours work unless the app is closed" — the exact shape of bug this project keeps
 * finding. `notify-model.ts` re-exports these, so every existing import path still resolves.
 */

/**
 * A quiet window in LOCAL minutes since midnight. `fromMinutes` inclusive, `toMinutes` exclusive.
 * `from > to` crosses midnight (22:00 → 07:00). `from === to` is EMPTY, never "always".
 */
export interface QuietHours {
  readonly fromMinutes: number
  readonly toMinutes: number
}

/** Local wall-clock minutes since midnight, from an epoch millisecond value. */
export function localMinutesOfDay(now: number): number {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Is `minutesOfDay` inside the quiet window? `from` inclusive, `to` exclusive.
 *
 * `from > to` CROSSES MIDNIGHT: 22:00 → 07:00 is quiet at 23:00 *and* at 03:00, and loud at noon.
 * `from === to` is an EMPTY range — never quiet, not always quiet: a zero-length window means "off",
 * and "always off" is what the master switch is for.
 */
export function inQuietHours(minutesOfDay: number, range: QuietHours): boolean {
  const { fromMinutes: from, toMinutes: to } = range
  if (from === to) return false
  if (from < to) return minutesOfDay >= from && minutesOfDay < to
  return minutesOfDay >= from || minutesOfDay < to
}

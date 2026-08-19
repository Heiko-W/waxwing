/**
 * Snooze (M5.8, FR-ORG-03) — hide a message until a chosen time.
 *
 * **Client-side, and the spec is explicit about why:** no JMAP server offers snoozing, so the state
 * has to live somewhere this client controls. It lives in two places, deliberately:
 *
 * - **A keyword on the message** (`$snoozed`). Keywords are ordinary IMAP/JMAP state, so every
 *   other client the user owns sees a flag it does not recognise and carries on — nothing breaks,
 *   nothing disappears from their view. The list filter here excludes it, which is what makes the
 *   message vanish from the inbox for *this* client.
 * - **The wake time in the local preferences**, because a keyword cannot carry a timestamp.
 *
 * **The limitation, stated rather than hidden:** a snoozed message reappears when this app next
 * runs. Nothing wakes it on a device where the app is closed, because waking it means a JMAP write
 * and there is no server-side component to make one. The UI says so.
 */

export const SNOOZE_KEYWORD = '$snoozed'
export const SNOOZE_PREF_KEY = 'mail.snoozed'

/** emailId → the instant it should come back, in epoch milliseconds. */
export type SnoozeMap = Readonly<Record<string, number>>

/** Reads the stored map, tolerating any shape. */
export function coerceSnoozeMap(value: unknown): SnoozeMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [id, wakeAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof wakeAt === 'number' && Number.isFinite(wakeAt)) out[id] = wakeAt
  }
  return out
}

/** The ids whose time has come. */
export function dueIds(map: SnoozeMap, now: number): string[] {
  return Object.entries(map)
    .filter(([, wakeAt]) => wakeAt <= now)
    .map(([id]) => id)
}

/** The map with `ids` removed — used after their keyword has been cleared. */
export function withoutIds(map: SnoozeMap, ids: readonly string[]): SnoozeMap {
  const drop = new Set(ids)
  return Object.fromEntries(Object.entries(map).filter(([id]) => !drop.has(id)))
}

/** The map with `ids` snoozed until `wakeAt`. */
export function withSnoozed(map: SnoozeMap, ids: readonly string[], wakeAt: number): SnoozeMap {
  const next: Record<string, number> = { ...map }
  for (const id of ids) next[id] = wakeAt
  return next
}

/** The presets the UI offers, as offsets from a given "now". */
export interface SnoozePreset {
  readonly id: 'laterToday' | 'tomorrow' | 'thisWeekend' | 'nextWeek'
  readonly at: (now: Date) => Date
}

/** Tomorrow at 08:00 local. */
function tomorrowMorning(now: Date): Date {
  const at = new Date(now)
  at.setDate(at.getDate() + 1)
  at.setHours(8, 0, 0, 0)
  return at
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  {
    id: 'laterToday',
    at: (now) => {
      const at = new Date(now)
      at.setHours(at.getHours() + 3, 0, 0, 0)
      // Past the end of the day: "later today" has run out, so the honest next slot is tomorrow.
      return at.getDate() === now.getDate() ? at : tomorrowMorning(now)
    },
  },
  { id: 'tomorrow', at: tomorrowMorning },
  {
    id: 'thisWeekend',
    at: (now) => {
      const at = new Date(now)
      // Saturday is day 6; if it is already the weekend, mean NEXT Saturday rather than the past.
      const daysUntilSaturday = (6 - at.getDay() + 7) % 7 || 7
      at.setDate(at.getDate() + daysUntilSaturday)
      at.setHours(8, 0, 0, 0)
      return at
    },
  },
  {
    id: 'nextWeek',
    at: (now) => {
      const at = new Date(now)
      // Monday is day 1.
      const daysUntilMonday = (1 - at.getDay() + 7) % 7 || 7
      at.setDate(at.getDate() + daysUntilMonday)
      at.setHours(8, 0, 0, 0)
      return at
    },
  },
]

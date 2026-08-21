/**
 * Reading a `.ics` file into events (K-4, FR-CAL-01) — via the SERVER's parser.
 *
 * **No iCalendar parser ships in this bundle.** `CalendarEvent/parse` hands a blob to Stalwart and
 * gets JSCalendar back, which is the same conversion the server does for every CalDAV client it
 * serves — a second implementation here would be a second set of bugs about `VTIMEZONE`, folded
 * lines and `RRULE` in a bundle that has 18 kB of headroom.
 *
 * **The value per blob is an ARRAY, and losing that is silent.** One VCALENDAR may hold many
 * VEVENTs; a client that reads `parsed[blobId]` as an object keeps the first and drops the rest
 * with no error anywhere. Measured on v0.16.18 with a two-VEVENT file: two entries, in document
 * order.
 *
 * **What has to come off before a create, and why each one.**
 *  - `method` — **immutable**, measured on create as well as update
 *    (`"This property is immutable."`). A parsed invitation carries `method: "request"`, so leaving
 *    it in fails the whole create. It would also be wrong if it worked: an imported file is not an
 *    invitation this account received.
 *  - `iCalendar` — the sidecar describing how the VEVENT was converted (`convertedProperties`).
 *    Accepted on create, measured, but it is the server's record of a conversion that is now over.
 *  - `id`, `created`, `updated`, `isOrigin`, `baseEventId` — server-owned, the same list
 *    `restoreEvent` strips.
 *
 * **What stays: `uid`.** It is what makes a second import of the same file a refusal rather than a
 * duplicate — and the refusal is per object and loud:
 * `{"type":"invalidProperties","description":"An event with UID probe-1@waxwing.test already
 * exists.","properties":["uid"]}`. So the importer can say "3 added, 2 already there" precisely,
 * instead of either duplicating or guessing.
 *
 * **Export is not here, and that is measured, not deferred.** `CalendarEvent/get` with
 * `properties: ["iCalendar"|"blobId"|"iCalendarBlobId"|"ical"]` answers `{"id":"e"}` every time —
 * silently dropped; `CalendarEvent/export` is `unknownMethod`; there is no blob and no download URL
 * for an event. The only way out over JMAP would be a serialiser written here, which would be
 * lossy in exactly the properties this client does not model. It is left out rather than shipped
 * with a caveat.
 */

import type { CalendarEvent, Id } from '@waxwing/jmap'

/**
 * Properties removed from a parsed event before it is created.
 *
 * See the file header for the measurement behind each. `method` is the one that is not a judgement
 * call: leaving it in fails the create outright.
 */
export const PARSED_ONLY = [
  'iCalendar',
  'method',
  'id',
  'created',
  'updated',
  'isOrigin',
  'baseEventId',
] as const

/** One row of the import preview. */
export interface ImportCandidate {
  /** Stable within one parse — the index in the blob, so two identical events stay two rows. */
  readonly key: string
  readonly title: string
  /** Local start as JSCalendar gives it, or `''` when the file had none the server could read. */
  readonly start: string
  readonly allDay: boolean
  readonly uid: string
  /** Does it repeat? Shown, because "1 event" that is really 52 is a surprise worth avoiding. */
  readonly repeats: boolean
  /** The payload a create would send, minus `calendarIds`. */
  readonly event: Readonly<Record<string, unknown>>
}

/**
 * Every event in one parsed blob, as preview rows.
 *
 * Accepts the raw `parsed[blobId]` value in any shape the server might send: an array is the
 * measured answer, a bare object is tolerated as one event, anything else is none. Tolerating the
 * object form costs three lines; assuming it costs the second event of every multi-event file.
 */
export function candidatesFrom(value: unknown): ImportCandidate[] {
  const events: unknown[] = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? [value]
      : []
  const rows: ImportCandidate[] = []
  for (const [index, entry] of events.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const event = entry as CalendarEvent & Record<string, unknown>
    rows.push({
      key: String(index),
      title: typeof event.title === 'string' ? event.title : '',
      start: typeof event.start === 'string' ? event.start : '',
      allDay: event.showWithoutTime === true,
      uid: typeof event.uid === 'string' ? event.uid : '',
      repeats: event.recurrenceRule !== undefined && event.recurrenceRule !== null,
      event: strip(event),
    })
  }
  return rows
}

/** The parsed event with the properties a create may not carry removed. */
function strip(event: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (!(PARSED_ONLY as readonly string[]).includes(key)) payload[key] = value
  }
  return payload
}

/** The `create` map for a `CalendarEvent/set`, one entry per chosen row. */
export function createsFor(
  candidates: readonly ImportCandidate[],
  calendarId: Id,
): Record<string, Record<string, unknown>> {
  const creates: Record<string, Record<string, unknown>> = {}
  for (const candidate of candidates) {
    creates[`i${candidate.key}`] = { ...candidate.event, calendarIds: { [calendarId]: true } }
  }
  return creates
}

/** How one import went, in the two numbers the toast says. */
export interface ImportOutcome {
  readonly added: number
  /** Refused because an event with that `uid` is already in the account — not an error. */
  readonly duplicates: number
  /** Refused for any other reason, with the server's first sentence. */
  readonly failed: number
  readonly reason: string | null
}

/**
 * Reads a `CalendarEvent/set` answer into the sentence the screen says.
 *
 * A duplicate `uid` is counted apart from a failure on purpose. It is the expected outcome of
 * importing a file twice — which people do, because they cannot remember whether they did — and
 * calling it an error would teach the reader to distrust an importer that is working exactly as
 * intended.
 */
export function outcomeFrom(response: {
  created?: Record<string, unknown> | null
  notCreated?: Record<
    string,
    { type: string; description?: string | null; properties?: string[] | null }
  > | null
}): ImportOutcome {
  const added = Object.keys(response.created ?? {}).length
  let duplicates = 0
  let failed = 0
  let reason: string | null = null
  for (const error of Object.values(response.notCreated ?? {})) {
    if (error.properties?.includes('uid') === true) duplicates += 1
    else {
      failed += 1
      reason ??= error.description ?? error.type
    }
  }
  return { added, duplicates, failed, reason }
}

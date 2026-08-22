/**
 * Reminders on an event (K-5, FR-CAL-01) — reading them, offering a few, and **not losing the rest**.
 *
 * Until this file existed `alerts` was in no property list the client sent, so an alarm set on a
 * phone was invisible here. It survived a title change only by accident: `draftToEvent` is a JMAP
 * patch and never named the property. The moment the editor DOES name it, that accident stops
 * protecting anything and this module has to do it on purpose.
 *
 * **Two kinds of alert, and the split is the whole design.**
 *
 *  - **Modelled**: a `display` action on an `OffsetTrigger` relative to the start, with nothing else
 *    on it. Those the reader can see and change, and they are re-written from scratch on every save.
 *  - **Opaque**: everything else — `action: "email"`, an `AbsoluteTrigger`, a `relativeTo: "end"`,
 *    or an alert carrying a member this client does not model. Measured: Stalwart hands an
 *    `AbsoluteTrigger` back with an `iCalendar` sidecar
 *    (`{"convertedProperties":{"trigger":{"parameters":{"value":"DATE-TIME"}}},"name":"valarm"}`)
 *    that describes how the alarm was converted from a VALARM. Those are carried through **byte for
 *    byte under their original keys**, which is the same stance `EventFacts` takes on a location and
 *    an attendee list: what the editor cannot show, it also must not touch.
 *
 * The alternative — dropping what we do not understand — is the expensive kind of wrong. It looks
 * like nothing happened; the email reminder simply never fires again, months later, for somebody
 * who never opened this editor.
 *
 * **`undefined` is not `[]`.** {@link alertsToPatch} answers `undefined` for "not touched" (the
 * property stays out of the patch and the server leaves it alone) and `null` for "the reader
 * emptied it" (measured: `alerts: null` clears; so does `alerts: {}`, and `null` is the one RFC 8620
 * §5.3 names for removal). Getting that pair the wrong way round either destroys every alarm on
 * every save, or makes clearing one impossible.
 */

import type { Alert, CalendarEvent, Duration } from '@waxwing/jmap'
import type { TFunction } from 'i18next'

/**
 * The offsets a TIMED event may be reminded at, in the order they are offered.
 *
 * Apple's list, and it is Apple's list on purpose: the values are the ones people expect to find,
 * and a free-text field for a duration is a way of asking a reader to learn ISO 8601. `PT0S` is
 * "when it starts" — not negative, and the only non-negative member.
 *
 * Round-tripped against Stalwart v0.16.18: every string below comes back from `CalendarEvent/get`
 * exactly as it was sent, including `PT0S`, `-P1D` and `-P1W` (the server does not normalise them
 * into minutes, which is what makes a fixed list workable as a value set).
 */
export const TIMED_OFFSETS: readonly Duration[] = [
  'PT0S',
  '-PT5M',
  '-PT10M',
  '-PT15M',
  '-PT30M',
  '-PT1H',
  '-PT2H',
  '-P1D',
  '-P2D',
  '-P1W',
]

/**
 * The offsets a WHOLE-DAY event may be reminded at, with the label each one means.
 *
 * A whole-day event starts at MIDNIGHT, so "on the day" has to name a morning hour or the alarm
 * fires while the reader is asleep. Apple picks 09:00 and states it in the label, which is why these
 * carry their own keys instead of being formatted from a count: "on the day of the event (9:00)" is
 * not "0 days before".
 *
 * **The arithmetic is `9h − 24h × n`, and the first value is POSITIVE.** 09:00 on the day itself is
 * nine hours AFTER midnight (`PT9H`); the day before is `9 − 24 = −15` hours; two days before is
 * `9 − 48 = −39`; a week before is `9 − 168 = −159`. `PLAN-kalender.md` gives this list as
 * `-PT9H`, `-PT33H`, `-PT57H` — that is `−(24n + 9)`, which places "on the day of the event" at
 * 15:00 the day BEFORE and shifts every entry a day early. The plan's `-PT9H` came from a reading of
 * `defaultAlertsWithoutTime`; on the v0.16.18 fixture that map is empty (`{}`) on every calendar, so
 * there was nothing there to read. All four values below round-trip through `CalendarEvent/set` and
 * `/get` unchanged, `PT9H` included (probed 21.08.2026).
 */
export const ALL_DAY_OFFSETS: readonly { readonly offset: Duration; readonly key: string }[] = [
  { offset: 'PT9H', key: 'dayOf' },
  { offset: '-PT15H', key: 'dayBefore' },
  { offset: '-PT39H', key: 'twoDaysBefore' },
  { offset: '-PT159H', key: 'weekBefore' },
]

/** The offsets offered for an event of this kind. */
export function offsetsFor(allDay: boolean): readonly Duration[] {
  return allDay ? ALL_DAY_OFFSETS.map((entry) => entry.offset) : TIMED_OFFSETS
}

/** How many reminders the editor offers. Apple offers two; a third is a scheduling tool, not a nudge. */
export const MAX_OFFSETS = 2

/**
 * An event's reminders, split into the half this client owns and the half it only carries.
 *
 * `offsets` is a LIST and not a set, because the order is what the two rows in the dialog show;
 * duplicates are removed on the way in, since two alarms at the same moment are one alarm.
 */
export interface EventAlerts {
  /** Modelled reminders, as ISO 8601 offsets from the start. At most {@link MAX_OFFSETS} are shown. */
  readonly offsets: readonly Duration[]
  /** Everything else, under the keys the server gave it. Never inspected, never rewritten. */
  readonly opaque: Readonly<Record<string, Alert>>
}

export const NO_ALERTS: EventAlerts = { offsets: [], opaque: {} }

/**
 * Is this alert one the editor may present as an offset?
 *
 * Deliberately strict, and the strictness is the safety: anything with a member this file does not
 * name is treated as opaque and carried through untouched. A looser test would show an alert in the
 * dialog, let the reader "keep" it, and silently write back a poorer copy of it — which is worse
 * than not offering it at all, because the reader watched it happen and was told nothing.
 */
function modelledOffset(alert: Alert): Duration | null {
  const keys = Object.keys(alert)
  if (keys.some((key) => key !== '@type' && key !== 'action' && key !== 'trigger')) return null
  if (alert.action !== undefined && alert.action !== 'display') return null

  const trigger = alert.trigger
  if (trigger === undefined || trigger === null) return null
  const triggerKeys = Object.keys(trigger)
  if (triggerKeys.some((key) => key !== '@type' && key !== 'offset' && key !== 'relativeTo')) {
    return null
  }
  if (trigger['@type'] !== undefined && trigger['@type'] !== 'OffsetTrigger') return null
  if (trigger.relativeTo !== undefined && trigger.relativeTo !== 'start') return null
  return typeof trigger.offset === 'string' && trigger.offset !== '' ? trigger.offset : null
}

/**
 * Reads an event's `alerts` map into the two halves.
 *
 * An event asked for without `alerts` in `properties` reads exactly like an event that has none —
 * which is why `alerts` is now in `EVENT_PROPERTIES` and why that is pinned by a test. This function
 * cannot tell the two apart and must not pretend it can.
 */
export function alertsFromEvent(event: CalendarEvent): EventAlerts {
  const alerts = event.alerts
  if (alerts === undefined || alerts === null) return NO_ALERTS

  const offsets: Duration[] = []
  const opaque: Record<string, Alert> = {}
  for (const [key, alert] of Object.entries(alerts)) {
    if (alert === undefined || alert === null || typeof alert !== 'object') continue
    const offset = modelledOffset(alert)
    // A duplicate offset is dropped rather than kept as opaque: it IS understood, there is just
    // nothing left to say about it.
    if (offset === null) opaque[key] = alert
    else if (!offsets.includes(offset)) offsets.push(offset)
  }
  return { offsets, opaque }
}

/** The alert object this client writes for one offset. */
function displayAlert(offset: Duration): Alert {
  return {
    '@type': 'Alert',
    action: 'display',
    trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' },
  }
}

/**
 * The value `alerts` takes in a `CalendarEvent/set` patch — or `undefined` to leave it out.
 *
 * Two answers here, and the third is the caller's:
 *
 *  - `null` — the reader emptied the list and there is nothing opaque to keep. Measured: this
 *    clears the map (so does `alerts: {}`; `null` is the one RFC 8620 §5.3 names).
 *  - a map — the modelled offsets, plus every opaque alert **exactly as it arrived**.
 *
 * The third answer, "leave the property out of the patch entirely", is not expressible here on
 * purpose: it is the absence of a call. {@link draftToEvent} makes it by not asking when the draft
 * carries no alert information, which is what every save did before K-5 and still does for a caller
 * that does not opt in.
 *
 * Keys for the modelled alerts avoid the opaque ones rather than assuming a namespace: the server
 * chooses those keys (`k1`, `a3`, whatever a CalDAV client left behind), so a fixed prefix is a
 * collision waiting for the one event that uses it.
 */
export function alertsToPatch(alerts: EventAlerts): Record<string, Alert> | null {
  const map: Record<string, Alert> = { ...alerts.opaque }
  let next = 1
  /*
   * EVERY offset, not only the {@link MAX_OFFSETS} the dialog draws a row for.
   *
   * An event that arrived with three display alarms is not a mistake to be tidied up — slicing here
   * would mean opening such an event, changing its title and silently deleting the third. The two
   * rows are how many the editor OFFERS; what it carries is everything it was given. The rows
   * beyond the second are reported in the same sentence as the alarms this client cannot model,
   * because from the reader's side they are the same fact: kept, and not shown.
   */
  for (const offset of alerts.offsets) {
    let key = `w${next}`
    while (key in map) {
      next += 1
      key = `w${next}`
    }
    map[key] = displayAlert(offset)
    next += 1
  }
  return Object.keys(map).length === 0 ? null : map
}

/**
 * The offset in whole minutes before the start, or `null` when it cannot be read.
 *
 * Only the forms this client writes and the ones the fixed lists above use: `PT0S`, and a negative
 * `P…T…` of weeks, days, hours and minutes. A duration naming months or years is refused rather
 * than approximated — "1 month before" is not a fixed number of minutes, and guessing 30 days would
 * put the reminder on the wrong day for eleven months of the year.
 */
export function offsetToMinutes(offset: Duration): number | null {
  const match = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(offset)
  if (match === null) return null
  const [, sign, weeks, days, hours, minutes, seconds] = match
  if (weeks === undefined && days === undefined && hours === undefined && minutes === undefined) {
    // `PT0S` is the only seconds-only form the lists use, and it means "at the start".
    if (seconds === undefined) return null
    return Number(seconds) === 0 ? 0 : null
  }
  const total =
    Number(weeks ?? 0) * 10_080 +
    Number(days ?? 0) * 1440 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0)
  // A POSITIVE offset is after the start. Nothing in the fixed lists is, and an alarm that fires
  // once the meeting has begun is not a reminder — reported as `null` so the caller falls back to
  // showing the raw duration rather than "-5 minutes before".
  return sign === '-' ? total : total === 0 ? 0 : null
}

/**
 * What one offset is called on screen.
 *
 * A whole-day event answers from {@link ALL_DAY_OFFSETS}, because those labels name a clock time
 * ("on the day of the event (9:00)") that no arithmetic on the offset would produce. Everything else
 * is formatted from the count, so the plural rules are i18next's and not a table of hand-written
 * English.
 *
 * An offset this file cannot read — a foreign value from another client, or one measured in months —
 * is shown as the duration it is, rather than rounded into a lie. It is still carried through the
 * save untouched; see {@link alertsToPatch}.
 */
export function formatOffset(offset: Duration, allDay: boolean, t: TFunction): string {
  if (allDay) {
    const named = ALL_DAY_OFFSETS.find((entry) => entry.offset === offset)
    if (named !== undefined) return t(`calendar.event.alert.${named.key}`)
  }
  const minutes = offsetToMinutes(offset)
  if (minutes === null) return t('calendar.event.alert.other', { duration: offset })
  if (minutes === 0) return t('calendar.event.alert.atStart')
  if (minutes % 10_080 === 0) {
    return t('calendar.event.alert.weeks', { count: minutes / 10_080 })
  }
  if (minutes % 1440 === 0) return t('calendar.event.alert.days', { count: minutes / 1440 })
  if (minutes % 60 === 0) return t('calendar.event.alert.hours', { count: minutes / 60 })
  return t('calendar.event.alert.minutes', { count: minutes })
}

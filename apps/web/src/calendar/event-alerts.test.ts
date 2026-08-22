/**
 * Reminders (K-5) — and above all, the ones this client does NOT understand.
 *
 * The gap this closes is that `alerts` was in no property list the client sent, so an alarm set on a
 * phone was invisible in Waxwing. The risk that closing it creates is the opposite one: the moment
 * the editor names the property in a patch, everything it cannot model is one save away from being
 * deleted. So most of what is asserted below is about carrying things through unchanged.
 *
 * The fixtures are the shapes Stalwart v0.16.18 actually answered with on 21 August 2026, including
 * the `iCalendar` sidecar it attaches to an alert converted from a VALARM — a member no draft
 * mentions and the strongest reason the "is this one of ours?" test is a whitelist rather than a
 * blacklist.
 */

import type { Alert, CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  ALL_DAY_OFFSETS,
  alertsFromEvent,
  alertsToPatch,
  formatOffset,
  MAX_OFFSETS,
  NO_ALERTS,
  offsetsFor,
  offsetToMinutes,
  TIMED_OFFSETS,
} from './event-alerts'

const event = (alerts?: Record<string, Alert>): CalendarEvent =>
  ({
    id: 'e1',
    calendarIds: { c1: true },
    start: '2026-09-10T10:00:00',
    ...(alerts === undefined ? {} : { alerts }),
  }) as CalendarEvent

/** As the server answers one: fifteen minutes before, display. */
const DISPLAY_15: Alert = {
  '@type': 'Alert',
  action: 'display',
  trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' },
}

/** An email reminder. Nothing in this client can show one, and nothing in it may delete one. */
const EMAIL_1H: Alert = {
  '@type': 'Alert',
  action: 'email',
  trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' },
}

/**
 * An absolute alarm, exactly as Stalwart returned it — sidecar included.
 *
 * The `iCalendar` member is the server's record of how the alarm was converted out of a VALARM. It
 * is not in `jscalendarbis` and not in this client's `Alert` type; measured, writing it back
 * verbatim is accepted and reading it again returns it unchanged.
 */
const ABSOLUTE: Alert = {
  '@type': 'Alert',
  action: 'display',
  trigger: { '@type': 'AbsoluteTrigger', when: '2026-09-10T06:00:00Z' },
  iCalendar: {
    convertedProperties: { trigger: { parameters: { value: 'DATE-TIME' } } },
    name: 'valarm',
  },
} as Alert

describe('alertsFromEvent', () => {
  it('reads an offset reminder the editor can show', () => {
    expect(alertsFromEvent(event({ k1: DISPLAY_15 })).offsets).toEqual(['-PT15M'])
  })

  it('cannot tell "no alerts" from "alerts were never asked for" — and does not pretend to', () => {
    // Which is exactly why `alerts` is now in EVENT_PROPERTIES: this function reads what arrived,
    // and an unrequested property arrives as nothing at all.
    expect(alertsFromEvent(event())).toEqual(NO_ALERTS)
  })

  it('keeps an EMAIL alarm out of the editable list and in the carried one', () => {
    const alerts = alertsFromEvent(event({ k1: DISPLAY_15, k2: EMAIL_1H }))
    expect(alerts.offsets).toEqual(['-PT15M'])
    expect(alerts.opaque).toEqual({ k2: EMAIL_1H })
  })

  it('keeps an ABSOLUTE alarm — sidecar and all — under its own key', () => {
    const alerts = alertsFromEvent(event({ a3: ABSOLUTE }))
    expect(alerts.offsets).toEqual([])
    // Byte for byte, not a reconstruction: `iCalendar` is a member this client does not model, and
    // a "tidied" copy of an alarm is a quiet downgrade of it.
    expect(alerts.opaque.a3).toBe(ABSOLUTE)
  })

  it('treats a reminder relative to the END as one it does not model', () => {
    const atEnd: Alert = {
      '@type': 'Alert',
      action: 'display',
      trigger: { '@type': 'OffsetTrigger', offset: 'PT10M', relativeTo: 'end' },
    }
    expect(alertsFromEvent(event({ z: atEnd })).offsets).toEqual([])
    expect(alertsFromEvent(event({ z: atEnd })).opaque).toEqual({ z: atEnd })
  })

  it('accepts `relativeTo: "start"` stated explicitly, which is what the server echoes back', () => {
    // Measured: an alert written with `relativeTo: "start"` comes back carrying it. Refusing the
    // explicit form would make this client unable to read its own writes.
    const explicit: Alert = {
      '@type': 'Alert',
      action: 'display',
      trigger: { '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'start' },
    }
    expect(alertsFromEvent(event({ z: explicit })).offsets).toEqual(['-PT30M'])
  })

  it('collapses two alarms at the same moment into one', () => {
    const alerts = alertsFromEvent(event({ k1: DISPLAY_15, k2: { ...DISPLAY_15 } }))
    expect(alerts.offsets).toEqual(['-PT15M'])
  })
})

describe('alertsToPatch', () => {
  it('writes `null` for a list the reader emptied', () => {
    // NOT `{}` and not "leave it out": the reader took the reminder off, and the server has to be
    // told so. Measured: `alerts: null` clears the map.
    expect(alertsToPatch(NO_ALERTS)).toBeNull()
  })

  it('keeps every carried alarm even when the modelled list is empty', () => {
    // The dangerous case. "No reminders I can show" is not "no reminders", and clearing the row
    // must not take the email alarm with it.
    expect(alertsToPatch({ offsets: [], opaque: { k2: EMAIL_1H } })).toEqual({ k2: EMAIL_1H })
  })

  it('writes a display alert on an offset trigger, the shape the server accepts', () => {
    const patch = alertsToPatch({ offsets: ['-PT15M'], opaque: {} })
    expect(Object.values(patch ?? {})).toEqual([
      {
        '@type': 'Alert',
        action: 'display',
        trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
      },
    ])
  })

  it('does not overwrite a carried alarm whose key it would otherwise have used', () => {
    // The server chooses those keys, so a fixed prefix is a collision waiting for the one event
    // that uses it — and the collision would DELETE the alarm it landed on.
    const patch = alertsToPatch({ offsets: ['-PT15M'], opaque: { w1: EMAIL_1H } })
    expect(patch?.w1).toBe(EMAIL_1H)
    expect(Object.keys(patch ?? {})).toHaveLength(2)
  })

  it('keeps MORE reminders than the editor has rows for', () => {
    // The editor draws two rows; an event that arrived with three display alarms still has three
    // afterwards. Slicing here would mean opening such an event, changing its title, and silently
    // deleting the last one — the same failure as dropping an email alarm, only for a reminder the
    // client understands perfectly well.
    const patch = alertsToPatch({ offsets: ['-PT5M', '-PT10M', '-PT15M'], opaque: {} })
    expect(Object.keys(patch ?? {})).toHaveLength(3)
    expect(MAX_OFFSETS).toBe(2)
  })
})

describe('the offsets on offer', () => {
  it('starts a whole-day event AFTER midnight, not before it', () => {
    /*
     * The correction to PLAN-kalender.md. A whole-day event starts at midnight, so 09:00 on the day
     * itself is nine hours LATER — `PT9H`, positive. The plan gives `-PT9H`, which is 15:00 the day
     * before, and its `-PT33H` for "one day before (9:00)" is a day early for the same reason:
     * `-(24n + 9)` where the arithmetic is `9 - 24n`. Both shapes round-trip through the server
     * unchanged, so nothing but this test says which one is meant.
     */
    expect(ALL_DAY_OFFSETS[0]?.offset).toBe('PT9H')
    expect(ALL_DAY_OFFSETS.map((entry) => entry.offset)).toEqual([
      'PT9H',
      '-PT15H',
      '-PT39H',
      '-PT159H',
    ])
  })

  it('offers the whole-day list only to a whole-day event', () => {
    expect(offsetsFor(true)).toEqual(['PT9H', '-PT15H', '-PT39H', '-PT159H'])
    expect(offsetsFor(false)).toBe(TIMED_OFFSETS)
  })
})

describe('offsetToMinutes', () => {
  it('reads every offset the timed list offers', () => {
    for (const offset of TIMED_OFFSETS) {
      expect(offsetToMinutes(offset), offset).not.toBeNull()
    }
    expect(offsetToMinutes('PT0S')).toBe(0)
    expect(offsetToMinutes('-PT15M')).toBe(15)
    expect(offsetToMinutes('-PT2H')).toBe(120)
    expect(offsetToMinutes('-P1D')).toBe(1440)
    expect(offsetToMinutes('-P1W')).toBe(10_080)
  })

  it('refuses a duration it cannot turn into minutes rather than approximating one', () => {
    // "One month before" is not a fixed number of minutes, and 30 days puts the reminder on the
    // wrong day for eleven months of the year.
    expect(offsetToMinutes('-P1M')).toBeNull()
    expect(offsetToMinutes('-P1Y')).toBeNull()
    expect(offsetToMinutes('nonsense')).toBeNull()
  })
})

describe('formatOffset', () => {
  /** A `t` that reports the key and the count, so the assertions are about the CHOICE of key. */
  const t = ((key: string, values?: Record<string, unknown>) =>
    values === undefined ? key : `${key}:${JSON.stringify(values)}`) as unknown as Parameters<
    typeof formatOffset
  >[2]

  it('names the whole-day offsets from their own keys, not from a count', () => {
    expect(formatOffset('PT9H', true, t)).toBe('calendar.event.alert.dayOf')
    expect(formatOffset('-PT159H', true, t)).toBe('calendar.event.alert.weekBefore')
  })

  it('picks the largest unit the offset divides into, so 60 minutes is an hour', () => {
    expect(formatOffset('PT0S', false, t)).toBe('calendar.event.alert.atStart')
    expect(formatOffset('-PT30M', false, t)).toContain('minutes')
    expect(formatOffset('-PT1H', false, t)).toContain('hours')
    expect(formatOffset('-P1D', false, t)).toContain('days')
    expect(formatOffset('-P1W', false, t)).toContain('weeks')
  })

  it('shows a foreign duration as itself rather than rounding it into a lie', () => {
    expect(formatOffset('-P1M', false, t)).toContain('other')
    expect(formatOffset('-P1M', false, t)).toContain('-P1M')
  })
})

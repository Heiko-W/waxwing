/**
 * The calendar role model (S-2) — and the two claims that are worth a test rather than a comment.
 *
 * 1. **"Availability only" writes `mayReadFreeBusy` and nothing else.** That is the whole promise of
 *    the role: they see that you are busy, never what you are doing. One `true` slipping into it —
 *    `mayReadItems` in particular, which is the natural thing to add if someone reads "view-ish" —
 *    would hand over every title in the diary while the label still said "Availability only". The
 *    test asserts the FULL object, so a new key added to `CalendarRights` cannot ride in silently.
 * 2. **Four roles, in the safe order.** The generic dialog offers `roles.roles` and defaults to its
 *    first entry, so the order is not cosmetic: it decides what the Add button grants to someone
 *    who never opened the picker.
 *
 * Everything else here is the same shape as `mailbox.test.ts`, against a different key set.
 */

import type { CalendarRights } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  CALENDAR_RIGHT_KEYS,
  CALENDAR_SHARE_ROLES,
  calendarRoles,
  mayShareCalendar,
} from './calendar-roles'

/**
 * The eight keys Stalwart v0.16.18 accepts inside `Calendar.shareWith`.
 *
 * Measured (`docs/jmap-gap-2026-08-21/berichte/D-sharing-pim.md` §1.2), and written out here rather
 * than derived from the module under test — a test that reads its expectation from the code it is
 * testing proves only that the code is self-consistent. A key the server rejects is refused per
 * object with `invalidProperties`, so this list being wrong means every grant fails.
 */
const MEASURED_KEYS = [
  'mayReadFreeBusy',
  'mayReadItems',
  'mayWriteAll',
  'mayWriteOwn',
  'mayUpdatePrivate',
  'mayRSVP',
  'mayShare',
  'mayDelete',
] as const satisfies readonly (keyof CalendarRights)[]

describe('the calendar rights vocabulary', () => {
  it('is exactly the eight keys the server was measured to accept', () => {
    expect([...CALENDAR_RIGHT_KEYS].sort()).toEqual([...MEASURED_KEYS].sort())
  })

  it('writes every key on every role, so a grant is never partial', () => {
    for (const role of CALENDAR_SHARE_ROLES) {
      expect(Object.keys(calendarRoles.rightsFor(role)).sort()).toEqual([...MEASURED_KEYS].sort())
    }
  })
})

describe('the four roles a calendar offers', () => {
  it('offers four, least to most, with availability first', () => {
    expect(calendarRoles.roles).toEqual(['freeBusy', 'viewer', 'editor', 'manager'])
  })

  /*
   * THE test of this file. `toEqual` on the whole object, not `toMatchObject` and not a spot check:
   * the claim is "and nothing else", and only a total comparison can make it.
   */
  it('grants `mayReadFreeBusy` and NOTHING else for "availability only"', () => {
    expect(calendarRoles.rightsFor('freeBusy')).toEqual({
      mayReadFreeBusy: true,
      mayReadItems: false,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayUpdatePrivate: false,
      mayRSVP: false,
      mayShare: false,
      mayDelete: false,
    })
  })

  it('never lets "availability only" see an event', () => {
    expect(calendarRoles.rightsFor('freeBusy').mayReadItems).toBe(false)
  })

  it('adds the events, and only the events, for View', () => {
    expect(calendarRoles.rightsFor('viewer')).toEqual({
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayUpdatePrivate: false,
      mayRSVP: false,
      mayShare: false,
      mayDelete: false,
    })
  })

  it('lets Edit write and answer, but not delete or hand on', () => {
    const editor = calendarRoles.rightsFor('editor')
    expect(editor.mayWriteAll).toBe(true)
    expect(editor.mayWriteOwn).toBe(true)
    expect(editor.mayUpdatePrivate).toBe(true)
    expect(editor.mayRSVP).toBe(true)
    expect(editor.mayShare).toBe(false)
    expect(editor.mayDelete).toBe(false)
  })

  it('keeps `mayShare` — the right that hands out rights — in Manage alone', () => {
    for (const role of CALENDAR_SHARE_ROLES) {
      expect(calendarRoles.rightsFor(role).mayShare).toBe(role === 'manager')
    }
  })

  it('keeps `mayDelete` in Manage alone, the conservative reading', () => {
    for (const role of CALENDAR_SHARE_ROLES) {
      expect(calendarRoles.rightsFor(role).mayDelete).toBe(role === 'manager')
    }
  })

  it('returns a fresh object, so an edit cannot reach the spec', () => {
    const first = calendarRoles.rightsFor('viewer')
    first.mayShare = true
    expect(calendarRoles.rightsFor('viewer').mayShare).toBe(false)
  })
})

describe('reading rights back', () => {
  it('names each role from the rights it produces', () => {
    for (const role of CALENDAR_SHARE_ROLES) {
      expect(calendarRoles.roleOf(calendarRoles.rightsFor(role))).toBe(role)
    }
  })

  it('recognises "availability only" from the server-normalised full map', () => {
    // The server fills a partial grant with `false` (measured on `Mailbox`), so this is the shape
    // that really comes back — not the one-key object the client sent.
    expect(
      calendarRoles.roleOf({
        mayReadFreeBusy: true,
        mayReadItems: false,
        mayWriteAll: false,
        mayWriteOwn: false,
        mayUpdatePrivate: false,
        mayRSVP: false,
        mayShare: false,
        mayDelete: false,
      }),
    ).toBe('freeBusy')
  })

  it('calls a combination none of the four produces `custom`, and leaves it alone', () => {
    // Read-only plus the right to hand it on: a real grant another client can make, and one no role
    // here describes. Snapping it to `viewer` would quietly take `mayShare` away.
    expect(
      calendarRoles.roleOf({ mayReadFreeBusy: true, mayReadItems: true, mayShare: true }),
    ).toBe('custom')
  })

  it('calls absent rights `custom` rather than guessing', () => {
    expect(calendarRoles.roleOf(null)).toBe('custom')
    expect(calendarRoles.roleOf(undefined)).toBe('custom')
  })
})

describe('carrying the other grantees across', () => {
  it('keeps everyone else when one grant changes', () => {
    const before = { alice: calendarRoles.rightsFor('viewer') }
    const after = calendarRoles.withGrant(before, 'bob', 'freeBusy')
    expect(Object.keys(after).sort()).toEqual(['alice', 'bob'])
    expect(after.alice).toEqual(calendarRoles.rightsFor('viewer'))
  })

  it('keeps everyone else when one grant is revoked', () => {
    const before = {
      alice: calendarRoles.rightsFor('viewer'),
      bob: calendarRoles.rightsFor('manager'),
    }
    expect(Object.keys(calendarRoles.withoutGrant(before, 'bob'))).toEqual(['alice'])
  })

  it('lists grantees in a stable order', () => {
    const shareWith = {
      carol: calendarRoles.rightsFor('editor'),
      alice: calendarRoles.rightsFor('freeBusy'),
    }
    expect(calendarRoles.grantees(shareWith).map((entry) => entry.principalId)).toEqual([
      'alice',
      'carol',
    ])
  })
})

describe('whether the affordance is offered at all', () => {
  /*
   * The other test this file exists for. A calendar somebody shared WITH the reader comes back with
   * `mayShare: false` and `shareWith: null` — only the owner ever sees the grant map — so a rail
   * that drew the icon anyway would open a dialog listing nobody over something that cannot be
   * changed.
   */
  it('refuses without `mayShare`', () => {
    expect(mayShareCalendar({ mayShare: false })).toBe(false)
  })

  it('refuses when the property was never fetched', () => {
    expect(mayShareCalendar(undefined)).toBe(false)
    expect(mayShareCalendar(null)).toBe(false)
    expect(mayShareCalendar({})).toBe(false)
  })

  it('allows with `mayShare`', () => {
    expect(mayShareCalendar({ mayShare: true })).toBe(true)
  })
})

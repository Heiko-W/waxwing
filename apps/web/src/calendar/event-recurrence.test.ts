/**
 * Repetition and single-occurrence overrides (K-2, FR-CAL-01).
 *
 * **The brief for this work asked for a test proving an occurrence is patched by POINTER
 * (`"recurrenceOverrides/<rid>": {…}`) and never as the whole map. That test cannot be written,
 * because the server refuses the pointer.** Probed against Stalwart v0.16.18 on 21.08.2026, with a
 * throwaway account and a weekly series:
 *
 * ```jsonc
 * update: { "b": { "recurrenceOverrides/2026-09-14T09:00:00": { "excluded": true } } }
 * → notUpdated: { "b": { "type":"invalidProperties",
 *                        "description":"Patch operation failed.",
 *                        "properties":["recurrenceOverrides/2026-09-14T09:00:00"] } }
 * ```
 *
 * `recurrenceOverrides/<rid>/title` fails identically; `recurrenceRule/count` in the SAME request
 * succeeds, which is the control that makes this a fact about the property and not about patching.
 * The whole map, written as one value, is accepted and reads back verbatim.
 *
 * So the assertion the brief was really after — *"editing one occurrence must not destroy the
 * others"* — is tested here in the only form this server permits: the map is merged from what was
 * just read, every other entry survives byte for byte, and (in `calendar-series.test.ts`) the read
 * happens inside the same request as the write. A whole-map write measured against this server also
 * REPLACES: writing a map with one entry leaves exactly one entry, so a client that forgets to merge
 * silently deletes every other override in the series. That is the failure these tests guard.
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  endFromRule,
  excludeOverride,
  mergeOverride,
  overrideFromDraft,
  overrideKeyFor,
  presetFromRule,
  ruleToWrite,
} from './event-recurrence'

const master = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    id: 'b',
    calendarIds: { c1: true },
    title: 'Serie',
    start: '2026-09-07T09:00:00',
    duration: 'PT1H',
    timeZone: 'Europe/Berlin',
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 1, count: 6 },
    ...over,
  }) as CalendarEvent

describe('presetFromRule', () => {
  it('names the five repetitions the editor offers', () => {
    expect(presetFromRule(undefined)).toBe('none')
    expect(presetFromRule({ frequency: 'daily' })).toBe('daily')
    expect(presetFromRule({ frequency: 'weekly' })).toBe('weekly')
    expect(presetFromRule({ frequency: 'weekly', interval: 2 })).toBe('biweekly')
    expect(presetFromRule({ frequency: 'monthly' })).toBe('monthly')
    expect(presetFromRule({ frequency: 'yearly' })).toBe('yearly')
  })

  it('calls anything it cannot express CUSTOM rather than the nearest offer', () => {
    /*
     * The label has to be true. "Every week" on a rule that means "every week on Tuesdays and
     * Thursdays" is a lie the reader only discovers by saving — and by then the `byDay` is gone,
     * because the editor would have written back the preset it displayed.
     */
    expect(
      presetFromRule({ frequency: 'weekly', byDay: [{ day: 'tu' }, { day: 'th' }] }),
    ).toBe('custom')
    expect(presetFromRule({ frequency: 'weekly', interval: 3 })).toBe('custom')
    expect(presetFromRule({ frequency: 'monthly', byMonthDay: [1] })).toBe('custom')
  })

  it('does not mistake an ending for a rule it cannot name', () => {
    // `count` and `until` are endings the editor DOES control, so a rule carrying one is still one
    // of the five. Treating them as unknown members would make every finite series "custom".
    expect(presetFromRule({ frequency: 'weekly', count: 6 })).toBe('weekly')
    expect(presetFromRule({ frequency: 'weekly', until: '2026-12-31T23:59:59' })).toBe('weekly')
  })
})

describe('ruleToWrite', () => {
  it('clears the ending it did not choose', () => {
    // A rule that keeps a stale `count` beside a fresh `until` has two endings. `null` is how a
    // JMAP patch removes a member (RFC 8620 §5.3); measured accepted inside `recurrenceRule`.
    const rule = ruleToWrite('weekly', { kind: 'until', until: '2026-12-31T23:59:59' }, {
      frequency: 'weekly',
      count: 6,
    }) as unknown as Record<string, unknown>
    expect(rule.until).toBe('2026-12-31T23:59:59')
    expect(rule.count).toBeNull()
  })

  it('carries a rule it cannot name straight through', () => {
    // The whole reason `custom` exists. The editor has no `byDay` control, and that must not be the
    // reason a reader's Tuesday-and-Thursday meeting becomes a plain weekly one.
    const stored = { frequency: 'weekly' as const, byDay: [{ day: 'tu' }, { day: 'th' }] }
    const rule = ruleToWrite('custom', { kind: 'never' }, stored) as unknown as Record<string, unknown>
    expect(rule.byDay).toEqual([{ day: 'tu' }, { day: 'th' }])
  })

  it('answers null for "does not repeat"', () => {
    expect(ruleToWrite('none', { kind: 'never' }, { frequency: 'weekly' })).toBeNull()
  })
})

describe('endFromRule', () => {
  it('reads both endings and neither', () => {
    expect(endFromRule({ frequency: 'weekly' })).toEqual({ kind: 'never' })
    expect(endFromRule({ frequency: 'weekly', count: 6 })).toEqual({ kind: 'count', count: 6 })
    expect(endFromRule({ frequency: 'weekly', until: '2026-12-31T23:59:59' })).toEqual({
      kind: 'until',
      until: '2026-12-31T23:59:59',
    })
  })
})

describe('overrideKeyFor', () => {
  it('uses the occurrence’s recurrenceId when nothing has been overridden yet', () => {
    const occurrence = { recurrenceId: '2026-09-14T09:00:00', start: '2026-09-14T09:00:00' }
    expect(overrideKeyFor(master(), occurrence as CalendarEvent)).toBe('2026-09-14T09:00:00')
  })

  it('finds a MOVED occurrence under its ORIGINAL key, not the one it was handed', () => {
    /*
     * The trap, measured. An override keyed `2026-09-21T09:00:00` that moves the start to 16:00 is
     * expanded by Stalwart as `recurrenceId: "2026-09-21T16:00:00"` — the recurrenceId FOLLOWS the
     * new start. Keying the second edit by that value writes a SECOND override, leaves the first in
     * place, and the reader sees the occurrence twice.
     */
    const stored = master({
      recurrenceOverrides: {
        '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00', title: 'Verschoben' },
      },
    })
    const asExpanded = {
      recurrenceId: '2026-09-21T16:00:00',
      start: '2026-09-21T16:00:00',
    } as CalendarEvent
    expect(overrideKeyFor(stored, asExpanded)).toBe('2026-09-21T09:00:00')
  })

  it('refuses to invent a key for something that is not an occurrence', () => {
    // An override keyed by a date the rule does not generate is a ghost: the server stores it and
    // nothing ever shows it. The caller has to hear "no", not a plausible-looking key.
    expect(overrideKeyFor(master(), master())).toBeNull()
  })
})

describe('mergeOverride', () => {
  it('KEEPS every other occurrence’s override', () => {
    /*
     * The assertion this file exists for. A whole-map write REPLACES on this server — measured:
     * writing `{ "2027-01-25…": {…} }` over a map that held two other entries left exactly one.
     * So merging is not tidiness, it is the difference between changing one occurrence and deleting
     * every exception the series had.
     */
    const stored = master({
      recurrenceOverrides: {
        '2026-09-14T09:00:00': { excluded: true },
        '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00', updated: '2026-08-21T19:04:39Z' },
      },
    })
    const next = mergeOverride(stored, '2026-09-28T09:00:00', { title: 'Sonderfall' })

    expect(Object.keys(next).sort()).toEqual([
      '2026-09-14T09:00:00',
      '2026-09-21T09:00:00',
      '2026-09-28T09:00:00',
    ])
    expect(next['2026-09-14T09:00:00']).toEqual({ excluded: true })
    expect(next['2026-09-21T09:00:00']).toEqual({
      start: '2026-09-21T16:00:00',
      // The server writes this member into an override by itself; a merge that dropped it would
      // hand back a record the server has to re-stamp.
      updated: '2026-08-21T19:04:39Z',
    })
  })

  it('merges INTO an entry rather than over it', () => {
    const stored = master({
      recurrenceOverrides: { '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00' } },
    })
    expect(mergeOverride(stored, '2026-09-21T09:00:00', { title: 'Neu' })).toEqual({
      '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00', title: 'Neu' },
    })
  })

  it('removes a member when the patch names it undefined', () => {
    // An override is a patch: a member it does not name follows the master. `undefined` is how an
    // occurrence is given the series' value back, and there is no other way to say it.
    const stored = master({
      recurrenceOverrides: { '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00', title: 'X' } },
    })
    expect(mergeOverride(stored, '2026-09-21T09:00:00', { title: undefined })).toEqual({
      '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00' },
    })
  })
})

describe('excludeOverride', () => {
  it('replaces the entry with `excluded` and keeps the rest', () => {
    // Replaced, not merged: an occurrence that was moved and is now deleted must not keep the moved
    // start. `excluded: true` is the whole of what is left to say about it.
    const stored = master({
      recurrenceOverrides: {
        '2026-09-14T09:00:00': { title: 'Behalten' },
        '2026-09-21T09:00:00': { start: '2026-09-21T16:00:00' },
      },
    })
    expect(excludeOverride(stored, '2026-09-21T09:00:00')).toEqual({
      '2026-09-14T09:00:00': { title: 'Behalten' },
      '2026-09-21T09:00:00': { excluded: true },
    })
  })
})

describe('overrideFromDraft', () => {
  it('writes only what DIFFERS from the master', () => {
    /*
     * An override is a JSCalendar patch. A member it names is frozen against every later change to
     * the series — so an editor that wrote every field would silently detach the occurrence, and
     * "move the whole series an hour later" would leave this one behind for no reason the reader
     * could see.
     */
    const stored = master()
    const entry = overrideFromDraft(stored, {
      '@type': 'Event',
      calendarIds: { c1: true },
      title: 'Serie',
      start: '2026-09-14T14:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
    })

    expect(entry.start).toBe('2026-09-14T14:00:00')
    // Equal to the master ⇒ `undefined` ⇒ removed from the override by `mergeOverride`.
    expect(entry.title).toBeUndefined()
    expect(entry.duration).toBeUndefined()
    expect(entry.timeZone).toBeUndefined()
  })

  it('compares the duration by VALUE, not by spelling', () => {
    /*
     * The editor holds minutes and writes `PT60M`; a master stored by another client (or by this
     * server) says `PT1H`. Same hour, different text — and compared as text the override would
     * gain a `duration` the reader never touched. Override members are sticky: change the SERIES
     * length later and this one occurrence keeps the old one. The symptom appears weeks after the
     * edit, as a single meeting of the wrong length, with nothing on screen to explain it.
     */
    const entry = overrideFromDraft(master(), {
      start: '2026-09-14T09:00:00',
      duration: 'PT60M',
    })

    expect(entry.duration).toBeUndefined()
  })

  it('never puts the JMAP envelope into a JSCalendar override', () => {
    // `calendarIds` is `draft-ietf-jmap-calendars`, not JSCalendar, and an occurrence does not live
    // in a different calendar from its master.
    const entry = overrideFromDraft(master(), { calendarIds: { other: true }, title: 'Neu' })
    expect(entry).not.toHaveProperty('calendarIds')
    expect(entry.title).toBe('Neu')
  })
})

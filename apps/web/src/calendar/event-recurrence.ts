/**
 * Repetition, and changing one occurrence of it (K-2, FR-CAL-01).
 *
 * **The measurement that decided this file's design, and it contradicts the plan.**
 * `PLAN-kalender.md` states as a rule that "the overrides map must never be written back as a
 * whole — only as a pointer patch", and lists as its one open question whether a *patch* of
 * `{"excluded": true}` is accepted the way the same value is at create time. Probed against
 * Stalwart v0.16.18 on 21.08.2026:
 *
 * ```jsonc
 * update: { "b": { "recurrenceOverrides/2026-09-14T09:00:00": { "excluded": true } } }
 * → notUpdated: { "b": { "type": "invalidProperties",
 *                        "description": "Patch operation failed.",
 *                        "properties": ["recurrenceOverrides/2026-09-14T09:00:00"] } }
 *
 * update: { "b": { "recurrenceOverrides": { "2026-09-14T09:00:00": { "excluded": true } } } }
 * → updated: { "b": null }        // and it reads back exactly so
 * ```
 *
 * A pointer one level deeper (`recurrenceOverrides/<rid>/title`) is refused in the same words, and
 * — the control that makes this a fact about this property rather than about patching — a
 * `recurrenceRule/count` pointer in the very same request IS accepted. So the plan's rule is not
 * merely unnecessary here, it is **not implementable**: on this server the whole map is the only
 * way in.
 *
 * That leaves the danger the plan's rule existed to prevent, and it has to be handled rather than
 * wished away: a whole-map write sends back everything the client last read, so an override another
 * client added in between is lost. The mitigation is in `calendar-client.ts` — the map is READ in
 * the same JMAP request that writes it, never from the copy the screen is holding, so the window
 * shrinks from "however long the dialog was open" to the ordering of two calls inside one batch.
 * Entries are merged, not replaced, so the `updated` stamp the server writes into an override
 * survives.
 *
 * **The second trap is the key.** An override is keyed by the occurrence's ORIGINAL start. Once it
 * has been moved, the expansion reports the occurrence with `recurrenceId` equal to its NEW start:
 * measured, override key `2026-09-21T09:00:00`, expanded `recurrenceId: "2026-09-21T16:00:00"`. A
 * client that keys by the `recurrenceId` it was handed therefore writes a SECOND override on the
 * second edit and leaves the first behind — one occurrence becomes two. {@link overrideKeyFor}
 * looks the moved occurrence up in the stored map before believing what it was told.
 */

import type { CalendarEvent, LocalDateTime, RecurrenceRule } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import { durationToMs } from './jscalendar-time'

/**
 * The repetitions the editor offers by name.
 *
 * Apple's five, and no more. The overwhelming majority of repeating events are one of these; a rule
 * this list cannot express is shown as `custom` and left exactly as it is, because a "simplify to
 * the nearest offer" would quietly rewrite somebody's real rule into an approximation of it.
 */
export type RepeatPreset =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'yearly'
  | 'custom'

/** The presets the picker lists, in Apple's order. `custom` is a state, not a choice. */
export const REPEAT_PRESETS: readonly RepeatPreset[] = [
  'none',
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'yearly',
]

/** The rule one preset means, or `null` for "does not repeat". */
export function ruleForPreset(preset: RepeatPreset): RecurrenceRule | null {
  switch (preset) {
    case 'daily':
      return { '@type': 'RecurrenceRule', frequency: 'daily' }
    case 'weekly':
      return { '@type': 'RecurrenceRule', frequency: 'weekly' }
    case 'biweekly':
      return { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 2 }
    case 'monthly':
      return { '@type': 'RecurrenceRule', frequency: 'monthly' }
    case 'yearly':
      return { '@type': 'RecurrenceRule', frequency: 'yearly' }
    default:
      return null
  }
}

/**
 * Which named repetition a stored rule is, if any.
 *
 * Deliberately strict — a rule carrying `byDay`, `byMonth`, `bySetPosition` or anything else this
 * client does not model is `custom`, even when its frequency matches an offer. Reporting "Every
 * week" for a rule that means "every week on Tuesdays and Thursdays" would be a label that lies,
 * and the reader would only find out by saving.
 */
export function presetFromRule(rule: RecurrenceRule | undefined | null): RepeatPreset {
  if (rule === undefined || rule === null || typeof rule !== 'object') return 'none'
  const extras = Object.keys(rule).filter(
    (key) =>
      key !== '@type' &&
      key !== 'frequency' &&
      key !== 'interval' &&
      key !== 'count' &&
      key !== 'until',
  )
  if (extras.length > 0) return 'custom'
  const interval = rule.interval ?? 1
  switch (rule.frequency) {
    case 'daily':
      return interval === 1 ? 'daily' : 'custom'
    case 'weekly':
      return interval === 1 ? 'weekly' : interval === 2 ? 'biweekly' : 'custom'
    case 'monthly':
      return interval === 1 ? 'monthly' : 'custom'
    case 'yearly':
      return interval === 1 ? 'yearly' : 'custom'
    default:
      return 'custom'
  }
}

/** How a repetition ends. `until` and `count` are mutually exclusive in JSCalendar. */
export type RepeatEnd =
  | { readonly kind: 'never' }
  | { readonly kind: 'until'; readonly until: LocalDateTime }
  | { readonly kind: 'count'; readonly count: number }

export function endFromRule(rule: RecurrenceRule | undefined | null): RepeatEnd {
  if (rule === undefined || rule === null) return { kind: 'never' }
  if (typeof rule.until === 'string' && rule.until !== '')
    return { kind: 'until', until: rule.until }
  if (typeof rule.count === 'number' && rule.count > 0) return { kind: 'count', count: rule.count }
  return { kind: 'never' }
}

/**
 * The rule to write: the preset, with the ending applied.
 *
 * A preset the client cannot name (`custom`) returns the stored rule UNCHANGED apart from its
 * ending — the editor may not have a control for `byDay`, but it must not be the reason `byDay`
 * disappears.
 *
 * The ending that is NOT chosen is written as `null` rather than left out: this object is a JMAP
 * patch member, and a rule that keeps a stale `count` beside a fresh `until` is a rule with two
 * endings. Measured: `count: null` inside `recurrenceRule` is accepted and read back as `null`.
 */
export function ruleToWrite(
  preset: RepeatPreset,
  end: RepeatEnd,
  stored: RecurrenceRule | undefined | null,
): RecurrenceRule | null {
  const base = preset === 'custom' ? (stored ?? null) : ruleForPreset(preset)
  if (base === null) return null
  const rule: Record<string, unknown> = { ...base }
  rule.until = end.kind === 'until' ? end.until : null
  rule.count = end.kind === 'count' ? end.count : null
  return rule as unknown as RecurrenceRule
}

/** A one-line description of a rule, for the value at the right of the "Repeat" row. */
export function describeRule(rule: RecurrenceRule | undefined | null, t: TFunction): string {
  const preset = presetFromRule(rule)
  return t(`calendar.event.repeat.${preset}`)
}

/**
 * The key in `recurrenceOverrides` that addresses this occurrence — or `null` when none does.
 *
 * Three steps, and the middle one is the whole reason this function exists rather than a property
 * access:
 *
 * 1. The stored map already has an entry under the occurrence's `recurrenceId`. That is the ordinary
 *    case, and also the case of an occurrence that was only EXCLUDED (its start never moved).
 * 2. Otherwise: an entry whose overridden `start` equals the occurrence's start. This is the moved
 *    occurrence, whose expansion reports the new start as its `recurrenceId` — measured. Without
 *    this step the second edit of a moved occurrence writes a second override and the series shows
 *    the occurrence twice.
 * 3. Otherwise the `recurrenceId` itself: a fresh override for an occurrence nobody has touched.
 *
 * `null` for an event carrying no `recurrenceId` at all — a master, or a plain event. The caller
 * must not invent one: an override keyed by a date the rule does not generate is a ghost occurrence
 * the server will happily store and nothing will ever show.
 */
export function overrideKeyFor(
  master: CalendarEvent,
  occurrence: CalendarEvent,
): LocalDateTime | null {
  const recurrenceId = occurrence.recurrenceId
  if (typeof recurrenceId !== 'string' || recurrenceId === '') return null
  const overrides = readOverrides(master)
  if (Object.hasOwn(overrides, recurrenceId)) return recurrenceId

  const start = typeof occurrence.start === 'string' ? occurrence.start : ''
  if (start !== '') {
    for (const [key, value] of Object.entries(overrides)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).start === start
      ) {
        return key
      }
    }
  }
  return recurrenceId
}

/** The stored overrides map, defended against every shape that is not one. */
export function readOverrides(
  event: CalendarEvent,
): Record<string, Record<string, unknown> | null> {
  const overrides = event.recurrenceOverrides
  if (overrides === undefined || overrides === null || typeof overrides !== 'object') return {}
  return overrides as Record<string, Record<string, unknown> | null>
}

/**
 * The whole `recurrenceOverrides` map to write, with one entry merged in.
 *
 * MERGED and not replaced, on both levels. The map keeps every other occurrence's override; the
 * entry keeps whatever it already held, including the `updated` timestamp the server writes into it
 * (measured: an override written by the client comes back with an `updated` member it did not send).
 *
 * `patch` values of `undefined` REMOVE a member from the override — that is how an occurrence is
 * given its master's value back, and it is the only way, because an override is a patch and an
 * absent member means "as the master has it".
 */
export function mergeOverride(
  master: CalendarEvent,
  key: LocalDateTime,
  patch: Readonly<Record<string, unknown>>,
): Record<string, Record<string, unknown> | null> {
  const overrides = { ...readOverrides(master) }
  const existing = overrides[key]
  const merged: Record<string, unknown> =
    existing === null || existing === undefined ? {} : { ...existing }
  for (const [member, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[member]
    else merged[member] = value
  }
  overrides[key] = merged
  return overrides
}

/**
 * The whole map with one occurrence excluded — deleting a single occurrence of a series.
 *
 * The entry is REPLACED by `{excluded: true}` rather than merged, and that is deliberate: an
 * occurrence that was moved and is now deleted should not keep the moved `start`. `excluded` is the
 * whole of what is left to say about it.
 */
export function excludeOverride(
  master: CalendarEvent,
  key: LocalDateTime,
): Record<string, Record<string, unknown> | null> {
  return { ...readOverrides(master), [key]: { excluded: true } }
}

/**
 * The override entry that expresses a draft, relative to the master.
 *
 * **Only what DIFFERS from the master.** An override is a JSCalendar patch: a member it does not
 * name follows the master, which is what makes "change the time of all of them" still reach an
 * occurrence whose title alone was changed. Writing every field would freeze the occurrence against
 * every future change to the series — an editor that quietly detaches an occurrence from its series
 * is the failure mode this shape exists to avoid.
 *
 * `calendarIds` is never in it: it is the JMAP envelope, not JSCalendar, and an occurrence does not
 * live in a different calendar from its master.
 */
export function overrideFromDraft(
  master: CalendarEvent,
  patch: Readonly<Record<string, unknown>>,
  occurrenceStart: LocalDateTime,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  for (const [member, value] of Object.entries(patch)) {
    if (member === 'calendarIds' || FORBIDDEN_IN_OVERRIDE.has(member)) continue
    /*
     * `start` is compared against the start of THIS occurrence, not the master's.
     *
     * The master's `start` is the first instance's (7 September); the draft carries the one being
     * edited (14 September). Compared against each other they always differ, so every
     * single-occurrence edit — a title, a note — wrote a `start` the reader never touched, and an
     * override member is sticky: move the SERIES an hour later afterwards and that one occurrence
     * stays behind at the old time, for ever, with nothing on screen to say why (R-06).
     *
     * The baseline is the override KEY, which is the start the rule generates for this occurrence.
     * Not the start it currently HAS: an occurrence already moved by an earlier override must keep
     * that move when the reader edits its title, and comparing against the moved value would emit
     * `undefined` and snap it back to the rule.
     */
    const stored = member === 'start' ? occurrenceStart : master[member]
    // `undefined` removes the member from the override; see `mergeOverride`.
    entry[member] = sameAsMaster(stored, value, member) ? undefined : value
  }
  return entry
}

/**
 * The members a `recurrenceOverrides` patch may not carry.
 *
 * `draft-ietf-calext-jscalendarbis-18` §3.3.4 (the wire format this server speaks, ADR-025): "A
 * pointer in the PatchObject MUST be ignored if it either exactly matches one of: @type, method,
 * organizerCalendarAddress, participants/&#42;/"calendarAddress", privacy, prodId, recurrenceId,
 * recurrenceIdTimeZone, sentBy, uid — or if the first reference token of the pointer matches one of:
 * recurrenceOverrides, recurrenceRule, relatedTo". RFC 8984 §4.3.5 says the same with its own
 * spellings (`recurrenceRules`, plus `excludedRecurrenceRules`, `replyTo`, `timeZones`), and both
 * are listed so a server speaking either gets a patch it can use.
 *
 * `recurrenceRule` is the one this editor actually hit: every draft carries a repeat, the master
 * was read without its rule, and `ruleToWrite` spells the rule with `until: null, count: null`
 * where the stored one has neither — so the comparison never matched and a rule went into every
 * override. Not a rejection, per the text above; just ballast, and ballast in a patch that is
 * rewritten whole is a hazard rather than a curiosity. `calendarIds` is excluded separately: it is
 * the JMAP envelope rather than JSCalendar, and an occurrence does not live in another calendar
 * from its master.
 */
const FORBIDDEN_IN_OVERRIDE: ReadonlySet<string> = new Set([
  '@type',
  'excludedRecurrenceRules',
  'method',
  'organizerCalendarAddress',
  'privacy',
  'prodId',
  'recurrenceId',
  'recurrenceIdTimeZone',
  'recurrenceOverrides',
  'recurrenceRule',
  'recurrenceRules',
  'relatedTo',
  'replyTo',
  'sentBy',
  'timeZones',
  'uid',
])

/**
 * Structural equality, JSON-deep — the values here are JSCalendar scalars, maps and lists.
 *
 * `duration` is compared by VALUE, not by spelling, and that exception earns its keep. The editor
 * carries a duration in minutes and writes `PT60M`; a server (and any other client) is free to
 * store the same hour as `PT1H`. Compared as text those differ, so every single-occurrence edit
 * would have written a `duration` into the override that the reader never touched — and an
 * override member is sticky: change the SERIES duration later and that one occurrence silently
 * keeps the old length. The bug is invisible on the day it is written and shows up weeks later as
 * one meeting that is the wrong length.
 */
function sameAsMaster(stored: unknown, next: unknown, member?: string): boolean {
  if (stored === next) return true
  if (stored === undefined && next === null) return true
  if (member === 'duration' && typeof stored === 'string' && typeof next === 'string') {
    return durationToMs(stored) === durationToMs(next)
  }
  if (member === 'alerts') return sameAlerts(stored, next)
  return canonicalJson(stored ?? null) === canonicalJson(next ?? null)
}

/**
 * Alerts compared by what they SAY, not by the keys they are filed under.
 *
 * The keys of an `alerts` map are the client's to choose, and `alertsToPatch` chooses fresh ones
 * (`w1`, `w2`) rather than reusing the server's (`a1`, `k3`). Compared as maps, an event whose
 * alarms were not touched at all therefore looked changed, and every single-occurrence edit froze
 * that occurrence's reminders against every later change to the series (R-06). Compared as a set of
 * alert objects, "the same two reminders under different names" is the same answer.
 */
function sameAlerts(stored: unknown, next: unknown): boolean {
  const a = alertValues(stored)
  const b = alertValues(next)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function alertValues(value: unknown): string[] {
  if (value === null || value === undefined || typeof value !== 'object') return []
  return Object.values(value as Record<string, unknown>)
    .map(canonicalJson)
    .sort()
}

/**
 * JSON with object keys in a fixed order — so equality is about the VALUE, not about how the two
 * sides happened to build it.
 *
 * `JSON.stringify` preserves insertion order, so `{action, trigger}` and `{trigger, action}`
 * compared unequal and a member the reader never touched went into the override (R-06). Local
 * rather than imported from `contact-card-mapping.ts`, which has a `deepEqual` of its own: the
 * calendar has no other reason to depend on the contacts module, and one small function is a
 * cheaper price than that edge in the bundle graph.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** The scopes a change to a repeating event may have. */
export type EditScope = 'occurrence' | 'all'

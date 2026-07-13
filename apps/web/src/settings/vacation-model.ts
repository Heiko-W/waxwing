/**
 * The vacation responder's pure half (M3.7, FR-VAC-01): the form draft, its validation, and the
 * conversion to and from the RFC 8621 §8 wire object.
 *
 * **Timezones are the whole difficulty here, and they are handled in exactly one place.** The RFC's
 * `fromDate`/`toDate` are UTC instants; an `<input type="datetime-local">` speaks the user's LOCAL
 * wall clock and carries no offset at all. `new Date('2026-07-13T09:00')` is interpreted in the
 * browser's zone — which is precisely what "I am away from 9 in the morning" means — so the
 * conversion goes through `Date` in both directions and never slices an ISO string or appends a `Z`.
 * A test that hardcodes an offset would only pass in the author's timezone; derive it instead.
 */

import type { PatchObject, VacationResponse } from '@waxwing/jmap'
import { cleanOutgoingHtml, htmlToPlainText } from '../compose'

export interface VacationDraft {
  readonly isEnabled: boolean
  /** `<input type="datetime-local">` value in LOCAL wall-clock time; `''` = no bound. */
  readonly fromLocal: string
  readonly toLocal: string
  readonly subject: string
  readonly bodyHtml: string
}

export type VacationErrorCode = 'endBeforeStart'
export type VacationStatus = 'off' | 'active' | 'scheduled' | 'expired'

export const DEFAULT_VACATION_DRAFT: VacationDraft = {
  isEnabled: false,
  fromLocal: '',
  toLocal: '',
  subject: '',
  bodyHtml: '',
}

/** Pad to the two digits `datetime-local` requires. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A UTC instant → the local wall-clock string the input wants. `''` for `null`/unparsable. */
export function utcToLocalInput(utc: string | null): string {
  if (utc === null || utc === '') return ''
  const date = new Date(utc)
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** A local wall-clock input value → a UTC instant. `null` for `''` or garbage. */
export function localInputToUtc(value: string): string | null {
  if (value.trim() === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function toDraft(vacation: VacationResponse): VacationDraft {
  return {
    isEnabled: vacation.isEnabled,
    fromLocal: utcToLocalInput(vacation.fromDate),
    toLocal: utcToLocalInput(vacation.toDate),
    subject: vacation.subject ?? '',
    bodyHtml: vacation.htmlBody ?? '',
  }
}

/**
 * The `/set` patch. An empty subject or body becomes `null` — "let the server decide" — and never
 * `""`, which would be an explicit instruction to send an auto-reply with a blank subject.
 *
 * Both body alternatives are always written: a responder that only ever sent HTML would be unreadable
 * to a plain-text client, and the text half comes free from the same helper the composer uses.
 */
export function toPatch(draft: VacationDraft): PatchObject {
  const html = cleanOutgoingHtml(draft.bodyHtml)
  const hasBody = htmlToPlainText(html).trim() !== ''
  const subject = draft.subject.trim()
  return {
    isEnabled: draft.isEnabled,
    fromDate: localInputToUtc(draft.fromLocal),
    toDate: localInputToUtc(draft.toLocal),
    subject: subject === '' ? null : subject,
    htmlBody: hasBody ? html : null,
    textBody: hasBody ? htmlToPlainText(html) : null,
  }
}

export function validateVacation(draft: VacationDraft): VacationErrorCode | null {
  const from = localInputToUtc(draft.fromLocal)
  const to = localInputToUtc(draft.toLocal)
  if (from === null || to === null) return null
  return Date.parse(to) <= Date.parse(from) ? 'endBeforeStart' : null
}

/** What the responder is doing right now, in the user's own terms. */
export function vacationStatus(draft: VacationDraft, nowMs: number): VacationStatus {
  if (!draft.isEnabled) return 'off'
  const from = localInputToUtc(draft.fromLocal)
  const to = localInputToUtc(draft.toLocal)
  if (to !== null && Date.parse(to) <= nowMs) return 'expired'
  if (from !== null && Date.parse(from) > nowMs) return 'scheduled'
  return 'active'
}

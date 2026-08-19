/**
 * Pure form model for the identity editor (M5.1, FR-CMP-06, RFC 8621 §6).
 *
 * The wire shape and the form shape differ in exactly two ways, and both are deliberate:
 *
 * - `replyTo`/`bcc` are `EmailAddress[] | null` on the wire and free text in the form, parsed with
 *   the composer's own {@link parseAddressList}. One parser for every address the user types, so
 *   `Name <a@b.test>` means the same thing here as it does in the To field.
 * - An empty string means "unset" and is written back as `null` (or `""` for the signatures, whose
 *   RFC default is the empty string, not null). A server told `replyTo: ""` would reject it as
 *   `invalidProperties`.
 *
 * `email` is immutable per RFC 8621 §6 — it is part of the draft because CREATE needs it, and the
 * form disables it when editing rather than pretending a rename is possible.
 *
 * ## The HTML signature is sanitized in BOTH directions, and this is the only place it happens
 * Coming FROM the server it is untrusted markup on its way into a contenteditable in the app
 * document (an admin set it, another client set it, or it predates us) — the same door
 * `quoted-html.ts` measured a `position:fixed` credential-prompt overlay coming through. Going TO
 * the server it is what every future draft will paste in, so shipping something the reader's own
 * composer would then strip is a signature that silently differs from what was typed.
 * {@link sanitizeQuotedHtml} is the right pass rather than `mail-html`'s `sanitize()`: that one is
 * written for the reading pane's sandboxed frame, this one for HTML that lands in OUR document.
 */

import type { Identity, IdentityCreate, IdentityWritable } from '@waxwing/jmap'
import {
  cleanOutgoingHtml,
  formatAddress,
  isPlausibleEmail,
  parseAddressList,
  sanitizeQuotedHtml,
} from '../compose'

export interface IdentityDraft {
  /** Create-only; immutable on an existing identity. */
  readonly email: string
  readonly name: string
  /** Free text, comma/semicolon separated — parsed by {@link parseAddressList}. */
  readonly replyTo: string
  readonly bcc: string
  readonly textSignature: string
  readonly htmlSignature: string
}

export const EMPTY_IDENTITY_DRAFT: IdentityDraft = {
  email: '',
  name: '',
  replyTo: '',
  bcc: '',
  textSignature: '',
  htmlSignature: '',
}

/** Wire → form. */
export function toDraft(identity: Identity): IdentityDraft {
  return {
    email: identity.email,
    name: identity.name,
    replyTo: (identity.replyTo ?? []).map(formatAddress).join(', '),
    bcc: (identity.bcc ?? []).map(formatAddress).join(', '),
    textSignature: identity.textSignature,
    htmlSignature: sanitizeQuotedHtml(identity.htmlSignature),
  }
}

/** Trimmed-empty → `null`; otherwise the parsed list. */
function addresses(input: string): Identity['replyTo'] {
  const parsed = parseAddressList(input)
  return parsed.length === 0 ? null : parsed
}

/** Form → the writable half of the wire record (everything but the immutable `email`). */
export function toWritable(draft: IdentityDraft): IdentityWritable {
  return {
    name: draft.name.trim(),
    replyTo: addresses(draft.replyTo),
    bcc: addresses(draft.bcc),
    textSignature: draft.textSignature,
    // `cleanOutgoingHtml` first (Squire's editor-only classes and cursor fillers are not signature),
    // then the same sanitizer the draft path applies — so what is stored is what will be inserted.
    htmlSignature: sanitizeQuotedHtml(cleanOutgoingHtml(draft.htmlSignature)),
  }
}

/**
 * Form → an update patch carrying ONLY what actually changed.
 *
 * Not `toWritable`, and the difference is a data-loss bug rather than a nicety. `toDraft` sanitizes
 * the HTML signature on the way IN, so a signature the server holds with, say, an inline `<svg>` logo
 * arrives in the form without it. A patch that always carried every writable field would then write
 * that stripped version back the moment the user edited something else entirely — renaming the
 * identity would silently delete the logo. Sending only changed fields means an untouched signature
 * is never mentioned, so the server keeps exactly what it had.
 *
 * The comparison runs on both sides' `toWritable` output, so it compares what the SERVER would end
 * up with — not the raw text of two form fields that mean the same address list.
 */
export function toPatch(draft: IdentityDraft, original: Identity): IdentityWritable {
  const before = toWritable(toDraft(original))
  const after = toWritable(draft)
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key as keyof IdentityWritable])) {
      patch[key] = value
    }
  }
  return patch
}

/** Form → a create payload: the writable half plus the address, which only `create` may set. */
export function toCreate(draft: IdentityDraft): IdentityCreate {
  return { ...toWritable(draft), email: draft.email.trim() }
}

/** The first problem with the draft, as an i18n key suffix, or `null` when it is sendable. */
export type IdentityProblem = 'emailMissing' | 'emailInvalid' | 'replyToInvalid' | 'bccInvalid'

export interface ValidateOptions {
  /** Creating requires an address; editing cannot change one, so it is not re-checked. */
  readonly creating: boolean
}

function anyImplausible(input: string): boolean {
  return parseAddressList(input).some((address) => !isPlausibleEmail(address.email))
}

export function validateIdentity(
  draft: IdentityDraft,
  options: ValidateOptions,
): IdentityProblem | null {
  if (options.creating) {
    if (draft.email.trim() === '') return 'emailMissing'
    if (!isPlausibleEmail(draft.email)) return 'emailInvalid'
  }
  if (anyImplausible(draft.replyTo)) return 'replyToInvalid'
  if (anyImplausible(draft.bcc)) return 'bccInvalid'
  return null
}

/**
 * Has anything the server stores actually changed?
 *
 * Guards a pointless `/set` round-trip — and a pointless round-trip is not free here: it spends the
 * `ifInState` it was given, so a save that changed nothing can still come back as a conflict caused
 * by somebody else's edit, which is a baffling thing to show a user who typed nothing.
 */
export function isDirty(draft: IdentityDraft, original: Identity): boolean {
  return Object.keys(toPatch(draft, original)).length > 0
}

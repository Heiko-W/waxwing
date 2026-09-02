/**
 * Pure draft (de)serialization + JMAP mapping (M2.6, FR-CMP-03). Bridges the in-memory composer
 * `DraftWindow` ↔ the persisted `SerializedDraft`/`DraftRow`, decides whether a draft is empty
 * (never persisted/synced), and builds the `Email/set` create body for the Drafts mailbox. No React,
 * no network — fully unit-tested.
 */

import type { EmailAddress, EmailBodyPart, EmailCreate, Id } from '@waxwing/jmap'
import type { DraftRow, EmailRow, SerializedDraft } from '../sync'
import { cleanOutgoingHtml } from './clean-html'
import type { DraftWindow, OpenDraftInit } from './composer-store'
import { htmlToPlainText } from './html-to-text'
import { referencedCids, removeInlineImage } from './inline-images'
import { DEFAULT_SEND_OPTIONS, priorityHeaders, type SendOptions } from './send-options'
import { bodyWithoutSignature } from './signature'

/** The persistable subset of a live draft (UI-only mode/dirty/focus excluded). */
export function serializeDraft(draft: DraftWindow): SerializedDraft {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    replyTo: draft.replyTo,
    subject: draft.subject,
    body: draft.body,
    plainText: draft.plainText,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    fromIdentityId: draft.fromIdentityId ?? null,
    fromIdentityHint: draft.fromIdentityHint ?? null,
    attachments: draft.attachments,
    sourceEmailId: draft.sourceEmailId ?? null,
    sourceFlag: draft.sourceFlag ?? null,
    sendOptions: draft.sendOptions,
  }
}

/** A stored draft's options, defaulted — a row written before M-7/M-11 simply has none. */
export function draftSendOptions(draft: Pick<SerializedDraft, 'sendOptions'>): SendOptions {
  return draft.sendOptions ?? DEFAULT_SEND_OPTIONS
}

/** A persisted draft → an `openDraft` init that reopens it under the SAME localId. */
export function deserializeDraft(row: DraftRow): OpenDraftInit {
  const content = row.content
  return {
    id: row.localId,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    replyTo: content.replyTo ?? [],
    subject: content.subject,
    body: content.body,
    plainText: content.plainText ?? false,
    inReplyTo: content.inReplyTo,
    references: content.references,
    fromIdentityId: content.fromIdentityId ?? undefined,
    fromIdentityHint: content.fromIdentityHint ?? undefined,
    attachments: content.attachments,
    sourceEmailId: content.sourceEmailId ?? undefined,
    sourceFlag: content.sourceFlag ?? undefined,
    sendOptions: draftSendOptions(content),
  }
}

/**
 * A draft worth neither persisting nor syncing: no recipients, blank subject, no attachment, and
 * nothing in the body that the WRITER put there.
 *
 * Two things this deliberately does NOT count as content:
 *  - the seeded SIGNATURE. It is inserted into every new draft as soon as the identities load, so
 *    with one configured, "New message" + close (or just waiting out the 3 s autosave) filed a
 *    signature-only draft in the Drafts folder, visible on every other client, and Discard asked
 *    for a confirmation about a window nobody had typed in.
 *  - nothing else. `dirty === false` was the other candidate for the same job and is WRONG here:
 *    it is also false for a draft REOPENED from the Drafts folder, and this predicate now decides
 *    whether a stored draft gets deleted (see `flushDraft`) — so open-and-close would have
 *    destroyed a real message.
 *
 * An ATTACHMENT is content, and its absence from the list was its own defect: a draft whose only
 * content was a finished 20 MB upload read as empty, so closing the window saved nothing and
 * Discard threw it away without asking.
 */
export function isEmptyDraft(draft: DraftWindow | SerializedDraft): boolean {
  const noRecipients = draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0
  const blankSubject = draft.subject.trim() === ''
  const noAttachments = draft.attachments.length === 0
  const blankBody = htmlToPlainText(bodyWithoutSignature(draft.body)).trim() === ''
  return noRecipients && blankSubject && noAttachments && blankBody
}

/** Deep-ish equality for the small structured fields; the big strings are compared directly. */
const sameShape = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Do two persisted drafts say the same thing? Used to skip a server save that would change nothing.
 *
 * A draft save is create-new + destroy-old, so an autosave with identical content is not a cheap
 * no-op on the server: it mints a NEW Email id for the same text. Every store mutation used to arm
 * the autosave — minimizing, restoring and going full-screen among them — and each one spent a
 * round trip and a fresh server id on a message that had not changed.
 */
export function sameDraftContent(a: SerializedDraft, b: SerializedDraft): boolean {
  return (
    a.subject === b.subject &&
    a.body === b.body &&
    (a.plainText ?? false) === (b.plainText ?? false) &&
    a.fromIdentityId === b.fromIdentityId &&
    a.sourceEmailId === b.sourceEmailId &&
    a.sourceFlag === b.sourceFlag &&
    sameShape(a.to, b.to) &&
    sameShape(a.cc, b.cc) &&
    sameShape(a.bcc, b.bcc) &&
    sameShape(a.replyTo, b.replyTo) &&
    sameShape(a.inReplyTo, b.inReplyTo) &&
    sameShape(a.references, b.references) &&
    sameShape(a.attachments, b.attachments) &&
    sameShape(draftSendOptions(a), draftSendOptions(b))
  )
}

/**
 * The Drafts-mailbox `Email/set` create body. Emits a `multipart/alternative`: a `text/plain` part
 * derived from the html via {@link htmlToPlainText} (better deliverability + text-only clients) plus
 * the `text/html` part. Attachments map to `attachments[]` parts: `cid === null` → a regular
 * `disposition:"attachment"` part; `cid !== null` → an `disposition:"inline"` part the html body
 * references via `cid:` — but ONLY if that cid is still referenced (an inline image whose `<img>`
 * was deleted is pruned).
 *
 * `draft.plainText` (FR-CMP-01) emits the `text/plain` part ALONE — that is what "plain-text-only"
 * means, and shipping the html alongside it made the toggle a change of typing surface and nothing
 * more. An inline image then travels as an ordinary attachment: without an html body there is
 * nothing that could reference its `cid`, and an unreferenced `disposition:"inline"` part is a part
 * most readers simply hide.
 */
export function toEmailCreate(input: {
  draft: SerializedDraft
  draftsMailboxId: Id
  from: EmailAddress | null
}): EmailCreate {
  const { draft } = input
  const inlineCids = new Set<string>()
  for (const a of draft.attachments) if (a.cid !== null) inlineCids.add(a.cid)
  // Strip any inline `<img src="cid:…">` with no backing (completed) attachment — an upload still in
  // flight or errored — so the emitted html never references a cid that has no inline part.
  let cleaned = cleanOutgoingHtml(draft.body)
  for (const cid of referencedCids(cleaned)) {
    if (!inlineCids.has(cid)) cleaned = removeInlineImage(cleaned, cid)
  }
  const referenced = referencedCids(cleaned)
  const plainOnly = draft.plainText === true
  const parts: Partial<EmailBodyPart>[] = []
  for (const a of draft.attachments) {
    if (a.cid === null || plainOnly) {
      parts.push({
        blobId: a.blobId,
        type: a.type,
        name: a.name,
        size: a.size,
        disposition: 'attachment',
      })
    } else if (referenced.has(a.cid)) {
      parts.push({
        blobId: a.blobId,
        type: a.type,
        name: a.name,
        size: a.size,
        cid: a.cid,
        disposition: 'inline',
      })
    }
  }
  const email: EmailCreate = {
    mailboxIds: { [input.draftsMailboxId]: true },
    keywords: { $draft: true, $seen: true },
    subject: draft.subject,
    from: input.from !== null ? [input.from] : null,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    // Priority rides on the MESSAGE, so it is written here — into the Drafts copy as well as the
    // sent one. A draft saved as urgent still reads as urgent when it is reopened tomorrow.
    ...priorityHeaders(draftSendOptions(draft).priority),
    textBody: [{ partId: 'text', type: 'text/plain' }],
    ...(plainOnly ? {} : { htmlBody: [{ partId: 'html', type: 'text/html' }] }),
    bodyValues: {
      text: { value: htmlToPlainText(cleaned), isEncodingProblem: false, isTruncated: false },
      ...(plainOnly
        ? {}
        : { html: { value: cleaned, isEncodingProblem: false, isTruncated: false } }),
    },
  }
  if (draft.replyTo !== undefined && draft.replyTo.length > 0) email.replyTo = draft.replyTo
  if (parts.length > 0) email.attachments = parts
  return email
}

/** A synced Drafts envelope + its fetched body → an `openDraft` init (bcc isn't on the envelope). */
export function toDraftInit(email: EmailRow, bodyHtml: string): OpenDraftInit {
  return {
    to: email.to ?? [],
    cc: email.cc ?? [],
    // A Reply-To on a stored draft IS the writer's earlier choice; the envelope profile already
    // fetches it, so reopening from the Drafts folder no longer silently drops it.
    replyTo: email.replyTo ?? [],
    subject: email.subject ?? '',
    body: bodyHtml,
    inReplyTo: email.inReplyTo,
    references: email.references,
  }
}

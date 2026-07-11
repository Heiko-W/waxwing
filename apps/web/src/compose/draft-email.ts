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

/** The persistable subset of a live draft (UI-only mode/dirty/focus excluded). */
export function serializeDraft(draft: DraftWindow): SerializedDraft {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    fromIdentityId: draft.fromIdentityId ?? null,
    fromIdentityHint: draft.fromIdentityHint ?? null,
    attachments: draft.attachments,
    sourceEmailId: draft.sourceEmailId ?? null,
    sourceFlag: draft.sourceFlag ?? null,
  }
}

/** A persisted draft → an `openDraft` init that reopens it under the SAME localId. */
export function deserializeDraft(row: DraftRow): OpenDraftInit {
  const content = row.content
  return {
    id: row.localId,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    body: content.body,
    inReplyTo: content.inReplyTo,
    references: content.references,
    fromIdentityId: content.fromIdentityId ?? undefined,
    fromIdentityHint: content.fromIdentityHint ?? undefined,
    attachments: content.attachments,
    sourceEmailId: content.sourceEmailId ?? undefined,
    sourceFlag: content.sourceFlag ?? undefined,
  }
}

/** A draft worth neither persisting nor syncing: no recipients, blank subject, empty body. */
export function isEmptyDraft(draft: DraftWindow | SerializedDraft): boolean {
  const noRecipients = draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0
  const blankSubject = draft.subject.trim() === ''
  const blankBody = htmlToPlainText(draft.body).trim() === ''
  return noRecipients && blankSubject && blankBody
}

/**
 * The Drafts-mailbox `Email/set` create body. Emits a `multipart/alternative`: a `text/plain` part
 * derived from the html via {@link htmlToPlainText} (better deliverability + text-only clients) plus
 * the `text/html` part. Attachments map to `attachments[]` parts: `cid === null` → a regular
 * `disposition:"attachment"` part; `cid !== null` → an `disposition:"inline"` part the html body
 * references via `cid:` — but ONLY if that cid is still referenced (an inline image whose `<img>`
 * was deleted is pruned).
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
  const parts: Partial<EmailBodyPart>[] = []
  for (const a of draft.attachments) {
    if (a.cid === null) {
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
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    bodyValues: {
      text: { value: htmlToPlainText(cleaned), isEncodingProblem: false, isTruncated: false },
      html: { value: cleaned, isEncodingProblem: false, isTruncated: false },
    },
  }
  if (parts.length > 0) email.attachments = parts
  return email
}

/** A synced Drafts envelope + its fetched body → an `openDraft` init (bcc isn't on the envelope). */
export function toDraftInit(email: EmailRow, bodyHtml: string): OpenDraftInit {
  return {
    to: email.to ?? [],
    cc: email.cc ?? [],
    subject: email.subject ?? '',
    body: bodyHtml,
    inReplyTo: email.inReplyTo,
    references: email.references,
  }
}

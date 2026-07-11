/**
 * Pure draft (de)serialization + JMAP mapping (M2.6, FR-CMP-03). Bridges the in-memory composer
 * `DraftWindow` ↔ the persisted `SerializedDraft`/`DraftRow`, decides whether a draft is empty
 * (never persisted/synced), and builds the `Email/set` create body for the Drafts mailbox. No React,
 * no network — fully unit-tested.
 */

import type { EmailAddress, EmailCreate, Id } from '@waxwing/jmap'
import type { DraftRow, EmailRow, SerializedDraft } from '../sync'
import { cleanOutgoingHtml } from './clean-html'
import type { DraftWindow, OpenDraftInit } from './composer-store'
import { htmlToPlainText } from './html-to-text'

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
  }
}

/** A draft worth neither persisting nor syncing: no recipients, blank subject, empty body. */
export function isEmptyDraft(draft: DraftWindow | SerializedDraft): boolean {
  const noRecipients = draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0
  const blankSubject = draft.subject.trim() === ''
  const blankBody = htmlToPlainText(draft.body).trim() === ''
  return noRecipients && blankSubject && blankBody
}

/** The Drafts-mailbox `Email/set` create body (html-only; the text/plain alternative is M2.8). */
export function toEmailCreate(input: {
  draft: SerializedDraft
  draftsMailboxId: Id
  from: EmailAddress | null
}): EmailCreate {
  const { draft } = input
  return {
    mailboxIds: { [input.draftsMailboxId]: true },
    keywords: { $draft: true, $seen: true },
    subject: draft.subject,
    from: input.from !== null ? [input.from] : null,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    bodyValues: {
      html: {
        value: cleanOutgoingHtml(draft.body),
        isEncodingProblem: false,
        isTruncated: false,
      },
    },
  }
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

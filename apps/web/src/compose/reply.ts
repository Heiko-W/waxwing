/**
 * Reply / reply-all / forward derivation (M2.3, FR-CMP-02 / FR-CMP-10). Pure functions that turn a
 * source message into a draft: recipients, a normalized subject (`Re:`/`Fwd:`, no stacking),
 * threading headers (`In-Reply-To`/`References`), the quoted/forwarded HTML body seed, forwarded
 * attachment blob-references, and the best-guess From identity. No React, no network — fully unit
 * tested (`DOMParser` only, via {@link sanitizeQuotedHtml}). The plain-text alternative + `>`-quoting
 * come for free from {@link htmlToPlainText} at send time; here we only emit the HTML
 * `<blockquote>` the editor seeds with.
 *
 * That seed is the one place attacker-controlled mail HTML crosses out of the sandboxed reading
 * frame and into the app document, so every HTML body reaching {@link quoteBody}/{@link forwardBody}
 * goes through {@link sanitizeQuotedHtml} first — read that module for what the reading sanitizer
 * leaves standing and why it is not safe on this side.
 */

import type { EmailAddress, Id } from '@waxwing/jmap'
import type { EmailBodyRow } from '../sync'
import { plainTextToHtml } from './html-to-text'
import { sanitizeQuotedHtml } from './quoted-html'

/**
 * `forwardAsAttachment` differs from `forward` in one way that matters: the original travels whole,
 * as a `message/rfc822` part, instead of being quoted into the body. Headers, signatures and
 * attachments survive intact, which is what a recipient needs when the message itself is the
 * evidence — a bounce to report, a phishing mail to hand to an admin.
 */
export type ReplyKind = 'reply' | 'replyAll' | 'forward' | 'forwardAsAttachment'

/** Whether `kind` is one of the two forward shapes. */
export function isForward(kind: ReplyKind): boolean {
  return kind === 'forward' || kind === 'forwardAsAttachment'
}

/** The message subset the reply/forward logic reads (an `EmailRow` is assignable to this). */
export interface ReplySource {
  readonly id: Id
  readonly from: EmailAddress[] | null
  readonly to: EmailAddress[] | null
  readonly cc: EmailAddress[] | null
  readonly replyTo: EmailAddress[] | null
  readonly subject: string | null
  readonly messageId: string[] | null
  readonly inReplyTo: string[] | null
  readonly references: string[] | null
}

/** A forwarded attachment carried by blob reference (chip UI is M2.7, inclusion at send is M2.8). */
export interface DraftAttachment {
  readonly blobId: string
  readonly name: string | null
  readonly type: string
  readonly size: number
  readonly cid: string | null
}

const lower = (email: string): string => email.toLowerCase()

/** Dedup by lowercased email, keeping the first occurrence but upgrading to a named variant. */
function dedup(list: EmailAddress[]): EmailAddress[] {
  const byEmail = new Map<string, EmailAddress>()
  for (const addr of list) {
    const key = lower(addr.email)
    const existing = byEmail.get(key)
    if (existing === undefined) byEmail.set(key, addr)
    else if ((existing.name === null || existing.name === '') && addr.name) byEmail.set(key, addr)
  }
  return [...byEmail.values()]
}

export function deriveRecipients(
  source: ReplySource,
  kind: ReplyKind,
  ownAddresses: readonly string[],
): { to: EmailAddress[]; cc: EmailAddress[] } {
  if (isForward(kind)) return { to: [], cc: [] }
  const to = dedup([...(source.replyTo ?? source.from ?? [])])
  if (kind === 'reply') return { to, cc: [] }
  // reply-all: cc = original to + cc, minus own addresses and anyone already in the derived `to`.
  const own = new Set(ownAddresses.map(lower))
  const toKeys = new Set(to.map((addr) => lower(addr.email)))
  const cc = dedup([...(source.to ?? []), ...(source.cc ?? [])]).filter(
    (addr) => !own.has(lower(addr.email)) && !toKeys.has(lower(addr.email)),
  )
  return { to, cc }
}

/** Matches a single leading Re:/Fwd:/Fw:/AW:/WG: prefix (optionally counted, e.g. `Re[2]:`). */
const PREFIX_RE = /^\s*(re|aw|fwd|fw|wg)(\[\d+\])?\s*:\s*/i

/** Strip ALL leading reply/forward prefixes (en + de variants) so nothing stacks. */
export function stripSubjectPrefix(subject: string): string {
  let current = subject
  let previous: string
  do {
    previous = current
    current = current.replace(PREFIX_RE, '')
  } while (current !== previous)
  return current.trim()
}

/** Normalize to a single English `Re:`/`Fwd:` prefix (interop default). */
export function replySubject(subject: string | null, kind: ReplyKind): string {
  const base = stripSubjectPrefix(subject ?? '')
  const prefix = isForward(kind) ? 'Fwd:' : 'Re:'
  return base === '' ? prefix : `${prefix} ${base}`
}

export function threadingHeaders(source: ReplySource): {
  inReplyTo: string[] | null
  references: string[] | null
} {
  const inReplyTo = source.messageId
  const refs = [...(source.references ?? source.inReplyTo ?? []), ...(source.messageId ?? [])]
  return {
    inReplyTo: inReplyTo !== null && inReplyTo.length > 0 ? inReplyTo : null,
    references: refs.length > 0 ? refs : null,
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function esc(text: string): string {
  return text.replace(/[&<>]/g, (character) => ESC[character] ?? character)
}

/**
 * The HTML the quote/forward seeds with: the mail's own body through {@link sanitizeQuotedHtml}, or
 * — when there is no HTML part — the plain text, which is escaped by {@link plainTextToHtml} and so
 * cannot carry markup at all. Both branches, and only these two, produce the `inner` of a seed.
 */
function quotedInner(bodyHtml: string | null, textBody: string): string {
  return bodyHtml !== null ? sanitizeQuotedHtml(bodyHtml) : plainTextToHtml(textBody)
}

export function quoteBody(input: {
  readonly bodyHtml: string | null
  readonly textBody: string
  readonly attribution: string
}): string {
  const inner = quotedInner(input.bodyHtml, input.textBody)
  return `<p><br></p><p>${esc(input.attribution)}</p><blockquote>${inner}</blockquote>`
}

export function forwardBody(input: {
  readonly bodyHtml: string | null
  readonly textBody: string
  readonly separator: string
  readonly headerBlock: string
}): string {
  const inner = quotedInner(input.bodyHtml, input.textBody)
  const headerLines = input.headerBlock
    .split('\n')
    .map((line) => `<div>${esc(line)}</div>`)
    .join('')
  return `<p><br></p><div>${esc(input.separator)}</div>${headerLines}<br>${inner}`
}

/** The own address the source was addressed to (to∪cc), else the first own address, else undefined. */
export function inferFromIdentity(
  source: ReplySource,
  ownAddresses: readonly string[],
): string | undefined {
  const own = new Set(ownAddresses.map(lower))
  for (const addr of [...(source.to ?? []), ...(source.cc ?? [])]) {
    if (own.has(lower(addr.email))) return lower(addr.email)
  }
  return ownAddresses[0]
}

/** Lowercased, de-duped personal-account emails from the JMAP session (M2.5 → `Identity/get`). */
export function ownAddresses(
  session: { accounts: Record<string, { name: string; isPersonal: boolean }>; username: string },
  accountId: string,
): string[] {
  const out = new Set<string>()
  const primary = session.accounts[accountId]
  if (primary?.isPersonal && primary.name) out.add(lower(primary.name))
  for (const account of Object.values(session.accounts)) {
    if (account.isPersonal && account.name) out.add(lower(account.name))
  }
  if (session.username) out.add(lower(session.username))
  return [...out]
}

export function forwardAttachments(body: Pick<EmailBodyRow, 'attachments'>): DraftAttachment[] {
  const out: DraftAttachment[] = []
  for (const part of body.attachments) {
    if (part.blobId !== null) {
      out.push({
        blobId: part.blobId,
        name: part.name,
        type: part.type,
        size: part.size,
        cid: part.cid,
      })
    }
  }
  return out
}

/**
 * The whole message as one `message/rfc822` attachment (M5.3, FR-CMP-14).
 *
 * Built from the envelope alone — an Email's own `blobId` addresses the entire RFC 5322 message
 * (RFC 8621 §4.1.1), so nothing is downloaded here and nothing is re-uploaded. The draft carries a
 * reference to a blob the server already holds.
 *
 * The filename is derived from the subject rather than sent raw: it becomes a file on the
 * recipient's disk, and the subject is the original sender's string.
 */
export function messageAsAttachment(
  source: Pick<ReplySource, 'subject'> & { readonly blobId: string; readonly size: number },
  filename: string,
): DraftAttachment {
  return {
    blobId: source.blobId,
    name: filename,
    type: 'message/rfc822',
    size: source.size,
    // Not inline: this is a file the recipient opens, not an image the body refers to.
    cid: null,
  }
}

export interface ReplyDraftInit {
  readonly to: EmailAddress[]
  readonly cc: EmailAddress[]
  readonly subject: string
  readonly body: string
  readonly inReplyTo: string[] | null
  readonly references: string[] | null
  readonly fromIdentityHint: string | undefined
  /** The source message id + kind — carried so a successful send flags it $answered/$forwarded (M2.8). */
  readonly sourceEmailId: Id
  readonly sourceKind: ReplyKind
}

/** Single entry point: build the full draft init for a reply/reply-all/forward of `source`. */
export function buildReplyDraft(input: {
  readonly kind: ReplyKind
  readonly source: ReplySource
  readonly bodyHtml: string | null
  readonly textBody: string
  readonly ownAddresses: readonly string[]
  readonly attribution: string
  readonly forwardSeparator: string
  readonly forwardHeaderBlock: string
}): ReplyDraftInit {
  const { kind, source } = input
  const { to, cc } = deriveRecipients(source, kind, input.ownAddresses)
  const body =
    kind === 'forwardAsAttachment'
      ? // Empty: the message travels as an attachment, so quoting it into the body as well would
        // send it twice. The composer adds the sender's signature on top of this.
        ''
      : kind === 'forward'
        ? forwardBody({
            bodyHtml: input.bodyHtml,
            textBody: input.textBody,
            separator: input.forwardSeparator,
            headerBlock: input.forwardHeaderBlock,
          })
        : quoteBody({
            bodyHtml: input.bodyHtml,
            textBody: input.textBody,
            attribution: input.attribution,
          })
  // A forward starts a NEW thread; reply/reply-all thread to the source.
  const { inReplyTo, references } = isForward(kind)
    ? { inReplyTo: null, references: null }
    : threadingHeaders(source)
  return {
    to,
    cc,
    subject: replySubject(source.subject, kind),
    body,
    inReplyTo,
    references,
    fromIdentityHint: inferFromIdentity(source, input.ownAddresses),
    sourceEmailId: source.id,
    sourceKind: kind,
  }
}

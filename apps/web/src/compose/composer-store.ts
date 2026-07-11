/**
 * The composer store (M2.2, FR-CMP-09). A single module-scoped Zustand store is the source of
 * truth for every open draft — because it lives at module scope (not in a React subtree), the
 * drafts survive route changes and host remounts. UI-state only: docked/expanded/minimized mode,
 * the in-progress body HTML and subject, and which draft has focus.
 *
 * PERSISTENCE IS OUT OF SCOPE HERE. M2.2 keeps drafts in memory only (a reload loses them); M2.6
 * adds crash-safe local + server "Drafts"-mailbox autosave and plugs into this same shape, at
 * which point closing a draft saves it to Drafts (findable in the folder tree) rather than the
 * discard-confirm stub used now.
 */

import type { EmailAddress } from '@waxwing/jmap'
import { create } from 'zustand'
import type { DraftAttachment } from './reply'

export type DraftMode = 'docked' | 'expanded' | 'minimized'

/** The three recipient fields (M2.4). */
export type RecipientField = 'to' | 'cc' | 'bcc'

export interface DraftWindow {
  readonly id: string
  mode: DraftMode
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  /** Message HTML — fed to RichTextEditor's `value`, updated from its `onChange`. */
  body: string
  /** Threading headers seeded from a reply/reply-all source (M2.3); null for a new/forward draft. */
  inReplyTo: string[] | null
  references: string[] | null
  /** Best-guess From identity email (M2.3 hook; resolved to an id in M2.5). */
  fromIdentityHint: string | undefined
  /** Selected From identity id (M2.5); the M2.8 submission resolves from/replyTo/bcc from it. */
  fromIdentityId: string | undefined
  /** Forwarded attachments carried by blob reference (chip UI M2.7, inclusion at send M2.8). */
  attachments: DraftAttachment[]
  /** True once the reader edited body/subject — drives the close-guard stub. */
  dirty: boolean
  readonly createdAt: number
}

/** How many drafts show as full windows at once; opening more collapses the oldest to a chip. */
export const MAX_OPEN = 3

export interface OpenDraftInit {
  readonly subject?: string
  readonly body?: string
  readonly mode?: DraftMode
  readonly to?: EmailAddress[]
  readonly cc?: EmailAddress[]
  readonly bcc?: EmailAddress[]
  readonly inReplyTo?: string[] | null
  readonly references?: string[] | null
  readonly fromIdentityHint?: string | undefined
  readonly fromIdentityId?: string | undefined
  readonly attachments?: DraftAttachment[]
}

export interface ComposerState {
  /** Insertion-ordered (creation order); the docked row lays out in this order. */
  readonly drafts: ReadonlyMap<string, DraftWindow>
  /** Draft with managed focus / on top; a required key whose value may be `undefined`. */
  readonly focusedId: string | undefined
}

export interface ComposerActions {
  /** Open a new draft; returns its id and focuses it. Enforces {@link MAX_OPEN}. */
  openDraft(init?: OpenDraftInit): string
  closeDraft(id: string): void
  setMode(id: string, mode: DraftMode): void
  updateBody(id: string, body: string): void
  updateSubject(id: string, subject: string): void
  /** Replace a whole recipient field (the pill field adds/removes by passing the new array). */
  setRecipients(id: string, field: RecipientField, addrs: EmailAddress[]): void
  /** Move one recipient from one field to another (keyboard "move to Cc/Bcc"), deduping in target. */
  moveRecipient(id: string, from: RecipientField, to: RecipientField, index: number): void
  /** Set the From identity + the signature-swapped body (M2.5; caller computes body via signature.ts). */
  setFromIdentity(
    id: string,
    identityId: string,
    body: string,
    options?: { readonly markDirty?: boolean },
  ): void
  focusDraft(id: string): void
}

export type ComposerStore = ComposerState & ComposerActions

const isOpen = (draft: DraftWindow): boolean => draft.mode !== 'minimized'

export const useComposerStore = create<ComposerStore>()((set, get) => ({
  drafts: new Map<string, DraftWindow>(),
  focusedId: undefined,

  openDraft(init) {
    const id = crypto.randomUUID()
    const next = new Map(get().drafts)
    // Keep at most MAX_OPEN full windows — collapse the OLDEST open one to a minimized chip
    // (never dropped: it stays in the store and in the Drafts folder once M2.6 lands).
    const open = [...next.values()].filter(isOpen)
    if (open.length >= MAX_OPEN) {
      const oldest = open[0]
      if (oldest) next.set(oldest.id, { ...oldest, mode: 'minimized' })
    }
    next.set(id, {
      id,
      mode: init?.mode ?? 'docked',
      to: init?.to ?? [],
      cc: init?.cc ?? [],
      bcc: init?.bcc ?? [],
      subject: init?.subject ?? '',
      body: init?.body ?? '',
      inReplyTo: init?.inReplyTo ?? null,
      references: init?.references ?? null,
      fromIdentityHint: init?.fromIdentityHint,
      fromIdentityId: init?.fromIdentityId,
      attachments: init?.attachments ?? [],
      dirty: false,
      createdAt: Date.now(),
    })
    set({ drafts: next, focusedId: id })
    return id
  },

  closeDraft(id) {
    const next = new Map(get().drafts)
    if (!next.delete(id)) return
    const remaining = [...next.keys()]
    const focusedId = get().focusedId === id ? remaining[remaining.length - 1] : get().focusedId
    set({ drafts: next, focusedId })
  },

  setMode(id, mode) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, mode })
    set({ drafts: next, focusedId: id })
  },

  updateBody(id, body) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, body, dirty: true })
    set({ drafts: next })
  },

  updateSubject(id, subject) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, subject, dirty: true })
    set({ drafts: next })
  },

  setRecipients(id, field, addrs) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, [field]: addrs, dirty: true })
    set({ drafts: next })
  },

  moveRecipient(id, from, to, index) {
    const current = get().drafts.get(id)
    if (current === undefined || from === to) return
    const fromList = [...current[from]]
    const moved = fromList[index]
    if (moved === undefined) return
    fromList.splice(index, 1)
    const toList = [...current[to]]
    if (!toList.some((addr) => addr.email.toLowerCase() === moved.email.toLowerCase())) {
      toList.push(moved)
    }
    const next = new Map(get().drafts)
    next.set(id, { ...current, [from]: fromList, [to]: toList, dirty: true })
    set({ drafts: next })
  },

  setFromIdentity(id, identityId, body, options) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    // Seeding the default identity passes markDirty:false so it never trips the close-guard;
    // a user-initiated From change uses the default (true).
    next.set(id, {
      ...current,
      fromIdentityId: identityId,
      body,
      dirty: current.dirty || (options?.markDirty ?? true),
    })
    set({ drafts: next })
  },

  focusDraft(id) {
    if (get().drafts.has(id)) set({ focusedId: id })
  },
}))

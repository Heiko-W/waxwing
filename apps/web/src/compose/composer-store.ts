/**
 * The composer store (M2.2, FR-CMP-09). A single module-scoped Zustand store is the source of
 * truth for every open draft — because it lives at module scope (not in a React subtree), the
 * drafts survive route changes and host remounts. UI-state only: docked/expanded/minimized mode,
 * the in-progress body HTML and subject, and which draft has focus.
 *
 * PERSISTENCE LIVES ELSEWHERE. This store stays UI-only; M2.6 bolts crash-safe local + server
 * "Drafts"-mailbox autosave on TOP of this shape via `use-draft-autosave`/`use-draft-sync` (keyed by
 * `id`), so closing a draft saves it to Drafts (findable in the folder tree). `openDraft` accepts a
 * fixed `id` so a restore / open-from-Drafts reopens the SAME draft idempotently.
 */

import type { EmailAddress } from '@waxwing/jmap'
import { create } from 'zustand'
import type { UploadItem } from './attachment-upload'
import type { DraftAttachment } from './reply'
import { DEFAULT_SEND_OPTIONS, type SendOptions } from './send-options'

export type DraftMode = 'docked' | 'expanded' | 'minimized'

/** The three recipient fields (M2.4). Exactly the fields a pill may be MOVED between. */
export type RecipientField = 'to' | 'cc' | 'bcc'

/**
 * Every address field the composer renders, including Reply-To (M-11).
 *
 * Deliberately a superset of {@link RecipientField} rather than an extension of it. Reply-To is an
 * address the composer edits with the same pill widget, but it is NOT a recipient: it never reaches
 * `rcptTo`, and offering "move to Reply-To" in a pill's menu — which extending `RecipientField`
 * would have done for free — would put an address into a header that does not deliver anywhere.
 */
export type AddressField = RecipientField | 'replyTo'

/** The keyword set on the reply/forward SOURCE message once THIS draft is sent (M2.8, FR-CMP-07). */
export type SourceFlag = '$answered' | '$forwarded'

export interface DraftWindow {
  readonly id: string
  mode: DraftMode
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  /**
   * Where replies should go instead of the From address (M-11) — the `Reply-To` header.
   *
   * Per DRAFT, and it wins over the selected identity's own `replyTo` when set: an identity-wide
   * setting answers "always", this answers "this once", and the more specific of two answers to the
   * same question is the one the writer just gave.
   */
  replyTo: EmailAddress[]
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
  /** The reply/forward source message id (M2.8) — flagged $answered/$forwarded on a successful send. */
  sourceEmailId: string | undefined
  sourceFlag: SourceFlag | undefined
  /** Priority + delivery receipt + TLS-only, for THIS send (M-7/M-11). */
  sendOptions: SendOptions
  /** True once the reader edited body/subject — drives the close-guard stub. */
  dirty: boolean
  readonly createdAt: number
}

/** How many drafts show as full windows at once; opening more collapses the oldest to a chip. */
export const MAX_OPEN = 3

export interface OpenDraftInit {
  /** Reopen under a fixed id (crash-restore / open-from-Drafts) — otherwise a fresh uuid is minted. */
  readonly id?: string
  readonly subject?: string
  readonly body?: string
  readonly mode?: DraftMode
  readonly to?: EmailAddress[]
  readonly cc?: EmailAddress[]
  readonly bcc?: EmailAddress[]
  readonly replyTo?: EmailAddress[]
  readonly inReplyTo?: string[] | null
  readonly references?: string[] | null
  readonly fromIdentityHint?: string | undefined
  readonly fromIdentityId?: string | undefined
  readonly attachments?: DraftAttachment[]
  readonly sourceEmailId?: string | undefined
  readonly sourceFlag?: SourceFlag | undefined
  readonly sendOptions?: SendOptions
}

export interface ComposerState {
  /** Insertion-ordered (creation order); the docked row lays out in this order. */
  readonly drafts: ReadonlyMap<string, DraftWindow>
  /** Draft with managed focus / on top; a required key whose value may be `undefined`. */
  readonly focusedId: string | undefined
  /** draftId → in-flight/errored uploads (M2.7). View state ONLY — never serialized. */
  readonly uploads: ReadonlyMap<string, readonly UploadItem[]>
}

export interface ComposerActions {
  /** Open a new draft; returns its id and focuses it. Enforces {@link MAX_OPEN}. */
  openDraft(init?: OpenDraftInit): string
  closeDraft(id: string): void
  setMode(id: string, mode: DraftMode): void
  updateBody(id: string, body: string): void
  updateSubject(id: string, subject: string): void
  /** Replace a whole address field (the pill field adds/removes by passing the new array). */
  setRecipients(id: string, field: AddressField, addrs: EmailAddress[]): void
  /** Replace this draft's send options (M-7/M-11); marks the draft dirty. */
  setSendOptions(id: string, options: SendOptions): void
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
  /** Append fully-uploaded attachments (M2.7), deduped by blobId+cid; marks the draft dirty. */
  addAttachments(id: string, attachments: DraftAttachment[]): void
  /** Remove an uploaded attachment by blobId; marks dirty. Body `<img>` stripping is the caller's job. */
  removeAttachment(id: string, blobId: string): void
  /** Register a new in-flight upload chip (M2.7). */
  addUpload(id: string, item: UploadItem): void
  /** Patch one in-flight upload (progress / status / error). */
  patchUpload(id: string, tempId: string, patch: Partial<UploadItem>): void
  /** Drop an in-flight/errored upload (cancel, retry-done, or completed → moved to attachments). */
  removeUpload(id: string, tempId: string): void
}

export type ComposerStore = ComposerState & ComposerActions

const isOpen = (draft: DraftWindow): boolean => draft.mode !== 'minimized'

export const useComposerStore = create<ComposerStore>()((set, get) => ({
  drafts: new Map<string, DraftWindow>(),
  focusedId: undefined,
  uploads: new Map<string, readonly UploadItem[]>(),

  openDraft(init) {
    const id = init?.id ?? crypto.randomUUID()
    // Idempotent reopen: a restore / open-from-Drafts of an already-open draft just focuses it.
    if (get().drafts.has(id)) {
      set({ focusedId: id })
      return id
    }
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
      replyTo: init?.replyTo ?? [],
      subject: init?.subject ?? '',
      body: init?.body ?? '',
      inReplyTo: init?.inReplyTo ?? null,
      references: init?.references ?? null,
      fromIdentityHint: init?.fromIdentityHint,
      fromIdentityId: init?.fromIdentityId,
      attachments: init?.attachments ?? [],
      sourceEmailId: init?.sourceEmailId,
      sourceFlag: init?.sourceFlag,
      sendOptions: init?.sendOptions ?? DEFAULT_SEND_OPTIONS,
      dirty: false,
      createdAt: Date.now(),
    })
    set({ drafts: next, focusedId: id })
    return id
  },

  closeDraft(id) {
    const next = new Map(get().drafts)
    if (!next.delete(id)) return
    const uploads = new Map(get().uploads)
    uploads.delete(id) // drop the view state; the upload hook's unmount cleanup aborts the transfers
    const remaining = [...next.keys()]
    const focusedId = get().focusedId === id ? remaining[remaining.length - 1] : get().focusedId
    set({ drafts: next, focusedId, uploads })
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

  setSendOptions(id, options) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, sendOptions: options, dirty: true })
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

  addAttachments(id, attachments) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    // Content-addressed blobIds mean identical files share an id; dedupe by blobId+cid so
    // removeAttachment(blobId) stays unambiguous and re-uploads don't double the chip.
    const fresh = attachments.filter(
      (a) => !current.attachments.some((e) => e.blobId === a.blobId && e.cid === a.cid),
    )
    if (fresh.length === 0) return
    const next = new Map(get().drafts)
    next.set(id, { ...current, attachments: [...current.attachments, ...fresh], dirty: true })
    set({ drafts: next })
  },

  removeAttachment(id, blobId) {
    const current = get().drafts.get(id)
    if (current === undefined) return
    const index = current.attachments.findIndex((a) => a.blobId === blobId)
    if (index === -1) return
    const attachments = current.attachments.filter((_, i) => i !== index)
    const next = new Map(get().drafts)
    next.set(id, { ...current, attachments, dirty: true })
    set({ drafts: next })
  },

  addUpload(id, item) {
    const next = new Map(get().uploads)
    next.set(id, [...(next.get(id) ?? []), item])
    set({ uploads: next })
  },

  patchUpload(id, tempId, patch) {
    const list = get().uploads.get(id)
    if (list === undefined) return
    const next = new Map(get().uploads)
    next.set(
      id,
      list.map((u) => (u.tempId === tempId ? { ...u, ...patch } : u)),
    )
    set({ uploads: next })
  },

  removeUpload(id, tempId) {
    const list = get().uploads.get(id)
    if (list === undefined) return
    const filtered = list.filter((u) => u.tempId !== tempId)
    const next = new Map(get().uploads)
    if (filtered.length === 0) next.delete(id)
    else next.set(id, filtered)
    set({ uploads: next })
  },
}))

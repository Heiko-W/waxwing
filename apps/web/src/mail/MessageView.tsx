/**
 * One fully-rendered message (M1.8): header (sender, recipients, date, an expandable details
 * disclosure — FR-RD-06), the remote-content banner (FR-RD-04), the sanitized body in the sandboxed
 * frame (FR-RD-01), attachments (FR-RD-05), and an action bar (archive/junk/trash/move/flag/mark
 * unread via the outbox; reply/reply-all/forward seed a composer draft — M2.3, FR-CMP-02). Bodies are
 * fetched on open and the message is auto-marked read after a short dwell unless disabled or already
 * read (FR-RD-07). Remote content is allowed when the deployment default is `allow`, the sender is on
 * the local allowlist, or the reader clicks "Load images".
 *
 * M3.9 rounds the details disclosure out to the full set a reader ever needs to judge a message —
 * Reply-To, Bcc, Sender, the sent/received divergence, the Message-ID and the authentication report
 * (reported, never judged: `auth-results.ts` explains why) — and adds the raw .eml behind the
 * overflow menu, lazily.
 */

import { renderPlainText, sanitize } from '@waxwing/mail-html'
import {
  AlertTriangle,
  Archive,
  Ban,
  ChevronDown,
  ChevronUp,
  FolderInput,
  Forward,
  MailMinus,
  MoreHorizontal,
  Reply,
  ReplyAll,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../app/session/context'
import {
  buildReplyDraft,
  forwardAttachments,
  ownAddresses,
  type ReplyKind,
  useComposerStore,
} from '../compose'
import { formatDate } from '../i18n/formatters'
import { type EmailRow, setPref, useMailboxByRole, useReplica } from '../sync'
import {
  Avatar,
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuItemSpec,
  Spinner,
  useToolbarRoving,
} from '../ui'
import { AttachmentList } from './AttachmentList'
import { topmostAuthResults } from './auth-results'
import { LabelMenu } from './labels/LabelMenu'
import { MailBodyFrame } from './MailBodyFrame'
import { MoveDialog } from './MoveDialog'
import {
  formatAddressList,
  nameLooksLikeAddress,
  sameAddresses,
  senderAddress,
  senderName,
} from './message-body'
import { RemoteContentBanner } from './RemoteContentBanner'
import styles from './reading.module.css'
import {
  READING_PREF_KEYS,
  useAutoMarkRead,
  useRemoteAllowList,
  useRemoteContentDefault,
} from './reading-prefs'
import { type ReadingHandlers, useReadingStore } from './reading-store'
import { SenderCard } from './SenderCard'
import type { SenderIdentity } from './sender-contact'
import { useLinkOpener } from './use-link-opener'
import { useMessageActions } from './use-message-actions'
import { useMessageRights } from './use-message-rights'
import { useTriage } from './use-triage'
import { useInlineImages } from './useInlineImages'
import { useMessageBody } from './useMessageBody'

/** How long an opened message must stay open before it is auto-marked read (FR-RD-07). */
export const AUTO_MARK_READ_DELAY_MS = 1500

/**
 * How far `sentAt` must sit from `receivedAt` before the details list shows BOTH. Every message
 * differs by a second or two, and a "Sent" row that always restates "Date" is pure noise; a genuine
 * gap (a queued/backdated/delayed message) is worth seeing.
 */
const SENT_AT_DIVERGENCE_MS = 5 * 60 * 1000

/** The raw-source dialog is a route nobody takes twice a day — code-split it (NFR-PERF-03). */
const MessageSourceDialog = lazy(() => import('./MessageSourceDialog'))
/** Likewise the link interstitial: most readers never meet a link that lies (M3.9, FR-RD-08). */
const LinkWarningDialog = lazy(() => import('./LinkWarningDialog'))

export interface MessageViewProps {
  readonly email: EmailRow
  /** The mailbox the message is being read in (source for a move); undefined = unknown. */
  readonly mailboxId: string | undefined
  /**
   * Whether this message may auto-mark itself read on dwell (FR-RD-07). Defaults to `true`; a
   * conversation passes `false` for every message except the one the reader actually opened, so
   * an auto-expanded sibling (the thread's newest) is not silently marked read.
   */
  readonly autoMark?: boolean
  /** When set, render a collapse control (this message is an expandable thread member). */
  readonly onCollapse?: (() => void) | undefined
}

export function MessageView({ email, mailboxId, autoMark = true, onCollapse }: MessageViewProps) {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const actions = useMessageActions()
  // Moves go through the shared triage seam (M3.8): same dispatch, plus the undo toast — and it is the
  // very seam the `e` / `#` / `!` chords call, so a click and a keystroke cannot drift apart.
  const triage = useTriage()
  // B34. The subject is this one message, so the verdict is exact rather than the account floor.
  const rightsIds = useMemo(() => [email.id], [email.id])
  const rights = useMessageRights(rightsIds)
  const seenDenied = rights.reason('seen') !== null
  /** A refusal key from {@link rights} as the finished sentence a control announces; `undefined` = allowed. */
  const reasonText = (key: string | null): string | undefined => (key === null ? undefined : t(key))
  const openDraft = useComposerStore((state) => state.openDraft)
  const { connected } = useSession()
  const own = useMemo(
    () => (connected ? ownAddresses(connected.jmapSession, accountId) : []),
    [connected, accountId],
  )
  const { body, htmlParts, textBody, loading } = useMessageBody(email.id)
  const { resolveCid, ready } = useInlineImages(accountId, body)

  const archiveBox = useMailboxByRole('archive')
  const junkBox = useMailboxByRole('junk')
  const trashBox = useMailboxByRole('trash')
  const inThisMailbox = mailboxId ?? null

  const [detailsOpen, setDetailsOpen] = useState(false)
  /** Which overflow action opened the raw-source dialog; `null` = closed (and never mounted). */
  const [sourceOpen, setSourceOpen] = useState<'view' | 'save' | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  /**
   * The label picker — ONE open state and ONE anchor for both the `l` chord and the Label button,
   * the same "a keystroke and a click are one code path" rule the rest of this action bar follows.
   *
   * It used to be two: `LabelMenuButton` owned the mouse path, while `l` opened a second
   * `LabelMenu` anchored to the `role="toolbar"` div below. That div has no `tabIndex`, so
   * `LabelMenu`'s close path — `anchorRef.current?.focus()` — was a silent no-op and Escape or Tab
   * dropped the keyboard reader onto `<body>`, outside the pane they were reading in. Anchoring to
   * the button a mouse user would have clicked is both a focusable element and where the rest of the
   * app returns focus; it also positions the popover under the Label button rather than the toolbar's
   * left edge, and lets `aria-expanded` tell the truth when the chord opened it.
   */
  const [labelsOpen, setLabelsOpen] = useState(false)
  const labelButtonRef = useRef<HTMLButtonElement>(null)
  const { ref: actionBarRef, containerProps: actionBarKeys } = useToolbarRoving<HTMLDivElement>()
  /** The sender hover-card (FR-CON-05), anchored to the sender avatar in the header. */
  const [senderCardOpen, setSenderCardOpen] = useState(false)
  const senderButtonRef = useRef<HTMLButtonElement>(null)

  // Remote content: deployment default, sender allowlist, or an explicit "Load images" this session.
  const remoteAllow = useRemoteAllowList()
  const fromAddress = senderAddress(email.from)
  const trustedSender = fromAddress !== null && remoteAllow.includes(fromAddress)
  const allowRemote = useRemoteContentDefault() === 'allow' || trustedSender || loadedOnce

  // Auto-mark-read after a dwell (FR-RD-07), unless disabled, already read, or this is a sibling
  // message the reader did not open (a conversation passes autoMark=false for those).
  const autoMarkRead = useAutoMarkRead()
  /**
   * The LIVE `$seen` — read when the dwell FIRES rather than when it was armed — together with the
   * message id that value belonged to. The arming effect below deliberately does not re-run on
   * `$seen`, so without the `seen` half a message read by other means mid-dwell (another client, the
   * list) would still get a redundant keyword intent pushed at it. It is written by the transition
   * effect that follows the arming effect, not here.
   *
   * The `id` half is what makes the transition effect's edge test mean anything. A bare boolean
   * cannot tell "someone marked THIS message unread" from "the reader navigated from a read message
   * to an unread one" — both arrive here as `$seen` true → false — and reading the second as the
   * first is precisely the regression the wave-4 cancel shipped: opening an unread message straight
   * after a read one armed a dwell and then cancelled it in the same commit, so FR-RD-07 did not fire
   * at all. Only the transition effect writes this pair, and it writes both halves together, so the
   * `seen` here is always the one observed for the `id` here.
   *
   * The fire path reads `seen` without re-checking `id`, and may: `email.id` is a dependency of the
   * arming effect, so any change of message runs that effect's cleanup and clears the timer. A
   * PENDING dwell therefore always belongs to the currently rendered message, which is the same
   * message this ref was last written for.
   */
  const seenNow = useRef<{ id: string; seen: boolean }>({
    id: email.id,
    seen: email.keywords.$seen === true,
  })
  /**
   * The armed dwell, held so a mark-unread can CANCEL it.
   *
   * Keeping `$seen` out of the arming effect stops the dwell from RE-arming after it has fired, but
   * a timer that is still pending when the reader acts is a second, narrower instance of the same
   * bug: open → glance → "mark as unread" → the dwell goes off 1.5 s after the open and marks read
   * the message they just said to keep unread. That is the exact window a fast reader works in.
   *
   * TWO cancels, on two different signals, because the intent reaches this component two ways:
   *
   * - `markUnread` below cancels on the ACTION. It is the single closure every mark-unread issued
   *   THROUGH this pane goes through, so no reading-pane entry point can be added that quietly
   *   loses the cancel — and it fires even when the message is already unread and no row moves.
   * - the effect declared after the arming effect cancels on a `$seen` true → false TRANSITION ON
   *   ONE AND THE SAME MESSAGE, whoever caused it: this pane, the message list's bulk read/unread
   *   toggle or its read swipe
   *   (in `MessageList.tsx` — `BulkBar`'s read button and `commitSwipe`'s `read` branch; cited by
   *   symbol, because line numbers in a neighbouring file drift), or another client's sync. None of
   *   those call into this component; they reach it ONLY as a new `email` row, so the row is where
   *   their intent is legible here. Watching the transition rather than the level is what keeps it
   *   clear of the original loop — the arming effect's deps stay untouched. The "same message" part
   *   is not a refinement but load-bearing: a change of MESSAGE from a read one to an unread one
   *   produces the identical true → false edge with nobody having marked anything, and cancelling on
   *   it broke auto-mark-read outright for that sequence.
   *
   * WHAT THIS PAIR DOES NOT COVER, so it is not read as complete: a mark-unread issued from OUTSIDE
   * this pane against a message that is ALREADY unread. It produces no `$seen` transition and never
   * reaches `markUnread`, so an armed dwell survives it and fires ~1.5 s after the open, against the
   * reader's stated intent. Do not assume the list's controls cannot issue such a thing because they
   * are toggles: `BulkBar`'s `allSeen` is derived from `useEmailWindow(ids)`, a Dexie `useLiveQuery`
   * that keeps returning its LAST RESOLVED value while a query for a changed `ids` is in flight, and
   * the only freshness guard there is `selectedRows.length === ids.length` — which a stale result of
   * equal cardinality satisfies. That timing is not exercised by any test in this repo and no claim
   * is made either way; it is treated as reachable. Closing this needs the cancel to hang off the
   * dispatched intent, in the triage seam, where the target ids are known regardless of any row.
   *
   * The list-scoped `u` chord is not part of any of the above — it cannot fire while this component
   * is mounted at all; the scope proof is on the arming effect below.
   */
  const dwellTimer = useRef<number | null>(null)
  const cancelDwell = useCallback(() => {
    // Belt-and-braces, deliberately kept: `clearTimeout` on an already-fired or already-cleared id
    // is a no-op, so this early return changes no behaviour the suite can see. It is here so that
    // `dwellTimer.current === null` keeps meaning "nothing pending" at every read of the ref.
    if (dwellTimer.current === null) return
    window.clearTimeout(dwellTimer.current)
    dwellTimer.current = null
  }, [])
  /**
   * `email.keywords.$seen` is NOT a dependency, and that omission is the whole fix. FR-RD-07 is
   * "the reader dwelled on a message they OPENED" — a property of the opening, not of the current
   * keyword. With `$seen` in the deps, a "mark as unread" flipped it true → false, re-ran this
   * effect, cleared its own guard and re-armed the timer — so the message silently marked itself
   * read again 1.5 s later, undoing the one control the reader has for keeping it unread.
   *
   * "A mark as unread" means, precisely: this pane's own action bar button, the message list's
   * pointer controls (see the scope note above), or another client's sync. NOT a keyboard chord in
   * this pane — there is no chord that can mark the open message unread. `registry.ts` gives
   * `triage.unread` (`u`) `scopes: ['list']`, `use-shortcut-context.ts` computes `scope = 'reading'`
   * whenever `route.params.emailId` is defined, and `MailScreen.tsx` mounts `<Conversation>` — the
   * only non-demo parent of this component — only when `emailId !== undefined`. So for the whole
   * lifetime of any `MessageView` the scope is `reading`, where `u` is bound to `nav.back`. Nor is
   * the ⌘K palette a way around that: `usePaletteItems` filters on `isRunnable`, which is scope AND
   * enabled — the same gate the key dispatcher applies. And the `triage.unread` entry is the only
   * one in `registry.ts` that touches `$seen` at all, so there is no second chord to check.
   *
   * Keying on `email.id` instead means: arm once per opened message, using the `$seen` of the render
   * that opened it. Navigating A → B → A re-arms on the second open of A, which is right — that is a
   * new opening. A ref-based "armed once" latch would be wrong here: every effect re-run runs the
   * cleanup, so any later re-run (StrictMode's dev double-invoke, a pref flip) would cancel the
   * timer and then refuse to re-arm it, and the feature would just stop.
   *
   * That re-arm is a property of THIS effect alone, and it was not the whole story until the
   * navigation fix below. An earlier version of this comment said A → B → A "re-arms on the second
   * open, which is right" full stop, and that was false whenever the message left behind was `$seen`:
   * this effect armed and the transition-cancel effect, running later in the same commit, saw the
   * `$seen` true → false that the CHANGE OF MESSAGE had produced and cancelled the arm. What makes
   * the sentence true now is that the cancel is scoped to a transition on one and the same message —
   * see `seenNow` and the effect below.
   *
   * WARNING for whoever edits this list next, established by mutation and not by reasoning: since
   * the transition-cancel effect below exists, putting `$seen` BACK into these deps no longer turns
   * the suite red. The re-armed timer is cancelled by that effect on the same true → false edge that
   * re-armed it, so the two are redundant for this timeline and only a COMPOSITE mutation (both
   * changed at once) fails — it does, on "does NOT re-mark a message the reader marked unread after
   * the dwell already fired". Green after removing this `biome-ignore` is therefore not evidence
   * that removing it is safe; it means the other mechanism absorbed it. Leave the deps as they are.
   *
   * Re-run after the navigation fix, and it still reads the same way: `$seen` added back here alone
   * is 45/45 GREEN; the composite (added back AND the transition cancel deleted) is 3 red, the named
   * test among them, plus "never arms for a message that was already read when it was opened" and
   * "cancels an armed dwell on a read-then-unread issued from OUTSIDE this pane".
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `$seen` is read at arm time on purpose — see above.
  useEffect(() => {
    if (!autoMark || !autoMarkRead || email.keywords.$seen === true) return
    // B34, and the highest-priority half of it: this is the ONE write the user never asked for, so
    // a refusal here has nothing to explain and nobody to explain it to — silence is the correct
    // behaviour, not a toast. Reading a message in a mailbox you may not mark read must simply
    // leave it unread. A pending → denied transition re-runs this effect and cancels the timer.
    if (seenDenied) return
    const timer = window.setTimeout(() => {
      dwellTimer.current = null
      if (!seenNow.current.seen) actions.setSeen([email.id], true)
    }, AUTO_MARK_READ_DELAY_MS)
    dwellTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      // Belt-and-braces, like the two lines above and the early return in `cancelDwell`: never
      // another arm's id, because React runs an effect's cleanup before the next run of that same
      // effect (StrictMode's mount → cleanup → mount included), so the only values this can hold
      // are `timer` itself or the `null` the fire/cancel paths already left. Deleting it changes
      // nothing the suite can see; it is kept so the ref's stated meaning holds on every path.
      dwellTimer.current = null
    }
    // The VERDICT is a dependency (unlike `$seen` above, and for the opposite reason): it is
    // optimistic until the mailboxes load, so a denial arrives after this effect first runs, and
    // without the dep the guard would only ever see "allowed". A re-run is safe — the cleanup
    // cancels the pending timer and re-arms from the same opening.
    //
    // The BOOLEAN, never the `rights` object: that object is rebuilt whenever its liveQuery emits,
    // so depending on it re-arms the timer on every emission and the dwell never reaches 1.5 s.
  }, [autoMark, autoMarkRead, email.id, actions, seenDenied])
  /**
   * The `$seen` watcher: it carries the live value forward for the fire path (`seenNow` above) and,
   * on a true → false EDGE **on one and the same message**, cancels an armed dwell whatever issued
   * the unread — see the two-cancels note on `dwellTimer` for what that does and does not reach.
   *
   * `previous.id === email.id` is the whole of the navigation fix and is NOT decoration. `$seen`
   * true → false is two different events wearing one shape:
   *
   * - SAME message — someone marked the open message unread (this pane, the list, another client).
   *   An armed dwell must die; that is what this effect is for.
   * - DIFFERENT message — the reader closed a read message and opened an unread one. Nobody marked
   *   anything. The arming effect has just armed a legitimate dwell for the NEW message earlier in
   *   this very commit (`email.id` is one of its deps), and cancelling here killed it. Open a read
   *   message, then an unread one, and the unread one was never auto-marked read.
   *
   * Declaration ORDER cannot separate those two — both are one commit, both run both effects — which
   * is why the fix is identity and not a reshuffle. Order still matters for the narrow case it was
   * introduced for and the effect stays declared AFTER the arming effect for it: when a same-message
   * true → false lands in the same commit as a re-run of the arming effect (`autoMark`,
   * `autoMarkRead` or `actions` changing alongside it — a pref flip is the realistic one), effects
   * run in declaration order, the cancel runs last and wins, and the message stays unread. The other
   * order would let the arming effect re-arm over an explicit mark-unread, the shape of the original
   * bug. Moving this above the arming effect would ALSO happen to hide the navigation bug — the
   * cancel would run before the new arm existed — which is exactly why that is not the fix: it would
   * leave the same-message case broken and read as if both were handled.
   *
   * `email.id` is in the deps because the body READS it (the exhaustive-deps rule requires it), and
   * it keeps the ref's owner current on a commit where the message changed but `$seen` did not. It
   * is INERT, established by mutation: removing it leaves all 45 tests green, and that is not a gap
   * in the suite. A stale owner can only survive a navigation across which `$seen` did not move, so
   * the two messages had the same `$seen` at the boundary; for the stale id to then matter, the NEW
   * message needs a pending dwell (so it was opened unread) AND a true → false edge — which it can
   * only reach by first going false → true, a run of this very effect that re-writes the pair with
   * the current id. The refresh always precedes the case it would be needed for. It is kept as
   * fidelity, not as a guard, and must not be cited as one.
   *
   * `previous.seen` is pinned by the suite: without it this cancels the dwell on mount for every
   * unread message and nothing is ever auto-marked.
   *
   * `!next` is INERT — deleting it alone leaves the suite green. (Deleting it together with the
   * fire-path `seenNow` guard IS red, but that composite proves nothing about this term: the
   * `seenNow` guard is red on its own.) It is kept as a statement of the edge, not as a guard: the
   * deps are `email.id`, `$seen` and `cancelDwell`, and `cancelDwell` is a `useCallback(…, [])` that
   * never changes identity — so a post-mount re-run with an UNCHANGED `email.id` can only have come
   * from `$seen` moving, and already has `previous.seen !== next`. (The claim is about `cancelDwell`
   * being stable, not about `$seen` being the only dep; an earlier version of this comment said the
   * latter and it was simply untrue of the array below.) StrictMode's second mount invoke re-runs the
   * body with nothing changed, where `!next` does bite — and finds nothing armed to cancel anyway,
   * because the arming effect refuses a message that is already read. Read its inertness as the
   * invariant being stated twice, not as slack in the check.
   */
  useEffect(() => {
    const next = email.keywords.$seen === true
    const previous = seenNow.current
    seenNow.current = { id: email.id, seen: next }
    if (previous.id === email.id && previous.seen && !next) cancelDwell()
  }, [email.id, email.keywords.$seen, cancelDwell])

  // Sanitize only once inline images are downloaded, so `cid:` refs resolve synchronously.
  const joinedHtml = useMemo(
    () => (htmlParts !== null ? htmlParts.map((part) => part.value).join('') : null),
    [htmlParts],
  )
  const sanitized = useMemo(() => {
    if (joinedHtml === null || !ready) return null
    return sanitize(joinedHtml, { allowRemote, resolveCid })
  }, [joinedHtml, allowRemote, ready, resolveCid])

  const isHtml = htmlParts !== null
  const bodyHtml = isHtml
    ? (sanitized?.html ?? null)
    : renderPlainText(textBody, { quotedLabel: t('reading.quotedLabel') })
  const hasRemoteContent = sanitized?.hasRemoteContent ?? false

  // Link clicks out of the body go through the host check first (FR-RD-08).
  const links = useLinkOpener()

  const name = senderName(email.from, t('list.noSender'))
  /**
   * The sender the hover-card acts on (FR-CON-05): the first `from` mailbox, or `null` when the
   * message carries no sender address — there is nothing to add, edit or search on without one, so the
   * avatar stays a plain (non-interactive) image in that case.
   */
  const senderIdentity: SenderIdentity | null =
    fromAddress !== null ? { email: fromAddress, name: email.from?.[0]?.name ?? null } : null
  /**
   * The sender's real address, shown ALWAYS — dimmed, next to the name, never on hover. The spec
   * says "on hover/tap"; a phone has no hover, and phishing friction a phone user cannot get is not
   * friction. Suppressed only when it would be a literal duplicate of the name (a sender with no
   * display name, where `senderName` already returns the address).
   */
  const showFromAddress = fromAddress !== null && fromAddress !== name
  /** `From: "security@bank.test" <attacker@evil.tld>` — the one shape a dimmed address can't answer. */
  const nameIsAddressLike = nameLooksLikeAddress(email.from)
  const dateLabel = formatDate(new Date(email.receivedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  // ---- header details (M3.9, FR-RD-06). Each row earns its place or is not rendered. ----

  /** A Reply-To that merely repeats From is what most mail carries; only a DIFFERENT one is news. */
  const replyTo =
    email.replyTo !== null && email.replyTo.length > 0 && !sameAddresses(email.replyTo, email.from)
      ? email.replyTo
      : null
  const bcc = body?.bcc !== undefined && body.bcc !== null && body.bcc.length > 0 ? body.bcc : null
  /** RFC 5322 `Sender`: the mailbox that actually sent it, on behalf of `From`. */
  const sender =
    body?.sender !== undefined &&
    body.sender !== null &&
    body.sender.length > 0 &&
    !sameAddresses(body.sender, email.from)
      ? body.sender
      : null
  const messageId = email.messageId?.[0]
  const sentLabel = useMemo(() => {
    if (email.sentAt === null) return null
    const sent = new Date(email.sentAt).getTime()
    const received = new Date(email.receivedAt).getTime()
    if (Number.isNaN(sent) || Number.isNaN(received)) return null
    if (Math.abs(sent - received) <= SENT_AT_DIVERGENCE_MS) return null
    return formatDate(new Date(sent), { dateStyle: 'medium', timeStyle: 'short' })
  }, [email.sentAt, email.receivedAt])
  // Reported, never judged — no verdict, no colour, no tick. See `auth-results.ts` for the why.
  const authReport = useMemo(() => topmostAuthResults(body?.authResults), [body?.authResults])

  // Open a reply / reply-all / forward draft seeded from this message (M2.3, FR-CMP-02/10).
  const onCompose = useCallback(
    (kind: ReplyKind): void => {
      /**
       * `?? null`, NEVER `?? joinedHtml` — quoting nothing beats quoting the raw mail. `sanitized`
       * is null for the whole inline-image window (`!ready`, i.e. every `cid:` blob download), and
       * the fallback used to hand the composer the message body exactly as it arrived. Nothing
       * downstream repairs that: the draft is persisted to IndexedDB and PUT to the server by
       * `use-draft-autosave` as-is, a remote `<img src="https://tracker…">` travels into the mail the
       * victim then sends, and if the send beats the lazy Squire engine mounting
       * (`RichTextEditor`'s pre-mount `setHTML` is a no-op) the raw body is what goes out. The
       * action bar and `bodyReady` now gate on `ready` as well, so this branch should be
       * unreachable from the UI — it is the value that makes it harmless if it ever is not.
       */
      const bodyHtml = isHtml ? (sanitized?.html ?? null) : null
      const forwardHeaderBlock = [
        `${t('compose.forwardLabelFrom')}: ${formatAddressList(email.from, t('list.noSender'))}`,
        `${t('compose.forwardLabelDate')}: ${dateLabel}`,
        `${t('compose.forwardLabelSubject')}: ${email.subject ?? ''}`,
        `${t('compose.forwardLabelTo')}: ${formatAddressList(email.to, t('reading.noRecipients'))}`,
      ].join('\n')
      const init = buildReplyDraft({
        kind,
        source: email,
        bodyHtml,
        textBody,
        ownAddresses: own,
        attribution: t('compose.replyAttribution', { date: dateLabel, name }),
        forwardSeparator: t('compose.forwardSeparator'),
        forwardHeaderBlock,
      })
      const attachments = kind === 'forward' && body !== undefined ? forwardAttachments(body) : []
      openDraft({
        ...init,
        attachments,
        sourceEmailId: init.sourceEmailId,
        sourceFlag: init.sourceKind === 'forward' ? '$forwarded' : '$answered',
      })
    },
    [isHtml, sanitized, email, textBody, own, t, dateLabel, name, body, openDraft],
  )

  // Both overflow actions route through the SAME lazy dialog: it is the only place that holds the
  // downloaded bytes, and a visible loading/error surface beats a save that fails silently.
  const overflowItems = useMemo<MenuItemSpec[]>(
    () => [
      { id: 'viewSource', label: t('reading.source.view'), onSelect: () => setSourceOpen('view') },
      { id: 'saveEml', label: t('reading.source.save'), onSelect: () => setSourceOpen('save') },
    ],
    [t],
  )

  const onAlwaysAllow =
    fromAddress !== null
      ? () => {
          setLoadedOnce(true)
          void setPref(db, accountId, READING_PREF_KEYS.remoteAllow, [...remoteAllow, fromAddress])
        }
      : undefined

  const inTrash = trashBox !== undefined && inThisMailbox === trashBox.id
  /**
   * A move whose target is the mailbox being read IN is not a move: `useTriage` refuses it (the patch
   * would order the mail out of the only mailbox it is in), so an enabled Archive button while
   * reading a message in Archive clicked through to nothing at all — no dispatch, no toast, no undo.
   * Trash already had this, as the `inTrash` swap to "Delete"; Archive and Junk did not. The `e`/`!`
   * chords gate on the same comparison in `canMove`, so button and keystroke cannot drift apart.
   */
  const inArchive = archiveBox !== undefined && inThisMailbox === archiveBox.id
  const inJunk = junkBox !== undefined && inThisMailbox === junkBox.id

  // Publish the action-bar callbacks so the keyboard layer can invoke them (M3.8). The buttons below
  // use the SAME object, which is the point: `r` and the Reply icon are one code path. Reply/forward
  // in particular CANNOT be reconstructed from outside — they close over the sanitized body, the
  // account's own addresses and four localized strings.
  const handlers = useMemo<ReadingHandlers>(
    () => ({
      emailId: email.id,
      mailboxId: inThisMailbox,
      // `ready` and not just `!loading`: `loading` is the BODY fetch, `ready` the inline-image
      // downloads that `sanitized` waits on. Between the two there is a body but no sanitized body,
      // and a reply seeded there quotes nothing (see `onCompose`) — a silently empty quote is worse
      // than a chord that refuses for the length of a blob download. Same gate on the buttons.
      bodyReady: !loading && ready,
      compose: onCompose,
      archive: () => triage.archive([email.id], inThisMailbox),
      junk: () => triage.junk([email.id], inThisMailbox),
      trash: () => triage.trash([email.id], inThisMailbox),
      toggleFlag: () => triage.setFlagged([email.id], email.keywords.$flagged !== true),
      // Cancel first: an armed dwell that fires after this would mark read the very message the
      // reader has just asked to keep unread. Everything that reaches mark-unread THROUGH the
      // reading pane — this button, and anything the reading store's handlers grow later — is this
      // one closure, so no reading-pane entry point can be added that quietly loses the cancel.
      // This is one of two cancels and covers only this pane; the other watches the `$seen`
      // transition. Neither reaches an outside-pane unread against an already-unread message —
      // `dwellTimer`'s note says why, and that case is open.
      markUnread: () => {
        cancelDwell()
        triage.setSeen([email.id], false)
      },
      openMove: () => setMoveOpen(true),
      openLabels: () => setLabelsOpen(true),
      requestDelete: () => setConfirmDelete(true),
    }),
    [
      email.id,
      email.keywords.$flagged,
      inThisMailbox,
      loading,
      ready,
      onCompose,
      triage,
      cancelDwell,
    ],
  )

  // Only the message the reader actually OPENED registers — `autoMark` already means precisely that
  // (a thread's auto-expanded newest sibling gets `autoMark={false}`). The unmount clear is guarded by
  // id so a thread re-render can never null out another message's entry.
  const registerReading = useReadingStore((state) => state.set)
  const clearReading = useReadingStore((state) => state.clear)
  useEffect(() => {
    if (!autoMark) return
    registerReading(handlers)
    return () => clearReading(handlers.emailId)
  }, [autoMark, handlers, registerReading, clearReading])

  return (
    <article className={styles.message} aria-label={email.subject || t('list.noSubject')}>
      <header className={styles.header}>
        {senderIdentity !== null ? (
          <button
            ref={senderButtonRef}
            type="button"
            className={styles.senderTrigger}
            aria-haspopup="dialog"
            aria-expanded={senderCardOpen}
            aria-label={t('reading.senderCard.trigger', { name })}
            onClick={() => setSenderCardOpen((open) => !open)}
          >
            <Avatar name={name} size="md" />
          </button>
        ) : (
          <Avatar name={name} size="md" />
        )}
        <div className={styles.headerMain}>
          <div className={styles.headerTop}>
            {/* Not inside the action bar or any other @media print-hidden chrome: the address is
                part of who the message is from, and it SHOULD appear on a printed copy. */}
            <span className={styles.fromLine}>
              <span className={styles.from}>{name}</span>
              {showFromAddress && <span className={styles.fromAddress}>{fromAddress}</span>}
              {nameIsAddressLike && (
                <span className={styles.nameWarning}>
                  <AlertTriangle className={styles.nameWarningIcon} aria-hidden="true" />
                  {t('reading.nameLooksLikeAddress')}
                </span>
              )}
            </span>
            <time className={styles.date} dateTime={email.receivedAt}>
              {dateLabel}
            </time>
            {onCollapse !== undefined && (
              <IconButton
                label={t('reading.collapse')}
                variant="ghost"
                size="sm"
                aria-expanded={true}
                onClick={onCollapse}
              >
                <ChevronUp />
              </IconButton>
            )}
          </div>
          <div className={styles.headerSub}>
            <span className={styles.recipients}>
              {t('reading.to')}: {formatAddressList(email.to, t('reading.noRecipients'))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {t('reading.details')}
            </Button>
          </div>
          {detailsOpen && (
            <dl className={styles.details}>
              <dt>{t('reading.from')}</dt>
              <dd>{formatAddressList(email.from, t('list.noSender'))}</dd>
              {replyTo !== null && (
                <>
                  <dt>{t('reading.replyTo')}</dt>
                  <dd>{formatAddressList(replyTo, t('reading.noRecipients'))}</dd>
                </>
              )}
              <dt>{t('reading.to')}</dt>
              <dd>{formatAddressList(email.to, t('reading.noRecipients'))}</dd>
              {email.cc !== null && email.cc.length > 0 && (
                <>
                  <dt>{t('reading.cc')}</dt>
                  <dd>{formatAddressList(email.cc, t('reading.noRecipients'))}</dd>
                </>
              )}
              {bcc !== null && (
                <>
                  <dt>{t('reading.bcc')}</dt>
                  <dd>{formatAddressList(bcc, t('reading.noRecipients'))}</dd>
                </>
              )}
              {sender !== null && (
                <>
                  <dt>{t('reading.sender')}</dt>
                  <dd>
                    {t('reading.senderOnBehalfOf', {
                      sender: formatAddressList(sender, t('list.noSender')),
                      from: formatAddressList(email.from, t('list.noSender')),
                    })}
                  </dd>
                </>
              )}
              <dt>{t('reading.date')}</dt>
              <dd>{dateLabel}</dd>
              {sentLabel !== null && (
                <>
                  <dt>{t('reading.sentAt')}</dt>
                  <dd>{sentLabel}</dd>
                </>
              )}
              {messageId !== undefined && (
                <>
                  <dt>{t('reading.messageId')}</dt>
                  <dd>{messageId}</dd>
                </>
              )}
              {authReport !== null && (
                <>
                  <dt>{t('reading.authResults.label')}</dt>
                  <dd>
                    {t('reading.authResults.reportedBy', { host: authReport.authservId })}{' '}
                    {authReport.results
                      .map((result) => `${result.method}=${result.result}`)
                      .join(' · ')}
                    <span className={styles.authNote}>{t('reading.authResults.unverified')}</span>
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      </header>

      {/* B20.2: the role was here with none of the keyboard model behind it, so a screen reader
          announced "toolbar" and arrow keys did nothing — while eleven controls each took their own
          tab stop. `useToolbarRoving` supplies the model the role promises. */}
      <div
        ref={actionBarRef}
        className={styles.actionBar}
        role="toolbar"
        aria-label={t('reading.actions')}
        {...actionBarKeys}
      >
        {/* B34: `disabled` stays for the STRUCTURAL refusals (no such folder, already there) and
            `unavailableReason` carries the RIGHTS refusal — a permission the user should be told
            about, on a control that stays focusable so they can hear it. A move needs the source's
            `mayRemoveItems` and the target's `mayAddItems`; the source half is the gap B34 names. */}
        {/* Three groups, because ten equally-weighted glyphs in one run gave the eye nothing to
            hold on to: file it (archive, label, move) | get rid of it (junk, trash) | change its
            state (flag, unread). The gap between groups is four times the gap within one, which is
            the whole mechanism — no separators, no labels, just distance doing the grouping. */}
        <span className={styles.actionGroup}>
          <IconButton
            label={t('list.actions.archive')}
            variant="ghost"
            disabled={archiveBox === undefined || inArchive}
            unavailableReason={reasonText(rights.moveReason(inThisMailbox, archiveBox?.id))}
            onClick={handlers.archive}
          >
            <Archive />
          </IconButton>
          {/* Not `LabelMenuButton`: that component owns its own open state, which the `l` chord has no
            way to reach. The bulk bar still uses it — there, nothing but the mouse opens the picker. */}
          <IconButton
            ref={labelButtonRef}
            label={t('labels.assign')}
            variant="ghost"
            aria-haspopup="menu"
            aria-expanded={labelsOpen}
            onClick={() => setLabelsOpen((open) => !open)}
          >
            <Tag />
          </IconButton>
          {/* Without a source mailbox `move` keeps the other memberships — that is a COPY, not the
            move this button promises. The `v` chord gates on the same value (the shortcut context
            reads this very `mailboxId` back off the registered handlers), so the two cannot drift. */}
          <IconButton
            label={t('list.actions.move')}
            variant="ghost"
            disabled={inThisMailbox === null}
            // Only the SOURCE half here: the picker filters targets by `mayAddItems` already, and its
            // empty state covers "nothing left to file into".
            unavailableReason={reasonText(rights.removeReason(inThisMailbox))}
            onClick={handlers.openMove}
          >
            <FolderInput />
          </IconButton>
        </span>
        <span className={styles.actionGroup}>
          <IconButton
            label={t('list.actions.junk')}
            variant="ghost"
            disabled={junkBox === undefined || inJunk}
            unavailableReason={reasonText(rights.moveReason(inThisMailbox, junkBox?.id))}
            onClick={handlers.junk}
          >
            <Ban />
          </IconButton>
          <IconButton
            label={inTrash ? t('list.actions.delete') : t('list.actions.trash')}
            variant="ghost"
            disabled={!inTrash && trashBox === undefined}
            // In Trash this button DESTROYS rather than moves, so it takes the destroy verdict.
            unavailableReason={reasonText(
              inTrash ? rights.reason('destroy') : rights.moveReason(inThisMailbox, trashBox?.id),
            )}
            onClick={() => (inTrash ? handlers.requestDelete() : handlers.trash())}
          >
            <Trash2 />
          </IconButton>
        </span>
        <span className={styles.actionGroup}>
          <IconButton
            label={
              email.keywords.$flagged === true ? t('list.actions.unflag') : t('list.actions.flag')
            }
            variant="ghost"
            unavailableReason={reasonText(rights.reason('keywords'))}
            onClick={handlers.toggleFlag}
          >
            <Star className={email.keywords.$flagged === true ? styles.flagOn : undefined} />
          </IconButton>
          <IconButton
            label={t('reading.markUnread')}
            variant="ghost"
            unavailableReason={reasonText(rights.reason('seen'))}
            onClick={handlers.markUnread}
          >
            <MailMinus />
          </IconButton>
        </span>
        <span className={styles.actionSpacer} />
        {/* All three gate on `handlers.bodyReady` — `!loading && ready` — and not on `loading`
            alone: the body arrives before its inline images do, and in that window `sanitized` is
            still null and a seeded quote would be empty. One expression for button and chord, read
            off the same handlers object the shortcut layer gets. */}
        <IconButton
          label={t('reading.reply')}
          variant="ghost"
          disabled={!handlers.bodyReady}
          onClick={() => onCompose('reply')}
        >
          <Reply />
        </IconButton>
        <IconButton
          label={t('reading.replyAll')}
          variant="ghost"
          disabled={!handlers.bodyReady}
          onClick={() => onCompose('replyAll')}
        >
          <ReplyAll />
        </IconButton>
        <IconButton
          label={t('reading.forward')}
          variant="ghost"
          disabled={!handlers.bodyReady}
          onClick={() => onCompose('forward')}
        >
          <Forward />
        </IconButton>
        {/* Wrapped rather than given `className` directly — the same shape FolderTreeView uses, and
            the span is what the `@media print` rule hides. */}
        <span className={styles.overflowMenu}>
          <Menu
            triggerLabel={t('reading.more')}
            trigger={<MoreHorizontal aria-hidden="true" />}
            align="end"
            items={overflowItems}
          />
        </span>
      </div>

      {hasRemoteContent && !allowRemote && (
        <RemoteContentBanner
          sender={name}
          onLoad={() => setLoadedOnce(true)}
          onAlwaysAllow={onAlwaysAllow}
        />
      )}

      <div className={styles.bodyWrap}>
        {loading || bodyHtml === null ? (
          <div className={styles.bodyLoading}>
            <Spinner label={t('ui.spinner.label')} />
          </div>
        ) : (
          <MailBodyFrame
            bodyHtml={bodyHtml}
            allowRemote={allowRemote}
            title={t('reading.frameTitle', { subject: email.subject || t('list.noSubject') })}
            onOpenLink={links.onOpenLink}
          />
        )}
      </div>

      {links.pending !== null && (
        <Suspense fallback={null}>
          <LinkWarningDialog
            claimedHost={links.pending.claimedHost}
            targetHost={links.pending.targetHost}
            onConfirm={links.confirm}
            onCancel={links.cancel}
          />
        </Suspense>
      )}

      {body !== undefined && (
        <AttachmentList accountId={accountId} attachments={body.attachments} />
      )}

      {moveOpen && (
        <MoveDialog
          open={moveOpen}
          currentMailboxId={inThisMailbox}
          onClose={() => setMoveOpen(false)}
          onMove={(target, label) => {
            triage.moveTo([email.id], inThisMailbox, target, label)
            setMoveOpen(false)
          }}
        />
      )}

      {labelsOpen && (
        <LabelMenu
          ids={[email.id]}
          anchorRef={labelButtonRef}
          onClose={() => setLabelsOpen(false)}
        />
      )}

      {senderCardOpen && senderIdentity !== null && (
        <SenderCard
          from={senderIdentity}
          accountId={accountId}
          mailboxId={mailboxId}
          anchorRef={senderButtonRef}
          onClose={() => setSenderCardOpen(false)}
        />
      )}

      {sourceOpen !== null && (
        <Suspense fallback={null}>
          <MessageSourceDialog
            open
            accountId={accountId}
            email={email}
            autoSave={sourceOpen === 'save'}
            onClose={() => setSourceOpen(null)}
          />
        </Suspense>
      )}

      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={t('list.actions.delete')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('mailbox.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  actions.destroy([email.id])
                  setConfirmDelete(false)
                }}
              >
                {t('list.actions.delete')}
              </Button>
            </>
          }
        >
          <p>{t('reading.confirmDeleteBody')}</p>
        </Dialog>
      )}
    </article>
  )
}

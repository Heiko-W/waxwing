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
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  Archive,
  Ban,
  ChevronDown,
  ChevronUp,
  FolderInput,
  Forward,
  Lock,
  MailMinus,
  MoreHorizontal,
  Reply,
  ReplyAll,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FULL_PARAM, mailHrefKeepingQuery, useNavigate, useRoute } from '../app/route'
import { useSession } from '../app/session/context'
import {
  buildReplyDraft,
  forwardAttachments,
  isForward,
  messageAsAttachment,
  ownAddresses,
  type ReplyKind,
  useComposerStore,
} from '../compose'
import { mailtoBodyToHtml, parseMailto } from '../compose/mailto'
import { formatDate } from '../i18n/formatters'
import { type EmailRow, setPref, useMailboxByRole, useReplica } from '../sync'
import {
  Avatar,
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuItemSpec,
  Skeleton,
  useToolbarRoving,
  VisuallyHidden,
} from '../ui'
import { AttachmentList } from './AttachmentList'
import { topmostAuthResults } from './auth-results'
import { detectProtection, type ProtectionPart } from './encrypted-message'
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
import { ReadReceiptBanner } from './ReadReceiptBanner'
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
import { SNOOZE_PRESETS } from './snooze'
import { UnsubscribeBanner } from './UnsubscribeBanner'
import { hasUnsubscribeOffer, readUnsubscribeOffer, sendOneClickUnsubscribe } from './unsubscribe'
import { OVERFLOW_TRIGGER_ATTR, useActionOverflow } from './use-action-overflow'
import { useLinkOpener } from './use-link-opener'
import { useMessageActions } from './use-message-actions'
import { useMessageRights } from './use-message-rights'
import { sourceFilename } from './use-message-source'
import { useReadReceipt } from './use-read-receipt'
import { useSnooze } from './use-snooze'
import { useTriage } from './use-triage'
import { useInlineImages } from './useInlineImages'
import { useMessageBody } from './useMessageBody'

/**
 * One reading-pane action, in the form both the bar and the `⋯` menu can render (B49).
 *
 * The two surfaces do not take the same props — a button has `unavailableReason` and a menu item
 * does not — so this is what they have in common, and each render site adapts it. `popover` marks
 * the one action that owns an anchored surface rather than firing and finishing.
 */
/**
 * Which meaning-family an action belongs to. The bar draws a wider gap where the family changes,
 * which is the whole of C5's fix: six verbs from four families in one unbroken 4px run read as a
 * strip of decoration, and on a phone the row wrapped so that "Move to…" landed visually inside
 * the reply group. Grouping by attribute rather than by wrapper elements keeps the row a flat list
 * of buttons, which is what `useToolbarRoving` walks.
 */
type ActionGroup = 'respond' | 'file' | 'mark'

interface BarAction {
  readonly id: string
  readonly group: ActionGroup
  readonly label: string
  readonly icon: LucideIcon
  readonly onSelect: () => void
  readonly disabled?: boolean
  /** A RIGHTS refusal (B34): the control stays focusable and says why, rather than going quiet. */
  readonly unavailableReason?: string | undefined
  readonly destructive?: boolean
  readonly iconClassName?: string | undefined
  /** Opens an anchored popover (the label picker) instead of acting; needs a ref and aria state. */
  readonly popover?: boolean
}

/**
 * How many actions the bar shows when everything fits: reply, reply-all, forward, delete.
 *
 * A CEILING, not a target — `useActionOverflow` still takes it lower when the pane is narrow. It
 * exists because the measuring version alone answered the wrong question: at 1440px eleven controls
 * fit, so eleven appeared, and the row went back to being the undifferentiated strip C5 was about.
 * Apple Mail does not grow its toolbar with the window either; the toolbar is curated and the rest
 * lives in the menu, which here is one that already has to exist for narrow panes. The four are the
 * owner's choice.
 */
const PRIMARY_ACTIONS = 4

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
  const { snooze } = useSnooze()
  // B34. The subject is this one message, so the verdict is exact rather than the account floor.
  const rightsIds = useMemo(() => [email.id], [email.id])
  const rights = useMessageRights(rightsIds)
  const seenDenied = rights.reason('seen') !== null
  /** A refusal key from {@link rights} as the finished sentence a control announces; `undefined` = allowed. */
  // Memoized only so it can be a dependency of `barActions` without defeating that memo — the six
  // call sites are all inside it.
  const reasonText = useCallback(
    (key: string | null): string | undefined => (key === null ? undefined : t(key)),
    [t],
  )
  const openDraft = useComposerStore((state) => state.openDraft)
  /**
   * Full screen is a property of the ROUTE (`?full=1`), read here rather than threaded down as a
   * prop: the address bar is the single source of truth, and a prop would be a second copy able to
   * disagree with it. In a thread each message offers the view for ITSELF — full screen on the third
   * reply opens that reply, which is what the reader pointed at.
   */
  const route = useRoute()
  const navigate = useNavigate()
  const fullScreen = route.search.get(FULL_PARAM) === '1'
  const onToggleFullScreen = useCallback(() => {
    navigate(mailHrefKeepingQuery(route.search, mailboxId, email.id, { full: !fullScreen }))
  }, [navigate, route.search, mailboxId, email.id, fullScreen])
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
  const overflowRef = useRef<HTMLSpanElement>(null)
  /*
   * Where the label popover anchors, which since B49 is not always the same element: below some pane
   * width the Label button is inside the `⋯` menu, and the popover has to hang off the trigger that
   * is actually on screen. A getter rather than a second piece of state — it is read at open time,
   * and anything stored would have to be kept in step with a ResizeObserver.
   *
   * The fallback must be FOCUSABLE, not merely present: `LabelMenu` closes by calling
   * `anchorRef.current?.focus()`, and the note above `labelsOpen` records what happens when that
   * lands on something that cannot take focus — Escape drops the reader onto `<body>`, outside the
   * pane they were reading in. The menu trigger is a button, which is the whole reason it is the one
   * picked here rather than the wrapping span.
   */
  const labelAnchorRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return labelButtonRef.current ?? overflowRef.current?.querySelector('button') ?? null
      },
    }),
    [],
  )
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
  // What this message offers by way of getting off the list (FR-RD-09). Absent on a row written
  // before M5.3 — the offer is then simply empty, and the next body fetch fills it in.
  /** What the message's MIME structure says it is (M5.15). No cryptography is performed. */
  const readReceipt = useReadReceipt(email, body)
  const protection = useMemo(
    () => detectProtection(body?.bodyStructure as ProtectionPart | undefined),
    [body?.bodyStructure],
  )
  const unsubscribeOffer = useMemo(
    () => readUnsubscribeOffer(body?.listUnsubscribe, body?.listUnsubscribePost),
    [body?.listUnsubscribe, body?.listUnsubscribePost],
  )

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
      const attachments =
        kind === 'forwardAsAttachment'
          ? // The whole message, by blob reference. No download, no re-upload: the server already
            // holds these bytes under the Email's own blobId.
            [messageAsAttachment(email, sourceFilename(email.subject))]
          : kind === 'forward' && body !== undefined
            ? forwardAttachments(body)
            : []
      openDraft({
        ...init,
        attachments,
        sourceEmailId: init.sourceEmailId,
        sourceFlag: isForward(init.sourceKind) ? '$forwarded' : '$answered',
      })
    },
    [isHtml, sanitized, email, textBody, own, t, dateLabel, name, body, openDraft],
  )

  // Both overflow actions route through the SAME lazy dialog: it is the only place that holds the
  // downloaded bytes, and a visible loading/error surface beats a save that fails silently.
  const overflowItems = useMemo<MenuItemSpec[]>(
    () => [
      // Snooze (FR-ORG-03): hide it until the chosen time. In the overflow rather than the action
      // bar because it is a deliberate act, not a triage reflex.
      ...SNOOZE_PRESETS.map((preset) => ({
        id: `snooze-${preset.id}`,
        label: snoozeLabel(t, preset.id),
        onSelect: () => snooze([email.id], preset.at(new Date())),
      })),
      // Forwarding the message whole rather than quoted — the shape a recipient needs when the
      // message ITSELF is the point (a bounce to diagnose, a phishing mail to hand to an admin).
      {
        id: 'forwardAsAttachment',
        label: t('reading.forwardAsAttachment'),
        onSelect: () => onCompose('forwardAsAttachment'),
      },
      // Print needs nothing but the browser: the print stylesheets already strip the chrome, and
      // `[data-waxwing-portal]` is hidden in print, so this menu is gone by the time the dialog
      // opens. The one thing it cannot do is print a message other than the one on screen.
      // The non-pointer half of the double-click gesture. Double-click cannot be reached from a
      // keyboard at all, so the action has to exist somewhere that can (SC 2.5.7) — and a menu entry
      // is also where a reader goes looking for a thing they saw once and cannot remember.
      {
        id: 'fullScreen',
        label: fullScreen ? t('reading.exitFullScreen') : t('reading.fullScreen'),
        onSelect: onToggleFullScreen,
      },
      { id: 'print', label: t('reading.print'), onSelect: () => window.print() },
      { id: 'viewSource', label: t('reading.source.view'), onSelect: () => setSourceOpen('view') },
      { id: 'saveEml', label: t('reading.source.save'), onSelect: () => setSourceOpen('save') },
    ],
    [t, onCompose, snooze, email.id, fullScreen, onToggleFullScreen],
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
      print: () => window.print(),
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

  /*
   * The action bar as DATA, in priority order (B49).
   *
   * Eleven controls do not fit a 270px pane at 44px each, so below some width the tail of this list
   * moves into the `⋯` menu — which is why it is an array and not JSX: the bar renders the head and
   * the menu is built from the same entries, so an action cannot be hidden without becoming
   * reachable in the same render. Buttons hidden by CSS would just be gone.
   *
   * THE ORDER IS THE DECISION, and it is the owner's: reply, reply-all, forward, delete stay
   * visible longest. Filing (archive, move, label), reporting (junk) and state (flag, unread) give
   * way first. It is one order at every width rather than one for wide and another for narrow, so
   * dragging the splitter takes buttons off the end instead of rearranging the row under the
   * pointer.
   */
  const barActions = useMemo<BarAction[]>(
    () => [
      {
        id: 'reply',
        group: 'respond',
        label: t('reading.reply'),
        icon: Reply,
        // All three compose actions gate on `handlers.bodyReady` — `!loading && ready` — and not on
        // `loading` alone: the body arrives before its inline images do, and in that window
        // `sanitized` is still null and a seeded quote would be empty. One expression for button and
        // chord, read off the same handlers object the shortcut layer gets.
        disabled: !handlers.bodyReady,
        onSelect: () => onCompose('reply'),
      },
      {
        id: 'replyAll',
        group: 'respond',
        label: t('reading.replyAll'),
        icon: ReplyAll,
        disabled: !handlers.bodyReady,
        onSelect: () => onCompose('replyAll'),
      },
      {
        id: 'forward',
        group: 'respond',
        label: t('reading.forward'),
        icon: Forward,
        disabled: !handlers.bodyReady,
        onSelect: () => onCompose('forward'),
      },
      {
        id: 'trash',
        group: 'file',
        label: inTrash ? t('list.actions.delete') : t('list.actions.trash'),
        icon: Trash2,
        disabled: !inTrash && trashBox === undefined,
        // In Trash this button DESTROYS rather than moves, so it takes the destroy verdict.
        unavailableReason: reasonText(
          inTrash ? rights.reason('destroy') : rights.moveReason(inThisMailbox, trashBox?.id),
        ),
        destructive: true,
        onSelect: () => (inTrash ? handlers.requestDelete() : handlers.trash()),
      },
      /* B34: `disabled` stays for the STRUCTURAL refusals (no such folder, already there) and
         `unavailableReason` carries the RIGHTS refusal — a permission the user should be told
         about, on a control that stays focusable so they can hear it. A move needs the source's
         `mayRemoveItems` and the target's `mayAddItems`; the source half is the gap B34 names. */
      {
        id: 'archive',
        group: 'file',
        label: t('list.actions.archive'),
        icon: Archive,
        disabled: archiveBox === undefined || inArchive,
        unavailableReason: reasonText(rights.moveReason(inThisMailbox, archiveBox?.id)),
        onSelect: handlers.archive,
      },
      {
        // Without a source mailbox `move` keeps the other memberships — that is a COPY, not the
        // move this button promises. The `v` chord gates on the same value (the shortcut context
        // reads this very `mailboxId` back off the registered handlers), so the two cannot drift.
        id: 'move',
        group: 'file',
        label: t('list.actions.move'),
        icon: FolderInput,
        disabled: inThisMailbox === null,
        // Only the SOURCE half here: the picker filters targets by `mayAddItems` already, and its
        // empty state covers "nothing left to file into".
        unavailableReason: reasonText(rights.removeReason(inThisMailbox)),
        onSelect: handlers.openMove,
      },
      {
        // Not `LabelMenuButton`: that component owns its own open state, which the `l` chord has no
        // way to reach. The bulk bar still uses it — there, nothing but the mouse opens the picker.
        id: 'labels',
        group: 'mark',
        label: t('labels.assign'),
        icon: Tag,
        popover: true,
        onSelect: () => setLabelsOpen((open) => !open),
      },
      {
        id: 'junk',
        group: 'file',
        label: t('list.actions.junk'),
        icon: Ban,
        disabled: junkBox === undefined || inJunk,
        unavailableReason: reasonText(rights.moveReason(inThisMailbox, junkBox?.id)),
        onSelect: handlers.junk,
      },
      {
        id: 'flag',
        group: 'mark',
        label: email.keywords.$flagged === true ? t('list.actions.unflag') : t('list.actions.flag'),
        icon: Star,
        iconClassName: email.keywords.$flagged === true ? styles.flagOn : undefined,
        unavailableReason: reasonText(rights.reason('keywords')),
        onSelect: handlers.toggleFlag,
      },
      {
        id: 'markUnread',
        group: 'mark',
        label: t('reading.markUnread'),
        icon: MailMinus,
        unavailableReason: reasonText(rights.reason('seen')),
        onSelect: handlers.markUnread,
      },
    ],
    [
      t,
      reasonText,
      handlers,
      onCompose,
      rights,
      inThisMailbox,
      inTrash,
      inArchive,
      inJunk,
      trashBox,
      archiveBox,
      junkBox,
      email.keywords.$flagged,
    ],
  )

  const visibleActions = useActionOverflow(
    actionBarRef,
    Math.min(PRIMARY_ACTIONS, barActions.length),
  )

  /*
   * The menu is the bar's tail plus what was always in it.
   *
   * A displaced action arrives DISABLED with its reason spoken in the label, because a menu item has
   * nowhere to put `unavailableReason` — the pattern B34 built (a focusable control that explains
   * why it refuses) has no equivalent here, and a silently inert row would be worse than a wordy
   * one. `destructive` survives the trip: Delete is red in the menu as it is in the bar.
   */
  const menuItems = useMemo<MenuItemSpec[]>(
    () => [
      ...barActions.slice(visibleActions).map((action) => ({
        id: action.id,
        label:
          action.unavailableReason === undefined
            ? action.label
            : `${action.label} — ${action.unavailableReason}`,
        icon: action.icon,
        disabled: action.disabled === true || action.unavailableReason !== undefined,
        // Spread rather than assigned: `exactOptionalPropertyTypes` refuses an explicit `undefined`
        // where the target says `boolean`.
        ...(action.destructive === true ? { destructive: true } : {}),
        onSelect: action.onSelect,
      })),
      ...overflowItems,
    ],
    [barActions, visibleActions, overflowItems],
  )

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
      {/* ONE row, always (B49), and at most PRIMARY_ACTIONS of them. The wider gap where the
          meaning-family changes is C5's fix, restored: B49 removed the group wrappers along with
          the ten glyphs that made them necessary, but the measuring version kept showing all
          eleven wherever they fit, so the strip came back at desktop widths. The gap is an
          attribute rather than a wrapper because the row has to stay a flat list of buttons for
          `useToolbarRoving`. */}
      <div
        ref={actionBarRef}
        className={styles.actionBar}
        role="toolbar"
        aria-label={t('reading.actions')}
        {...actionBarKeys}
      >
        {barActions.slice(0, visibleActions).map((action, index, shown) => (
          <IconButton
            key={action.id}
            // First of its family, and not first overall: the gap goes BEFORE it.
            data-group-start={
              index > 0 && shown[index - 1]?.group !== action.group ? '' : undefined
            }
            // Only the label picker takes a ref, and it needs one: its popover positions against
            // this button and returns focus to it on close.
            ref={action.popover === true ? labelButtonRef : null}
            label={action.label}
            variant="ghost"
            disabled={action.disabled}
            unavailableReason={action.unavailableReason}
            aria-haspopup={action.popover === true ? 'menu' : undefined}
            aria-expanded={action.popover === true ? labelsOpen : undefined}
            onClick={action.onSelect}
          >
            <action.icon className={action.iconClassName} />
          </IconButton>
        ))}
        {/* Wrapped rather than given `className` directly — the same shape FolderTreeView uses, and
            the span is what the `@media print` rule hides. It also carries the attribute the
            overflow measurement finds one control by, and the ref the label popover falls back to
            when its own button is inside this menu. */}
        <span
          className={styles.overflowMenu}
          ref={overflowRef}
          {...{ [OVERFLOW_TRIGGER_ATTR]: '' }}
        >
          <Menu
            triggerLabel={t('reading.more')}
            trigger={<MoreHorizontal aria-hidden="true" />}
            align="end"
            items={menuItems}
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

      {readReceipt !== null && (
        // Never automatic. NFR-PRIV-01: opening a message is not consent to tell anyone.
        <ReadReceiptBanner
          request={readReceipt.request}
          alreadySent={readReceipt.alreadySent}
          onConfirm={readReceipt.send}
        />
      )}

      {protection.kind !== 'none' && (
        // Says what the message IS. For an encrypted one this is the difference between a blank
        // body and an explanation the reader can act on — and on an account with Stalwart's
        // encryption-at-rest switched on, EVERY message arrives this way.
        <section className={styles.remoteBanner} aria-label={t('reading.protection.title')}>
          {protection.kind === 'encrypted' ? (
            <Lock aria-hidden="true" className={styles.remoteIcon} />
          ) : (
            <ShieldCheck aria-hidden="true" className={styles.remoteIcon} />
          )}
          <div className={styles.remoteText}>
            <p className={styles.remoteTitle}>
              {protection.kind === 'encrypted'
                ? t('reading.protection.encrypted')
                : t('reading.protection.signed')}
            </p>
            <p className={styles.remoteNote}>
              {protection.kind === 'encrypted'
                ? t('reading.protection.encryptedNote')
                : // Deliberately NOT "verified": nothing here checked the signature. Saying so is
                  // the whole point — a green tick this client has not earned would be a lie.
                  t('reading.protection.signedNote')}
            </p>
          </div>
        </section>
      )}

      {hasUnsubscribeOffer(unsubscribeOffer) && (
        <UnsubscribeBanner
          offer={unsubscribeOffer}
          onOneClick={(endpoint) => sendOneClickUnsubscribe(endpoint)}
          // Through the same host gate as any other link in a message (FR-RD-08). The href IS the
          // link text here — it came from a header, not from anchor text — so the mismatch check
          // has nothing to catch, but routing it anywhere else would be a second door into
          // `window.open` that the check does not watch.
          onOpen={(url) => links.onOpenLink(url, { href: url, text: url, raw: url })}
          onCompose={(mailto) => {
            const request = parseMailto(mailto)
            openDraft({
              to: request.to,
              subject: request.subject,
              body: mailtoBodyToHtml(request.body),
            })
          }}
        />
      )}

      <div className={styles.bodyWrap}>
        {loading || bodyHtml === null ? (
          // Text-shaped placeholders rather than a spinner in a box: what is arriving is prose,
          // and a spinner says only "wait" while these say what for. The block is the frame's own
          // minimum height, so the pane holds still when the body lands.
          <div className={styles.bodyLoading} aria-busy="true">
            <VisuallyHidden>
              <span role="status">{t('ui.spinner.label')}</span>
            </VisuallyHidden>
            <Skeleton width="92%" height={14} />
            <Skeleton width="98%" height={14} />
            <Skeleton width="84%" height={14} />
            <Skeleton width="60%" height={14} />
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
        <AttachmentList
          accountId={accountId}
          attachments={body.attachments}
          subject={email.subject}
        />
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
          anchorRef={labelAnchorRef}
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

/**
 * Spelled out rather than interpolated: `guards.test.ts` only sees LITERAL keys, so a computed one
 * passes every gate and then renders the key itself on screen.
 */
function snoozeLabel(t: TFunction, id: (typeof SNOOZE_PRESETS)[number]['id']): string {
  switch (id) {
    case 'laterToday':
      return t('reading.snooze.laterToday')
    case 'tomorrow':
      return t('reading.snooze.tomorrow')
    case 'thisWeekend':
      return t('reading.snooze.thisWeekend')
    case 'nextWeek':
      return t('reading.snooze.nextWeek')
  }
}

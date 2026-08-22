/**
 * Virtualized message list (M1.6, FR-LST-01..07). Renders the server-ordered `queryCache` window
 * (from {@link useMessageList}) with TanStack Virtual so a 100 k-message mailbox scrolls smoothly,
 * hydrating ONLY the visible slice from the replica. It is an APG `grid` — the CONTAINER holds
 * focus and moves an `aria-activedescendant` across virtualized rows (so focus is never lost when a
 * row scrolls out and unmounts), with container-delegated keyboard (arrows/space/enter/shift-range/
 * ctrl-a/escape). It has a disclosed view-options strip (sort / threading / unread-first) whose
 * choices persist locally, a selection-driven bulk-actions bar (read/flag/archive/junk/trash/delete → the engine
 * outbox), and infinite scroll that pages older messages via `loadMore`.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type { Id } from '@waxwing/jmap'
import {
  Archive,
  Ban,
  Ellipsis,
  FolderInput,
  type LucideIcon,
  Mail,
  MailOpen,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../app/config-context'
import { mailHrefKeepingQuery, READING_HISTORY_MARK, useNavigate, useRoute } from '../app/route'
import { useDraftOpener } from '../compose'
import {
  type EmailRow,
  type QuerySpec,
  setPref,
  useEmailWindow,
  useLocalPref,
  useMailbox,
  useMailboxByRole,
  useMailboxes,
  useReplica,
} from '../sync'
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Menu,
  type MenuItemSpec,
  Select,
  VisuallyHidden,
} from '../ui'
import { clearActiveDrag, draggedMessageIds, MESSAGES_MIME, setActiveDrag } from './dnd'
import { LabelMenu } from './labels/LabelMenu'
import { useLabels } from './labels/use-labels'
import { type GridHandle, useListStore } from './list-store'
import type { Density, RowLabel } from './MessageRow'
import { MessageRow } from './MessageRow'
import { MoveDialog } from './MoveDialog'
import styles from './message-list.module.css'
import { messageRights } from './rights'
import { useSnippets } from './search/use-snippets'
import { useSwipeLeft, useSwipeRight } from './swipe-prefs'
import { OVERFLOW_TRIGGER_ATTR, useActionOverflow } from './use-action-overflow'
import { useMessageActions } from './use-message-actions'
import { type ListSource, type MessageSort, useMessageList } from './use-message-list'
import { useAccountIsReadOnly, useMessageRightsFor } from './use-message-rights'
import { usePrefetchBodies } from './use-prefetch-bodies'
import { type ResolvedSwipe, useRowSwipe } from './use-swipe'
import { useTriage } from './use-triage'

const OVERSCAN = 8
const ROW_HEIGHT: Record<Density, number> = { comfortable: 76, compact: 54 }

/** Enough placeholder rows to fill a tall window; the container clips whatever does not fit. Stable
    keys, because these are positions in a fixed grid rather than items with an identity. */
const SKELETON_KEYS = Array.from({ length: 12 }, (_, index) => `skeleton-${index}`)

/** The skeleton rows are inert: they exist to hold the grid's shape, not to be operated. */
function noop(): void {}

/**
 * Vite types a CSS module as an index signature, so every class reads `string | undefined` under
 * `noUncheckedIndexedAccess`. The gesture hands this straight to `classList`, where an empty string
 * throws — so it gets a token that is always valid.
 */
const SWIPING_CLASS = styles.swiping ?? 'swiping'

/**
 * What `resolveSwipe` (below) locks in at the axis lock. The gesture's own
 * {@link ResolvedSwipe} carries only what it needs to paint the strip; the SOURCE mailbox a move was
 * resolved against rides along here because `commit` reaches this component through an options ref
 * that `use-swipe` refreshes on every render — it would otherwise move `from` whatever mailbox is
 * current at LIFT, not the one the gesture started in.
 *
 * That is reachable, not theoretical: `<MessageList>` is not keyed on the mailbox in `MailScreen`, so
 * a folder change re-renders it in place and an in-flight gesture survives. On a tablet with a
 * persistent folder rail, finger 1 locks a swipe on an Inbox row while finger 2 taps Sent — the
 * gesture rejects that second pointer (`isPrimary`), but the rail's click is not the gesture's to
 * reject and goes through. The lift then archived e1 `from: 'sent'`, whose `mailboxIds/sent: null`
 * patch is a no-op on a message that was never there: the mail ends up in Inbox AND Archive, and the
 * Undo toast offers to file it into Sent.
 *
 * OPTIONAL purely so this stays assignable to `RowSwipeOptions.commit` (`use-swipe.ts` is not ours to
 * change). `resolveSwipe` always sets it for a move; `kind: 'read'` is not a move and has no source.
 */
type ResolvedRowSwipe = ResolvedSwipe & { readonly from?: Id }

export interface MessageListProps {
  /** The route's current folder — drives the folder list AND the open-path for a search result. */
  readonly mailboxId: Id | undefined
  /** When present, the list renders SEARCH results (M3.1) instead of the folder window. */
  readonly search?:
    | { readonly spec: QuerySpec; readonly scopeMailboxId: Id | undefined }
    | undefined
  /** The active label keyword when browsing `/mail?label=…` (M3.2) — enables "Remove from label". */
  readonly activeLabel?: string | undefined
  /**
   * Whether the view options (sort / threading / unread-first) are disclosed, and the DOM id the
   * pane's toggle points its `aria-controls` at.
   *
   * The toggle lives in `MailScreen`'s pane toolbar rather than here, because that row also carries
   * the folder title and the drawer button: one strip for "which list is this and how is it shown",
   * instead of the two rows plus a permanently visible four-control block this replaces. Collapsed
   * by default — the block measured 156 px on a phone, more than two message rows, for settings a
   * user changes about as often as they change their signature.
   */
  readonly viewOptionsOpen?: boolean
  readonly viewOptionsId?: string
}

export function MessageList({
  mailboxId,
  search,
  activeLabel,
  viewOptionsOpen = false,
  viewOptionsId,
}: MessageListProps) {
  const { t } = useTranslation()
  const route = useRoute()
  const navigate = useNavigate()
  const { db, accountId } = useReplica()
  const config = useConfig()
  const gridId = useId()
  const rowDomId = useCallback((id: Id) => `${gridId}-r-${id}`, [gridId])

  const sort = useLocalPref<MessageSort>('list.sort') ?? 'date'
  const density = useLocalPref<Density>('list.density') ?? 'comfortable'
  const unreadFirst = useLocalPref<boolean>('list.unreadFirst') ?? false
  const flat = useLocalPref<boolean>('list.flat') ?? false
  const setPrefValue = useCallback(
    (key: string, value: unknown) => void setPref(db, accountId, key, value),
    [db, accountId],
  )

  const source = useMemo<ListSource | undefined>(
    () =>
      search
        ? { kind: 'search', spec: search.spec }
        : mailboxId !== undefined
          ? { kind: 'folder', mailboxId }
          : undefined,
    [search, mailboxId],
  )
  const {
    key: windowKey,
    ids,
    total,
    loading,
    loadMore,
  } = useMessageList(source, sort, {
    unreadFirst,
    flat,
  })
  // Warm the texts of the visible window so opening a message does not wait for the network (M5.16).
  // Off when the reader turns it off; bounded and yielding — see `use-prefetch-bodies.ts`.
  usePrefetchBodies(ids)
  const actions = useMessageActions()
  // The list's own move picker (`v`, and the bulk bar's Move) dispatches through the same triage seam
  // the chords use, so it gets the undo toast rather than a bare `actions.move`.
  const triage = useTriage()
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Selection, roving focus and the label-picker request live in the hoisted list store (M3.8), so the
  // keyboard layer and the command palette can drive the list from outside this component. The
  // selection MODEL is unchanged — the store wraps the same pure `selectionReducer`.
  const selection = useListStore((state) => state.selection)
  const focusIndex = useListStore((state) => state.focusIndex)
  const labelTargets = useListStore((state) => state.labelTargets)
  const moveTargets = useListStore((state) => state.moveTargets)
  const dispatchSelection = useListStore((state) => state.select)
  const focusIndexTo = useListStore((state) => state.focusIndexTo)
  const requestLabels = useListStore((state) => state.requestLabels)
  const requestMove = useListStore((state) => state.requestMove)
  const setWindow = useListStore((state) => state.setWindow)
  const setGridHandle = useListStore((state) => state.setGridHandle)

  // The move source: a cross-folder search has none (moves are gated off), a folder view is itself.
  const sourceMailboxId = search ? (search.scopeMailboxId ?? null) : (mailboxId ?? null)

  // What an EMPTY list means, which is not always "this folder is empty".
  //
  // The replica holds a recent window — `backfill.ts` queries `inMailbox AND receivedAt >= now −
  // offline.cacheDays` — so a folder full of older mail produces an empty window and used to render
  // "No messages in this folder." while the sidebar beside it showed the folder's real unread count.
  // Two parts of the same screen contradicting each other, with no way for the user to tell which
  // was lying or why. Found by the 100 k perf fixture (M4.8), where the whole corpus sat outside the
  // window and the app reported an empty folder against a server answering 100 000.
  const openMailbox = useMailbox(sourceMailboxId ?? '')
  const outsideWindow =
    !search && openMailbox !== undefined && openMailbox.totalEmails > 0 && ids.length === 0
  /*
   * A LABEL with nothing in it is not a search with no matches.
   *
   * Browsing a label runs through the same `search` prop as a typed query (see `MailScreen`'s
   * `effectiveSearch`), so this branch used to tell someone who clicked a label in the sidebar:
   * "No messages match your search. Try all mailboxes, or fewer words." They had searched for
   * nothing and were being advised to search differently.
   */
  const emptyMessage =
    activeLabel !== undefined
      ? t('labels.noMessages')
      : search
        ? t('search.results.empty')
        : outsideWindow
          ? t('list.emptyOutsideWindow', { count: config.offline.cacheDays })
          : t('list.empty')

  // Publish the window. A new key (mailbox/sort/search changed) resets focus + selection in the store.
  useEffect(() => {
    setWindow(windowKey, ids, sourceMailboxId)
  }, [windowKey, ids, sourceMailboxId, setWindow])

  // Swipe actions (FR-LST-06). ONE mailbox query, deliberately, not two `useMailboxByRole` calls:
  // those are two independent liveQueries that can resolve on different ticks, so a direction could
  // resolve against a half-landed account. Until G2/B3 that was DANGEROUS: "archive, else Trash"
  // read across a tick where only Trash had landed trashed mail that belonged in Archive, which is
  // also why the choice was never driven off `triage.archive()`'s boolean (`false` there likewise
  // means "not resolved yet", see `Triage.archive`). B3 removed that fallback, so a mis-read now
  // costs an inert gesture rather than a wrong mailbox, and the `rolesReady` guard in `resolveSwipe`
  // is strictly speaking redundant — an unresolved query leaves the target `undefined`, which that
  // function already refuses. It stays because it states the intent the target lookup only implies:
  // until this one query resolves the move directions are inert BY DECISION, not by accident.
  const mailboxes = useMailboxes()
  const rolesReady = mailboxes !== undefined
  const archiveId = mailboxes?.find((box) => box.role === 'archive')?.id
  const trashId = mailboxes?.find((box) => box.role === 'trash')?.id
  const accountReadOnly = useAccountIsReadOnly()
  /**
   * The per-ROW rights verdict (B34), computed rather than subscribed: both inputs are already here,
   * and a gesture has to decide synchronously for the row under the finger.
   */
  const rowRights = useCallback(
    (row: EmailRow | undefined) =>
      messageRights({ rows: [row], total: 1, mailboxes, accountReadOnly }),
    [mailboxes, accountReadOnly],
  )
  const swipeLeftAction = useSwipeLeft()
  const swipeRightAction = useSwipeRight()

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: OVERSCAN,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row height changes.
  useEffect(() => virtualizer.measure(), [density, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const visibleIds = useMemo(
    () => virtualItems.map((item) => ids[item.index]).filter((id): id is Id => id !== undefined),
    [virtualItems, ids],
  )
  const rows = useEmailWindow(visibleIds)
  // Key hydration by the row's OWN id, not window position — a lagging liveQuery result must never
  // paint a neighbour's email onto the wrong row while scrolling.
  const rowById = useMemo(() => {
    const map = new Map<string, EmailRow>()
    for (const row of rows ?? []) if (row) map.set(row.id, row)
    return map
  }, [rows])

  // What a direction means ON THIS ROW, or `null` for "nothing" — which the gesture treats as
  // genuinely inert: the row does not follow the finger that way and no colour is revealed, so a
  // suppressed direction never promises an action it will not perform. Also called at RENDER time
  // to build the reveal layers, so the strip under the finger and the action on lift cannot drift.
  const resolveSwipe = useCallback(
    (id: Id, direction: 'left' | 'right'): ResolvedRowSwipe | null => {
      // A skeleton row is a live `role="row"` with nothing to act on — the same gate `draggable`
      // applies.
      const row = rowById.get(id)
      if (row === undefined) return null
      const action = direction === 'left' ? swipeLeftAction : swipeRightAction
      if (action === 'none') return null
      // B34: a denied gesture goes INERT — no reveal, no colour, nothing promised before the finger
      // lifts. That is the right refusal here precisely because there is nowhere under a thumb to
      // put an explanation; the bulk bar and the reading pane carry it instead.
      const rights = rowRights(row)
      // Toggle, not "mark read": the gesture stays useful on a row that is already read, and it is
      // the same rule `triage.flag` follows. Read from the row's state at THIS moment.
      if (action === 'read') {
        if (rights.reason('seen') !== null) return null
        return { kind: 'read', seen: row.keywords.$seen !== true }
      }
      // A move needs a source: with `from: null` the message keeps its other memberships (a copy,
      // not a move) and gets no Undo, so a cross-folder search result cannot be swiped away.
      if (!rolesReady || sourceMailboxId === null) return null
      // A direction configured "Archive" resolves to Archive or to NOTHING. Until G2/B3 it fell back
      // to Trash on an account with no Archive role (the reversal is recorded in `swipe-prefs.ts`):
      // a gesture the user chose as "Archive" must never be the thing that puts mail in the bin —
      // there is no confirmation under a thumb, and the strip the finger revealed said "Archive".
      // The direction goes inert instead, which is the same answer `e` now gives out loud on this
      // very list ("this account has no Archive folder").
      const target = action === 'archive' ? archiveId : trashId
      // Suppressed when the target IS the folder on screen — Trash inside Trash, Archive inside
      // Archive. A self-move has no legitimate meaning downstream (it patches the mail out of the
      // only mailbox it is in), and the seam refuses it anyway; this keeps the gesture honest about
      // it instead of revealing a colour and doing nothing.
      if (target === undefined || target === sourceMailboxId) return null
      if (rights.moveReason(sourceMailboxId, target) !== null) return null
      // The source travels WITH the decision — see {@link ResolvedRowSwipe}. Everything else the move
      // needs is re-derived at commit; this one value cannot be, because by then it may have changed.
      return { kind: action, from: sourceMailboxId }
    },
    [
      rowById,
      swipeLeftAction,
      swipeRightAction,
      rolesReady,
      archiveId,
      trashId,
      sourceMailboxId,
      rowRights,
    ],
  )

  const commitSwipe = useCallback(
    (id: Id, resolved: ResolvedRowSwipe): void => {
      // Deliberately NOT `runMove`: that acts on the selection and advances the reading pane. A
      // swipe acts on the row under the finger alone, and leaves the reading pane be.
      if (resolved.kind === 'read') {
        triage.setSeen([id], resolved.seen === true)
        return
      }
      // The gesture must still be about the folder it started in. Anything else is the tablet
      // two-finger case in {@link ResolvedRowSwipe}: a move `from` a mailbox this message was never
      // in patches nothing away and leaves it filed in two places at once.
      if (resolved.from === undefined || resolved.from !== sourceMailboxId) return
      // The NAMED seam, not `actions.move` and not `moveTo`, so the move gets the role's own Undo
      // toast — the affordance a gesture needs most, since there is nothing to un-click.
      const moved =
        resolved.kind === 'archive'
          ? triage.archive([id], resolved.from)
          : triage.trash([id], resolved.from)
      // The boolean answers exactly one question: did the row really leave this folder? It can only
      // be `false` here because `useTriage` resolves the role through its OWN liveQueries, so those
      // lagged behind the `useMailboxes()` above at the instant of the lift — `resolve` re-checked
      // every other condition the seam refuses on (mailbox known, target ≠ source, non-empty set) at
      // the axis lock. Then the row snapped back, nothing happened, and it must stay as it was.
      if (!moved) return
      // A move takes the row OUT of this folder, so it has to leave the selection with it. Every
      // other move path prunes (`runMove` clears, the move picker clears, a drag moves the whole
      // selection); leaving a swiped row behind is not an untidy checkbox but a data-integrity bug.
      // The bulk bar keeps counting it, and the next bulk Trash patches `mailboxIds/<trash>: true`
      // onto a message whose `mailboxIds/<inbox>` removal is a no-op — filed in Archive AND Trash.
      //
      // Just this id, never `clear`: a swipe acts on the row under the finger, not on the selection,
      // and the other ticked rows are still exactly where the user left them. `toggle` is the
      // reducer's only single-id removal, hence the guard — unguarded it would ADD an unselected row.
      // Read from the store, not from this render's `selection`, so a lift that lands between a
      // checkbox click and its re-render cannot decide against a stale set.
      if (useListStore.getState().selection.selected.has(id))
        dispatchSelection({ type: 'toggle', id })
    },
    [triage, sourceMailboxId, dispatchSelection],
  )

  const swipe = useRowSwipe({
    resolve: resolveSwipe,
    commit: commitSwipe,
    swipingClassName: SWIPING_CLASS,
  })

  // Registry name+color per keyword, so each row can render its label swatches without subscribing.
  const labels = useLabels()
  const labelLookup = useMemo(() => {
    const map = new Map<string, RowLabel>()
    for (const label of labels ?? [])
      map.set(label.keyword, { name: label.name, color: label.color })
    return map
  }, [labels])

  // The `l` shortcut opens a label picker for the selection / focused row, anchored to the container.
  // The chord itself now lives in the shortcut registry; this component only renders what it requests.
  const containerRef = useRef<HTMLDivElement>(null)

  // Highlighted (`<mark>`) subject/preview for the visible slice — search only (M3.1).
  const highlights = useSnippets(search?.spec.filter, visibleIds)

  // Infinite scroll: page more when the tail comes into view and the window is not yet complete.
  // Guarded so one page-request per window size cannot fire repeatedly while scrolling the tail.
  const lastIndex = virtualItems.at(-1)?.index ?? 0
  const requestedAtRef = useRef(-1)
  useEffect(() => {
    if (
      ids.length > 0 &&
      lastIndex >= ids.length - OVERSCAN &&
      ids.length < (total ?? Number.POSITIVE_INFINITY) &&
      requestedAtRef.current !== ids.length
    ) {
      requestedAtRef.current = ids.length
      loadMore()
    }
  }, [lastIndex, ids.length, total, loadMore])

  const draftOpener = useDraftOpener()
  const open = useCallback(
    (id: Id, options: { readonly full?: boolean } = {}) => {
      // Opening a message makes IT the subject: drop any leftover selection. `targetIds` puts the
      // selection first, so without this an `e` in the reading pane would archive a message that is
      // no longer on screen (on a narrow viewport the list is not even rendered) instead of the one
      // the user is looking at.
      dispatchSelection({ type: 'clear' })
      // A draft opens back into the composer instead of the reader (FR-CMP-03).
      if (rowById.get(id)?.keywords.$draft === true) {
        void draftOpener.open(id)
        return
      }
      const row = rowById.get(id)
      // Resolve the mailbox to file the URL under. With a folder context, a cross-folder result
      // (scope=all / in:<other>) may not live in the current folder — use a mailbox the message is
      // actually in, else the route folder. With NO folder context (a label/all view), there is no
      // route folder, so use the row's own mailbox. Preserve `?q=`/`?label=` so the results list stays.
      const targetMailbox =
        mailboxId !== undefined
          ? row !== undefined && !row.mailboxIds[mailboxId]
            ? (Object.keys(row.mailboxIds)[0] ?? mailboxId)
            : mailboxId
          : row !== undefined
            ? Object.keys(row.mailboxIds)[0]
            : undefined
      if (targetMailbox === undefined) return
      // Stamped, so the reading pane's Back button can pop this entry instead of pushing a third
      // one on top of it (see READING_HISTORY_MARK).
      navigate(
        mailHrefKeepingQuery(route.search, targetMailbox, id, { full: options.full === true }),
        {
          state: { waxwing: READING_HISTORY_MARK },
        },
      )
    },
    [mailboxId, navigate, rowById, draftOpener, route.search, dispatchSelection],
  )

  // Move the roving position (keyboard) — scroll the target into view; the grid keeps DOM focus and
  // just repoints aria-activedescendant, so a row unmounting can never drop focus to <body>.
  const moveTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, ids.length - 1))
      focusIndexTo(clamped)
      virtualizer.scrollToIndex(clamped, { align: 'auto' })
    },
    [ids.length, virtualizer, focusIndexTo],
  )

  // Lend the store the two imperative moves only the MOUNTED list can make (scroll a virtualized row
  // into view; return DOM focus to the grid) plus `open`, so `j`/`k`/`o` behave exactly like a click.
  // The handle is built ONCE and reads the changing `open` through a ref: a fresh handle object every
  // render would write to the store on every render, and the store re-renders this component.
  // `useLayoutEffect`, NOT `useEffect` — B44's sibling (the long version is in `use-swipe.ts`, with
  // the test that pins the mechanism). `gridHandle.open` is called from the shortcut provider's
  // NATIVE `keydown` listener, and a passive effect does not run at commit: React schedules it, and
  // a keystroke can arrive first. In that window `o` would open the row the roving focus was on one
  // render ago. A layout effect runs inside the commit, so it cannot lag the DOM it belongs to.
  const openRef = useRef(open)
  useLayoutEffect(() => {
    openRef.current = open
  }, [open])
  const gridHandle = useMemo<GridHandle>(
    () => ({
      scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'auto' }),
      focus: () => scrollRef.current?.focus(),
      open: (id) => openRef.current(id),
    }),
    [virtualizer],
  )
  useEffect(() => {
    setGridHandle(gridHandle)
    return () => setGridHandle(null)
  }, [gridHandle, setGridHandle])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const id = ids[focusIndex]
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        const dest = Math.min(focusIndex + 1, ids.length - 1)
        const destId = ids[dest]
        if (event.shiftKey && destId !== undefined)
          dispatchSelection({ type: 'range', id: destId, ordered: ids })
        moveTo(dest)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const dest = Math.max(focusIndex - 1, 0)
        const destId = ids[dest]
        if (event.shiftKey && destId !== undefined)
          dispatchSelection({ type: 'range', id: destId, ordered: ids })
        moveTo(dest)
        break
      }
      case 'Home':
        event.preventDefault()
        moveTo(0)
        break
      case 'End':
        event.preventDefault()
        moveTo(ids.length - 1)
        break
      case ' ':
        event.preventDefault()
        if (id !== undefined) dispatchSelection({ type: 'toggle', id })
        break
      case 'Enter':
        event.preventDefault()
        if (id !== undefined) open(id)
        break
      case 'Escape':
        dispatchSelection({ type: 'clear' })
        break
      case 'a':
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          dispatchSelection({ type: 'selectAll', ordered: ids })
        }
        break
      // `l` (label the selection / focused row) is NOT here any more: it is a registry row (M3.8), so
      // the cheat-sheet stays accurate. Only the APG *grid* keys live in this handler.
    }
  }

  if (source === undefined) {
    return <p className={styles.empty}>{t('list.noMailbox')}</p>
  }

  const selectedIds = [...selection.selected]
  const allSelected = ids.length > 0 && selection.selected.size === ids.length
  const someSelected = selection.selected.size > 0 && !allSelected
  const activeId = ids[focusIndex]
  const activeDescendant = activeId !== undefined ? rowDomId(activeId) : undefined
  /**
   * "Empty" and "out of date" are not the same state, and `loading` alone cannot tell them apart: it
   * is true only while the window ROW itself is missing (`use-message-list.ts`), so a window that
   * EXISTS with `ids: []` and a non-zero `total` reads as loaded-and-empty. It is neither — the
   * window says it has mail and holds none of it. This is NOT a closed set — an earlier revision of
   * this comment enumerated "three paths" and a checker found a fourth by reading `delta.ts`. What
   * follows are the paths KNOWN to produce the shape, and the recovery argument is stated so that an
   * unknown fifth does not silently inherit a promise written for these.
   *
   * KNOWN producers, all of which VOID the window (`queryState: null`):
   *   1. a bulk move's OPTIMISTIC prune, which retracts a whole loaded head page (a folder of 200
   *      with a 50-id window leaves `ids: []`, `total: 150`);
   *   2. the ROLLBACK of one from a server REJECTION (`outbox.ts`'s `retractWindows`, whose tail
   *      eviction the undo cannot record);
   *   3. the same rollback reached from a DISCARDED dead letter.
   * Painting the confident empty state in any of these contradicts the `aria-rowcount` rendered
   * beside it and makes the live region announce "no results" for a folder that has some, so this
   * state suppresses them all — and suppresses the shape itself, however it arose, which is why an
   * unenumerated producer still gets the right rendering even where the wording below over-promises.
   *
   * What it does NOT do is claim progress, and the honest statement of WHY is a NETWORK call:
   * `delta.ts`'s `Email/query` (`fullRequery`). Two things reach it, and only the first is a
   * detector: a VOIDED window is re-queried on the next pass, and — independently of voiding —
   * `engine.ts` forces a full pass every `FULL_SWEEP_EVERY` (5) sync passes, with a safety sweep
   * every 60 s under it. There is NO detector for empty-ids-with-non-zero-total anywhere in the
   * engine: a producer that leaves `queryState` NON-null is not recovered by the voiding mechanism
   * at all, only by that periodic sweep, and only online. `delta.ts`'s `applyQueryChanges` is
   * exactly such a producer on paper (it drops `added` entries whose index lands past the shortened
   * `ids`, so a removal of the whole head page can write `ids: []` with a carried-over `total` and a
   * live `queryState`). UNPROVEN against a real server and filed as §13 **B17** — go there rather
   * than re-deriving the argument here.
   *
   * On the three known paths, connectivity is what separates them, and none of them is guaranteed
   * prompt. A rejection IS a server answer, so path 2 proves we were online at ROLLBACK time — not
   * at RECOVERY time: the connection can drop in between, and on the replay path (`reconcileWatched`
   * with `onlyVoided`, which is the one a rollback's re-query takes) `engine.ts` re-voids and DEFERS
   * rather than writing the answer whenever `pendingOutbox` is non-empty, so during a triage burst
   * the re-query is not immediate either. Paths 1 and 3 have no guarantee at
   * all. The optimistic prune runs offline by design; and the rollback has an offline arm —
   * `discardFailed` (`engine.ts`) runs an OWED undo with NO connectivity check, reached from
   * `use-outbox-problems.ts`, `replayOutbox`'s `online === false` bail does not cover it, and
   * `applyUndo`'s `mailboxIds` arm is a purely LOCAL transaction, so offline it does not fail, it
   * SUCCEEDS and retracts the window right there. Discard a dead letter offline and the state
   * persists until the connection returns: nothing is retrying, `loadMore` is gated on
   * `ids.length > 0` and will not rescue it either. Nothing here can tell the paths apart, so this
   * message is written for the reconnect-bound ones — the same limitation already recorded for B2's
   * arrival direction. Hence its own message
   * (`list.stale`) rather than the spinner's "Loading messages": it names the CONDITION (out of
   * date, refreshing on the next sync) instead of claiming progress that, offline, is not happening.
   * `outbox.ts`'s `retractWindows` / `invalidateWindows` docs carry the other half of this and hedge
   * the same way ("USUALLY that is immediate"); the two halves reference each other on purpose, so
   * correct both or neither.
   *
   * Only this INCOHERENT combination is caught. `total === 0` and an unknown `total` (a persisted
   * `null`, which `use-message-list.ts` surfaces as `undefined`) are the genuine empty cases and
   * still say so out loud — a swallowed empty state would be the worse bug.
   */
  const retracted = ids.length === 0 && total !== undefined && total > 0
  const resolving = loading || retracted

  const barOpen = selection.selected.size > 0 || viewOptionsOpen

  return (
    <div className={styles.container} ref={containerRef}>
      {/*
        The bar OPENS rather than appearing. Selecting the first row mounted a 44px bar above the
        list and pushed every row down by it — including the one the pointer had just landed on,
        which is the row the reader is looking at. A grid whose single track goes 0fr → 1fr is a
        pure-CSS disclosure: no JS, no measurement, and the reduced-motion reset collapses it like
        everything else.
      */}
      <div className={`${styles.barSlot}${barOpen ? ` ${styles.barSlotOpen}` : ''}`}>
        <div className={styles.barSlotInner}>
          {selection.selected.size > 0 ? (
            <BulkBar
              count={selection.selected.size}
              ids={selectedIds}
              activeLabel={activeLabel}
              fromMailbox={sourceMailboxId ?? undefined}
              allSelected={allSelected}
              someSelected={someSelected}
              actions={actions}
              onSelectAll={() => dispatchSelection({ type: 'selectAll', ordered: ids })}
              onClear={() => dispatchSelection({ type: 'clear' })}
              onRequestDelete={() => setConfirmDelete(true)}
              onRequestMove={() => requestMove(selectedIds)}
            />
          ) : viewOptionsOpen ? (
            <Toolbar
              id={viewOptionsId}
              sort={sort}
              unreadFirst={unreadFirst}
              flat={flat}
              // Sort / threading / unread-first are folder-window options; the search seam cannot
              // honour them (see {@link ToolbarProps.viewOptionsApply}). Keyed off `search`, not off
              // `mailboxId`: a scope=folder search has a mailbox AND goes through the search seam.
              viewOptionsApply={search === undefined}
              onChange={setPrefValue}
            />
          ) : null}
        </div>
      </div>

      {/*
        One node, two presentations. The hit count used to be announced and never SHOWN, so a
        sighted user had no way to tell "these are all the matches" from "the list is still filling
        in" — while the identical information was already being spoken. It is now visible whenever
        there is a count to give.

        The empty case stays visually hidden because the list renders its own empty state right
        below; showing both would say the same sentence twice on one screen. Keeping it in the SAME
        live region matters — a second region would announce the transition twice.
      */}
      {search && (
        <p
          className={ids.length === 0 ? styles.resultCountHidden : styles.resultCount}
          aria-live="polite"
        >
          {resolving
            ? ''
            : ids.length === 0
              ? t('search.results.empty')
              : t('search.results.count', { count: total ?? ids.length })}
        </p>
      )}

      {/* Outside the grid on purpose: `role="grid"` owes its accessible tree rows, and this note is
          not one. It sits where the empty state would, because that is the claim it replaces. */}
      {retracted && <p className={styles.empty}>{t('list.stale')}</p>}

      {ids.length === 0 && !resolving ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        <div
          ref={scrollRef}
          className={styles.scroll}
          role="grid"
          tabIndex={0}
          aria-multiselectable="true"
          aria-label={t('shell.list.title')}
          aria-rowcount={total ?? ids.length}
          aria-activedescendant={activeDescendant}
          onKeyDown={onKeyDown}
        >
          {loading && ids.length === 0 && (
            <>
              {/*
                Skeleton ROWS, not a spinner in an empty pane.
                Changing folder used to blank the list and centre a spinner in the void, so the eye
                lost the structure it had just been reading and had to find it again when the mail
                arrived. Apple Mail and Bulwark both hold the row grid. These are the same skeletons
                a not-yet-loaded row already renders, at the same `ROW_HEIGHT` the virtualizer uses,
                so the layout does not move by a pixel when the real rows replace them.
                Hidden from assistive tech, which is told what is happening in one sentence instead.
              */}
              <div role="presentation" aria-hidden="true" className={styles.skeletonList}>
                {SKELETON_KEYS.map((key, index) => (
                  <div
                    key={key}
                    role="presentation"
                    className={styles.rowWrap}
                    style={{ height: ROW_HEIGHT[density] }}
                  >
                    <MessageRow
                      id={`skeleton-${index}`}
                      rowIndex={index + 1}
                      email={undefined}
                      selected={false}
                      active={false}
                      focused={false}
                      density={density}
                      labels={labelLookup}
                      onOpen={noop}
                      onOpenFull={noop}
                      onSelectToggle={noop}
                      onSelectRange={noop}
                      onActivate={noop}
                    />
                  </div>
                ))}
              </div>
              <VisuallyHidden>
                <span role="status">{t('list.loading')}</span>
              </VisuallyHidden>
            </>
          )}
          <div
            role="presentation"
            className={styles.spacer}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const id = ids[item.index]
              if (id === undefined) return null
              return (
                // Drag (mouse) and swipe (touch) are both pointer-only affordances on this
                // presentational wrapper; the non-pointer equivalent WCAG SC 2.5.7 requires is the
                // row checkbox plus the bulk bar (and `v` / `e` from the keyboard).
                // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only drag+swipe; the checkbox/bulk-bar and keyboard paths are the a11y route.
                <div
                  key={id}
                  role="presentation"
                  className={styles.rowWrap}
                  style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                  // The drag lives on the WRAPPER, not on MessageRow: this is the only node holding
                  // the id, the selection and the store in closure, so the row stays presentational.
                  // Both gates are load-bearing. A skeleton row (`email === undefined`) is a live
                  // `role="row"` with nothing to move; and without a source mailbox `move` keeps the
                  // other memberships — a copy, not a move — which is the same gate `canMove` and the
                  // `v` chord already apply.
                  draggable={
                    rowById.get(id) !== undefined &&
                    sourceMailboxId !== null &&
                    // B34: same reasoning as the swipe — a drag that cannot be dropped promises
                    // something it cannot keep, and there is no room on a dragged row to say why.
                    // SC 2.5.7's pointer alternative is the bulk bar's Move button, which DOES
                    // explain itself.
                    rowRights(rowById.get(id)).removeReason(sourceMailboxId) === null
                  }
                  onPointerDown={swipe.onPointerDown(id)}
                  onDragStart={(event) => {
                    // ADR-012 (amended): a long-press on `draggable="true"` really does start an
                    // HTML5 drag on touch — Chrome-on-Android since 100 (kTouchDragAndDrop), iOS
                    // Safari via UIDragInteraction — so one finger can enter both gestures on this
                    // one node. Both are kept: hold still and the drag wins, move sideways and the
                    // swipe does. Only a swipe that has LOCKED an axis cancels the drag, so a plain
                    // long press is still a drag source. `preventDefault` matters: the bare return
                    // below would leave a drag running with no payload.
                    if (swipe.isSwipeActive()) {
                      event.preventDefault()
                      return
                    }
                    if (sourceMailboxId === null) return
                    const dragged = draggedMessageIds(selection.selected, id)
                    // Dragging a row outside the selection makes IT the subject — the same rule
                    // `open()` applies below, and the opposite of `targetIds`' selection-first one.
                    if (!selection.selected.has(id)) dispatchSelection({ type: 'selectOne', id })
                    setActiveDrag({
                      kind: 'messages',
                      accountId,
                      ids: dragged,
                      from: sourceMailboxId,
                    })
                    // The value is unreadable until `drop`; the TYPE is what `dragover` may consult.
                    event.dataTransfer.setData(MESSAGES_MIME, dragged.join(','))
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  // Not the drop site's job alone: a drag cancelled with Escape never drops.
                  onDragEnd={() => clearActiveDrag()}
                >
                  {/* The colour a swipe uncovers, one layer per direction that does something on
                      this row. SIBLINGS of MessageRow, never a wrapper around it: the grid is
                      `role="grid"` → `role="row"` and the drag tests reach this node through the
                      row's `parentElement`. Decorative, so `aria-hidden` and no role. */}
                  <SwipeLayer side="left" resolved={resolveSwipe(id, 'left')} />
                  <SwipeLayer side="right" resolved={resolveSwipe(id, 'right')} />
                  <MessageRow
                    id={rowDomId(id)}
                    rowIndex={item.index + 1}
                    email={rowById.get(id)}
                    selected={selection.selected.has(id)}
                    active={id === route.params.emailId}
                    focused={item.index === focusIndex}
                    density={density}
                    labels={labelLookup}
                    highlight={highlights.get(id)}
                    onOpen={() => open(id)}
                    onOpenFull={() => open(id, { full: true })}
                    onSelectToggle={() => dispatchSelection({ type: 'toggle', id })}
                    onSelectRange={() => dispatchSelection({ type: 'range', id, ordered: ids })}
                    onActivate={() => {
                      focusIndexTo(item.index)
                      scrollRef.current?.focus()
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
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
                  actions.destroy(selectedIds)
                  dispatchSelection({ type: 'clear' })
                  setConfirmDelete(false)
                }}
              >
                {t('list.actions.delete')}
              </Button>
            </>
          }
        >
          {/* The count alone ("3 selected") restates the bulk bar; it is not a warning, and this is
              an irreversible action reached from an icon-only button. Say what it does — the same
              thing `reading.confirmDeleteBody` says for the single-message destroy. */}
          <p>{t('list.confirmDeleteBody', { count: selection.selected.size })}</p>
        </Dialog>
      )}

      {labelTargets !== null && (
        <LabelMenu ids={labelTargets} anchorRef={scrollRef} onClose={() => requestLabels(null)} />
      )}

      {/* `sourceMailboxId !== null` is the same gate the bulk bar's `canMove` applies: without a
          source, `move` keeps the other memberships — a copy, not the move this dialog offers. */}
      {moveTargets !== null && sourceMailboxId !== null && (
        <MoveDialog
          open
          currentMailboxId={sourceMailboxId}
          onClose={() => requestMove(null)}
          onMove={(target, label) => {
            triage.moveTo(moveTargets, sourceMailboxId, target, label)
            requestMove(null)
            // The moved mail leaves the folder, so it must leave the selection too — otherwise a
            // follow-up action runs against a stale `from`.
            dispatchSelection({ type: 'clear' })
          }}
        />
      )}
    </div>
  )
}

interface SwipeLayerProps {
  readonly side: 'left' | 'right'
  /** What this direction does on this row; `null` renders nothing — the direction is inert. */
  readonly resolved: ResolvedSwipe | null
}

/**
 * The strip a swipe uncovers. It is clamped to the width the row has vacated rather than sitting
 * BEHIND the row: `.row` paints no background of its own (only `:hover`/`.selected`/`aria-current`
 * do), so a full-width layer underneath would show straight through an untouched row.
 *
 * Icon AND text, never colour alone — the design system forbids encoding meaning in motion or
 * colour alone, and the two moves additionally land an Undo toast in a live region.
 */
function SwipeLayer({ side, resolved }: SwipeLayerProps) {
  const { t } = useTranslation()
  if (resolved === null) return null
  const seen = resolved.seen === true
  const tone =
    resolved.kind === 'archive'
      ? styles.actionArchive
      : resolved.kind === 'trash'
        ? styles.actionTrash
        : styles.actionRead
  const label =
    resolved.kind === 'archive'
      ? t('list.actions.archive')
      : resolved.kind === 'trash'
        ? t('list.actions.trash')
        : seen
          ? t('list.actions.read')
          : t('list.actions.unread')
  return (
    <div
      aria-hidden="true"
      className={`${styles.actionLayer} ${side === 'left' ? styles.actionLeft : styles.actionRight} ${tone}`}
    >
      <span className={styles.actionContent}>
        {resolved.kind === 'archive' ? (
          <Archive className={styles.actionIcon} />
        ) : resolved.kind === 'trash' ? (
          <Trash2 className={styles.actionIcon} />
        ) : seen ? (
          <MailOpen className={styles.actionIcon} />
        ) : (
          <Mail className={styles.actionIcon} />
        )}
        <span>{label}</span>
      </span>
    </div>
  )
}

interface ToolbarProps {
  readonly sort: MessageSort
  readonly unreadFirst: boolean
  readonly flat: boolean
  /**
   * Whether Sort / Conversations / Unread-first can actually change the list on screen.
   *
   * They cannot on the SEARCH seam — search results (M3.1) and label browse (M3.2), which share it.
   * `use-message-list.ts` keys a search off `canonicalQueryKey(spec)` and hands that spec to
   * `watchQuery`; the `sort` argument and the `unreadFirst`/`flat` options are read only on the
   * FOLDER branch, where they build the watched `WindowSpec`. So on a search these three were
   * enabled, wrote their preference, and moved nothing: the control changed, the setting stuck, the
   * list stayed exactly as it was. That reads as a broken app, and it was the worse of the two
   * options — the other being to disable them and say why, which is what this flag does.
   *
   * Making them WORK there is a real option, not a lost cause, but it is not a toolbar change: it
   * means composing the caller's spec with these preferences inside `use-message-list.ts` (a file
   * this component does not own), and `collapseThreads` in particular reverses a documented M3.1
   * decision — search deliberately shows each MATCHING message rather than a thread anchor, which is
   * also what the `<mark>` snippets in each row are highlighting. Filed rather than guessed at.
   *
   * (Density used to sit here too and was NOT gated by this, being pure presentation. It has moved
   * out entirely — Settings → Appearance already offered the same control writing the same
   * `list.density` key, so the toolbar copy was a second door onto one room.)
   */
  readonly viewOptionsApply: boolean
  readonly onChange: (key: string, value: unknown) => void
  /** Target of the disclosure toggle's `aria-controls` (the toggle lives in the pane toolbar). */
  readonly id?: string | undefined
}

function Toolbar({ sort, unreadFirst, flat, viewOptionsApply, onChange, id }: ToolbarProps) {
  const { t } = useTranslation()
  const sortId = useId()
  const viewId = useId()
  const reasonId = useId()
  /**
   * One gate for both halves of the promise. `disabled` makes the control inoperable — and in a
   * browser that alone stops the write, since a disabled control fires no change event — while this
   * covers the write on any other dispatch path. The preference is the half that PERSISTS: a
   * setting silently recorded from a view where the user could not see it take effect is the same
   * defect one step later, when they return to a folder and find their sort changed.
   */
  const change = (key: string, value: unknown): void => {
    if (!viewOptionsApply) return
    onChange(key, value)
  }
  // Only set when there is something to point at, so a folder view carries no dangling reference.
  const describedBy = viewOptionsApply ? undefined : reasonId
  return (
    <div className={styles.toolbar} id={id}>
      <div className={styles.control}>
        <label htmlFor={sortId} className={styles.controlLabel}>
          {t('list.sort.label')}
        </label>
        <Select
          id={sortId}
          value={sort}
          disabled={!viewOptionsApply}
          aria-describedby={describedBy}
          onChange={(event) => change('list.sort', event.target.value)}
        >
          {/* Received and sent date next to each other, then the two address keys, then subject
              and size — the order Apple Mail's own sort menu uses, and the order someone scanning
              the list expects to find them in. */}
          <option value="date">{t('list.sort.date')}</option>
          <option value="sentAt">{t('list.sort.sentAt')}</option>
          <option value="from">{t('list.sort.from')}</option>
          <option value="to">{t('list.sort.to')}</option>
          <option value="subject">{t('list.sort.subject')}</option>
          <option value="size">{t('list.sort.size')}</option>
        </Select>
      </div>
      <div className={styles.control}>
        {/* `list.view.label`, not `list.view.threaded` — the label used to be the same string as the
            selected option, so the control read "Konversationen [Konversationen]" and gave the user
            no way to tell a category from a state. */}
        <label htmlFor={viewId} className={styles.controlLabel}>
          {t('list.view.label')}
        </label>
        <Select
          id={viewId}
          value={flat ? 'flat' : 'threaded'}
          disabled={!viewOptionsApply}
          aria-describedby={describedBy}
          onChange={(event) => change('list.flat', event.target.value === 'flat')}
        >
          <option value="threaded">{t('list.view.threaded')}</option>
          <option value="flat">{t('list.view.flat')}</option>
        </Select>
      </div>
      <Checkbox
        label={t('list.sort.unreadFirst')}
        checked={unreadFirst}
        disabled={!viewOptionsApply}
        aria-describedby={describedBy}
        onChange={(event) => change('list.unreadFirst', event.target.checked)}
      />
      {/* Visible, not a tooltip: a `title` on a disabled control is unreachable by keyboard and
          unreliable on touch, and this has to reach the user who just found three dead controls. */}
      {!viewOptionsApply && (
        <p id={reasonId} className={styles.toolbarNote}>
          {t('list.viewOptionsUnavailable')}
        </p>
      )}
    </div>
  )
}

interface BulkBarProps {
  readonly count: number
  readonly ids: Id[]
  /** The active label keyword when in a label view (M3.2) — enables "Remove from this label". */
  readonly activeLabel: string | undefined
  /** The source mailbox for folder-move actions; `undefined` in an all-mailboxes search (moves gated). */
  readonly fromMailbox: Id | undefined
  readonly allSelected: boolean
  readonly someSelected: boolean
  readonly actions: ReturnType<typeof useMessageActions>
  readonly onSelectAll: () => void
  readonly onClear: () => void
  readonly onRequestDelete: () => void
  readonly onRequestMove: () => void
}

/**
 * One control in the bulk bar, as data rather than as JSX.
 *
 * The same shape `MessageView`'s action bar uses, and for the same reason: a bar that renders a
 * fixed list of elements cannot hand its tail to a menu, and this one needed to. Measured at both
 * widths the app ships for, seven controls in a 420px list column came to 443px — "Move to…" sat
 * 11px outside its own container on the desktop AND the tablet, reachable only by horizontally
 * scrolling a bar that gives no sign it scrolls. `useActionOverflow` already existed for exactly
 * this; the bulk bar was simply never given it.
 *
 * `when` rather than a conditional in the list: every entry is written once, and the gate that
 * decides whether the reader may use it stays beside the action it gates.
 */
interface BulkAction {
  readonly id: string
  readonly when: boolean
  readonly label: string
  readonly icon: LucideIcon
  readonly onSelect: () => void
  readonly unavailableReason?: string | undefined
  readonly destructive?: boolean
  readonly iconClassName?: string | undefined
  /** Opens the label picker instead of acting; needs the anchor and aria state. */
  readonly popover?: boolean
}

function BulkBar({
  count,
  ids,
  activeLabel,
  fromMailbox,
  allSelected,
  someSelected,
  actions,
  onSelectAll,
  onClear,
  onRequestDelete,
  onRequestMove,
}: BulkBarProps) {
  const { t } = useTranslation()
  // The SAME seam the `e`/`#`/`!` chords use (M3.8) — so a click and a keystroke are one action, and
  // both get the undo toast.
  const triage = useTriage()
  const archive = useMailboxByRole('archive')
  const junk = useMailboxByRole('junk')
  const trash = useMailboxByRole('trash')

  /**
   * The two toggle predicates, hydrated from the SELECTION's own rows.
   *
   * Deliberately NOT from the list's `rowById`, which the read button used to read: that map holds
   * the VIRTUAL WINDOW only, while select-all dispatches over the whole window. Select all, scroll,
   * and every off-screen selected row resolves to `undefined` there — the predicate reads false even
   * when every message qualifies, so the button SETS what the `s` chord would CLEAR.
   *
   * Parity is with `s` ONLY, and it is worth being exact about that. `s` (`registry.ts`,
   * `triage.flag`) is a toggle and therefore hydrates the same predicate from the full target set —
   * `targetsAllFlagged` in `use-shortcut-context.ts`, which is this guard shape line for line, so
   * the two can drift and the shared shape is what stops them. `u` (`triage.unread`) is NOT a
   * partner: it is an unconditional `setSeen(targetIds, false)` with no predicate behind it, so it
   * hydrates nothing and cannot drift from anything. It is named here only because the read button
   * is the surface a user would expect it to agree with.
   *
   * The shape itself: a result that has not caught up with `ids` is not trusted, and an unhydrated
   * row never counts as qualifying (the safe way round — the button then offers to set, and setting
   * a keyword a message already carries is harmless).
   *
   * TRADE-OFF, named here rather than left to be rediscovered as "B9 did not fully fix the drift":
   * this is the THIRD live subscription over this selection. The list's own is
   * `useEmailWindow(visibleIds)` — the VIRTUAL WINDOW, a different id-set from this one — and
   * `use-shortcut-context.ts` already runs `useEmailWindow(targetIds)` over exactly the set this bar
   * holds, and already derives the finished predicate as `targetsAllFlagged`. Three independent
   * subscriptions resolve on their own ticks. This one is not deduped against the shortcut
   * context's: `useShortcutContext` is consumed only by `ShortcutProvider`, so sharing its result
   * means hoisting it (store or context) — plumbing that belongs to plan row B10, which is where the
   * next reader should go rather than rediscovering this.
   *
   * The cost meanwhile is bounded (the selection, and this bar only mounts when there is one), it
   * converges, and every side reads the same table, so the worst transient is a label one tick
   * behind — which the `selectedRows.length === ids.length` guard above turns into the SAFE label
   * ("set") rather than a wrong one. It is never a dispatch against stale data: the click reads
   * exactly the value the label was rendered from.
   */
  const selectedRows = useEmailWindow(ids)
  // B34, over exactly those rows: no new subscription, and the verdict is per-selection rather than
  // the account floor — a selection spanning a writable and a read-only folder refuses as a whole,
  // because a partly-applied bulk action is precisely what nothing can report (B32).
  const rights = useMessageRightsFor(selectedRows, ids.length)
  /** A refusal key as the finished sentence a control announces; `undefined` = allowed. */
  const reasonText = (key: string | null): string | undefined => (key === null ? undefined : t(key))
  const allWithKeyword = (keyword: '$seen' | '$flagged'): boolean =>
    // DEFENSIVE, and unreachable today — recorded rather than left to look like coverage. This bar
    // mounts only under `selection.selected.size > 0` and `ids` is that selection, so `ids` is never
    // empty here; deleting this line leaves the suite green. It is kept because the failure it
    // prevents is silent: `[].every(…)` is vacuously TRUE, so an empty `ids` would report every
    // keyword as universally set and render "Unflag"/"Mark unread" over a selection of nothing. The
    // invariant that rules that out lives in a DIFFERENT component (the mount condition above), so
    // the guard is the local statement of it. `use-shortcut-context.ts`'s `targetsAllFlagged` carries
    // the same line and is kept in step with it deliberately — but do NOT read that as "the other one
    // is load-bearing".
    // It is equally inert, by a different route: `targetIds` there genuinely can be empty, yet
    // `targetsAllFlagged` has exactly one consumer, the `run` of `registry.ts`'s `triage.flag` entry,
    // which is gated by its own `enabled: targetIds.length > 0` — the same gate the key dispatcher and
    // ⌘K palette both apply before running anything. So the value is computed on every render with
    // empty targets and no consumer can read it then. BOTH lines are defensive; the shared shape is
    // worth keeping so the two predicates cannot drift, and that is the whole of the argument.
    ids.length > 0 &&
    selectedRows !== undefined &&
    selectedRows.length === ids.length &&
    selectedRows.every((row) => row?.keywords[keyword] === true)
  const allSeen = allWithKeyword('$seen')
  const allFlagged = allWithKeyword('$flagged')

  // Folder-move needs a known source mailbox; an all-mailboxes search selection spans folders, so the
  // move actions are gated off there (read/flag/delete, which need no source, stay). A moved message
  // leaves the folder → it must leave the selection too, or a follow-up move uses a stale `from`.
  const canMove = fromMailbox !== undefined
  /**
   * …and the target must not BE the mailbox on screen. `useTriage` refuses that move (its patch would
   * take the mail out of the only mailbox it is in), so an Archive button offered while viewing
   * Archive dispatched nothing, said nothing — and cleared the selection anyway. That is the exact
   * anti-pattern the `e` fix (6da2350) exists to kill, one surface over. {@link MoveDialog} expresses
   * the same rule by leaving the current mailbox out of its list; here it leaves the button out of
   * the bar, which is how this bar already treats a role the account does not have at all.
   */
  const canMoveTo = (target: Id | undefined): boolean =>
    canMove && target !== undefined && target !== fromMailbox
  /**
   * Standing IN the Trash — where "delete" means destroy, and where "Move to Trash" is meaningless
   * anyway (`canMoveTo(trash?.id)` is already false for it). The same shape the other two surfaces
   * carry under the same name, each over its own notion of "the folder this acts in":
   * `MessageView`'s is the mailbox the open message is being READ in, and
   * `use-shortcut-context.ts`'s (which the `#` chord consults) is the shortcut target's source; this
   * one is the bar's `fromMailbox`. A source-less selection (cross-folder search) is deliberately
   * NOT in Trash by this test: it spans folders, so there is no single folder whose rules apply.
   *
   * JUNK is deliberately not in this test either, and this is the line an editor would change to add
   * it — read the destructive button's comment below first. `FolderTree`'s `olderMode` DOES group
   * junk with trash; it governs folder-level purges, which this bar does not perform.
   */
  const inTrash = trash !== undefined && fromMailbox !== undefined && trash.id === fromMailbox
  /**
   * Both lines here are DEFENSIVE, and neither is load-bearing at the three call sites below today.
   * Saying so plainly, because an earlier version of this comment asserted the opposite and a
   * mutation test caught it out.
   *
   * `fromMailbox === undefined`: enforced by the TYPE checker, not by the suite. `useTriage`'s moves
   * take `Id | null`; `fromMailbox` is `Id | undefined`. Delete this line and `tsc --noEmit` fails
   * with TS2345 while `MessageList.test.tsx` stays green. Behaviourally it is unreachable — every
   * caller is drawn behind `canMoveTo`, whose first term IS `canMove` (`fromMailbox !== undefined`).
   *
   * `if (move(…)) onClear()`: `useTriage`'s boolean is false in exactly three cases — `to` unknown,
   * `to === from`, empty `ids` — and all three are already excluded before the button exists.
   * `canMoveTo`'s two remaining terms cover the first two; the third is impossible because this bar
   * mounts only under `selection.selected.size > 0` and `ids` is that same set. Delete the condition
   * and BOTH `tsc` and the suite stay green. That is not a coverage hole to be plugged: it is what
   * "dominated by the render gate" looks like, and `MessageList.test.tsx`'s "what canMoveTo refuses
   * before a move button is drawn" pins the gate instead, so weakening one of them goes red
   * and makes these two lines load-bearing again.
   *
   * Why keep them, then. One divergence is genuinely outside the gate's reach and is the reason this
   * is not simplified away: `canMoveTo` reads BulkBar's own `useMailboxByRole`, while `useTriage`
   * holds a SEPARATE `useLiveQuery` subscription to the same query. Nothing makes two subscriptions
   * render in step. Probed directly (two subscriptions in one component, the role mailbox inserted
   * under a mounted tree) they landed in the same render every time under React's batching — so the
   * skew is not demonstrated, and no claim is made that this line catches it. It is cheap insurance
   * against a divergence the type system cannot see and the gate does not own, and it keeps each
   * call site correct on its own rather than by reference to a condition three lines up.
   */
  const moveThenClear = (move: (ids: Id[], from: Id | null) => boolean) => {
    if (fromMailbox === undefined) return
    if (move(ids, fromMailbox)) onClear()
  }

  /**
   * The label picker's state lives HERE, not inside a `LabelMenuButton`.
   *
   * It has to: once Label can be displaced into the overflow menu there is no button of its own to
   * hold the state or to anchor the popover against. `MessageView` hoisted the same state for the
   * same reason when its `l` chord needed a picker the bar might not be showing — this is that
   * arrangement, one surface over, so both bars now behave the same way when they run out of room.
   */
  const [labelsOpen, setLabelsOpen] = useState(false)
  const labelButtonRef = useRef<HTMLButtonElement>(null)
  const overflowRef = useRef<HTMLSpanElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  /** The button on the bar while Label is on it; the `⋯` trigger once it is not. Focusable either way. */
  const labelAnchorRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return labelButtonRef.current ?? overflowRef.current?.querySelector('button') ?? null
      },
    }),
    [],
  )

  const bulkActions: BulkAction[] = [
    /**
     * A TOGGLE, not a setter — and that is a WCAG 2.2 SC 2.5.7 requirement here, not a nicety.
     * Swipe-right toggles `$seen` against the row's current state, so SC 2.5.7 owes each swipe
     * outcome a single-pointer, non-dragging equivalent. Archive and Trash had one; marking a
     * message UNREAD was reachable only from the `u` chord, which is a keyboard path (SC 2.1.1)
     * and no help to the pointer user this gesture exists for.
     * It also ends a three-way drift that had grown across the entry points: the button SET
     * `$seen`, `u` CLEARED it, the swipe TOGGLES it — exactly what `useTriage` exists to prevent.
     */
    {
      id: 'seen',
      when: true,
      label: allSeen ? t('list.actions.unread') : t('list.actions.read'),
      icon: allSeen ? Mail : MailOpen,
      unavailableReason: reasonText(rights.reason('seen')),
      onSelect: () => triage.setSeen(ids, !allSeen),
    },
    {
      id: 'archive',
      when: canMoveTo(archive?.id),
      label: t('list.actions.archive'),
      icon: Archive,
      unavailableReason: reasonText(rights.moveReason(fromMailbox ?? null, archive?.id)),
      onSelect: () => moveThenClear(triage.archive),
    },
    /**
     * ONE destructive button, and which destruction it is depends on where you are standing.
     * It used to be two: this "Move to Trash" and, below the Move button, an UNCONDITIONAL
     * "Delete" (permanent destroy) — adjacent, icon-only, and drawing the SAME `Trash2` glyph. In
     * the Inbox that put two identical icons side by side, one recoverable and one not, told apart
     * only by an accessible name a sighted pointer user never hears.
     * The swap that replaces it is not an invention: `MessageView`'s action bar has always drawn
     * one `Trash2` that reads "Move to Trash" outside Trash and "Delete" inside it (its `inTrash`),
     * and the `#` chord's shortcut context carries the same distinction — `ShortcutContext.inTrash`
     * in `shortcuts/types.ts` is documented, verbatim: True when the acted-on messages live in
     * Trash (there, "delete" means destroy). Those two are this bar's peers: all
     * three act on a hand-picked target from wherever the user happens to be standing, and all
     * three resolve `inTrash` against the TRASH role alone. The bulk bar was the one of the three
     * that offered a permanent destroy from ANY folder.
     * Do NOT cite `FolderTree`'s `olderMode` for this rule — an earlier version of this comment
     * did, and it says the OPPOSITE: `role === 'trash' || role === 'junk'` → `'destroy'`. That is
     * a different family of action, not a contradiction to resolve. "Empty Junk" / "Delete older
     * than…" are FOLDER-LEVEL PURGES: named for the folder, confirmed in their own dialog, and
     * permanent in both purge folders by spec — FR-ORG-04 pairs "empty-trash / empty-junk" as one
     * feature, `FolderTreeView` puts one Empty entry on BOTH purge roles and picks its label by
     * role ("Empty Trash" / "Empty Junk"), and `Engine.deleteOlderThan` is documented "for
     * Trash/Junk cleanup". Nothing in that family
     * speaks for what an icon-only button does to five ticked rows.
     * So Junk parts company with Trash HERE and only here, and the reason is the kind of action,
     * not the folder: a hand-picked delete in Junk stays recoverable, because Junk is where a
     * false-positive classification lands and this button has no dialog naming the folder. Both
     * halves are pinned — `MessageList.test.tsx` "offers the recoverable move in Junk, not the
     * permanent destroy" and `FolderTree.test.tsx` "destroys permanently from Junk even though a
     * Trash exists to move to" — so moving either surface to the other's rule fails a test that
     * states the rule out loud.
     * What that costs, stated rather than glossed: from Junk, or from a source-less cross-folder
     * search selection, the bulk bar no longer permanently destroys. Junk keeps "Move to Trash"
     * and its own "Empty Junk"; a search selection keeps read/flag/label and gets neither
     * destructive button, which is the same gate `canMove` already applies to every move here.
     */
    inTrash
      ? {
          id: 'delete',
          when: true,
          label: t('list.actions.delete'),
          icon: Trash2,
          destructive: true,
          unavailableReason: reasonText(rights.reason('destroy')),
          onSelect: onRequestDelete,
        }
      : {
          id: 'trash',
          when: canMoveTo(trash?.id),
          label: t('list.actions.trash'),
          icon: Trash2,
          destructive: true,
          unavailableReason: reasonText(rights.moveReason(fromMailbox ?? null, trash?.id)),
          onSelect: () => moveThenClear(triage.trash),
        },
    /**
     * A TOGGLE for the same reason the read button beside it is one: the `s` chord toggles through
     * this very seam, and a button that can only ever SET the flag is the keystroke/button drift
     * `useTriage` exists to prevent. The label is the accessible name, so it has to move with the
     * state too — a control permanently announced as "Flag" that unflags is a lie to a screen
     * reader, not a cosmetic slip. And it draws a STAR, the mark the row indicator and the reading
     * pane both paint: the bulk button was the one surface not showing the mark it sets.
     */
    {
      id: 'flag',
      when: true,
      label: allFlagged ? t('list.actions.unflag') : t('list.actions.flag'),
      icon: Star,
      iconClassName: allFlagged ? styles.flagOn : undefined,
      unavailableReason: reasonText(rights.reason('keywords')),
      onSelect: () => triage.setFlagged(ids, !allFlagged),
    },
    {
      id: 'labels',
      when: true,
      label: t('labels.assign'),
      icon: Tag,
      popover: true,
      onSelect: () => setLabelsOpen((open) => !open),
    },
    {
      id: 'junk',
      when: canMoveTo(junk?.id),
      label: t('list.actions.junk'),
      icon: Ban,
      unavailableReason: reasonText(rights.moveReason(fromMailbox ?? null, junk?.id)),
      onSelect: () => moveThenClear(triage.junk),
    },
    /**
     * Move to an arbitrary folder — the only non-pointer path to it, and the one WCAG 2.2
     * SC 2.5.7 requires the drag (5b) to have. Opens the picker via the store, so `v` and this
     * button are one path. Clearing the selection is the picker's job, not this button's.
     */
    {
      id: 'move',
      when: canMove,
      label: t('list.actions.move'),
      icon: FolderInput,
      unavailableReason: reasonText(rights.removeReason(fromMailbox ?? null)),
      onSelect: onRequestMove,
    },
  ].filter((action) => action.when)

  const visibleActions = useActionOverflow(actionsRef, bulkActions.length)
  const menuItems: MenuItemSpec[] = bulkActions.slice(visibleActions).map((action) => ({
    id: action.id,
    label:
      action.unavailableReason === undefined
        ? action.label
        : `${action.label} — ${action.unavailableReason}`,
    icon: action.icon,
    disabled: action.unavailableReason !== undefined,
    ...(action.destructive === true ? { destructive: true } : {}),
    onSelect: action.onSelect,
  }))

  return (
    <div className={styles.bulkBar}>
      {/* The name has to follow the action. Once everything is selected this control CLEARS the
          selection (see `onChange` below), but it kept announcing "Select all" — a control naming
          one action and performing the opposite, and for a screen-reader user the name is the only
          information there is. `list.clearSelection` was already translated in both languages and
          had no caller. */}
      <Checkbox
        aria-label={allSelected ? t('list.clearSelection') : t('list.selectAll')}
        checked={allSelected}
        indeterminate={someSelected}
        onChange={(event) => (event.target.checked ? onSelectAll() : onClear())}
      />
      <span className={styles.bulkCount}>{t('list.selected', { count })}</span>
      {activeLabel !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          unavailableReason={reasonText(rights.reason('keywords'))}
          onClick={() => {
            actions.setKeyword(ids, activeLabel, false)
            onClear()
          }}
        >
          {t('labels.removeFromLabel')}
        </Button>
      )}
      {/* The measured container is THIS one, not the bar: the checkbox, the count and the
          remove-from-label button are a prefix of unknown width, and `flex: 1` plus `min-inline-size:
          0` makes the hook's `clientWidth` exactly the room the actions actually have. */}
      <div ref={actionsRef} className={styles.bulkActions}>
        {bulkActions.slice(0, visibleActions).map((action) => (
          <IconButton
            key={action.id}
            ref={action.popover === true ? labelButtonRef : null}
            label={action.label}
            variant="ghost"
            unavailableReason={action.unavailableReason}
            aria-haspopup={action.popover === true ? 'menu' : undefined}
            aria-expanded={action.popover === true ? labelsOpen : undefined}
            onClick={action.onSelect}
          >
            <action.icon className={action.iconClassName} />
          </IconButton>
        ))}
        {menuItems.length > 0 && (
          <span ref={overflowRef} {...{ [OVERFLOW_TRIGGER_ATTR]: '' }}>
            <Menu
              triggerLabel={t('list.actions.more')}
              trigger={<Ellipsis aria-hidden="true" />}
              align="end"
              triggerVariant="toolbar"
              items={menuItems}
            />
          </span>
        )}
      </div>
      {labelsOpen && (
        <LabelMenu ids={ids} anchorRef={labelAnchorRef} onClose={() => setLabelsOpen(false)} />
      )}
    </div>
  )
}

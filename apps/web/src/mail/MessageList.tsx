/**
 * Virtualized message list (M1.6, FR-LST-01..07). Renders the server-ordered `queryCache` window
 * (from {@link useMessageList}) with TanStack Virtual so a 100 k-message mailbox scrolls smoothly,
 * hydrating ONLY the visible slice from the replica. It is an APG `grid` — the CONTAINER holds
 * focus and moves an `aria-activedescendant` across virtualized rows (so focus is never lost when a
 * row scrolls out and unmounts), with container-delegated keyboard (arrows/space/enter/shift-range/
 * ctrl-a/escape). It has a toolbar (sort / unread-first / density / threaded) whose choices persist
 * locally, a selection-driven bulk-actions bar (read/flag/archive/junk/trash/delete → the engine
 * outbox), and infinite scroll that pages older messages via `loadMore`.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type { Id } from '@waxwing/jmap'
import { Archive, Ban, Flag, FolderInput, Mail, MailOpen, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mailPath, useNavigate, useRoute } from '../app/route'
import { useDraftOpener } from '../compose'
import {
  type EmailRow,
  type QuerySpec,
  setPref,
  useEmailWindow,
  useLocalPref,
  useMailboxByRole,
  useMailboxes,
  useReplica,
} from '../sync'
import { Button, Checkbox, Dialog, IconButton, Select, Spinner, VisuallyHidden } from '../ui'
import { clearActiveDrag, draggedMessageIds, MESSAGES_MIME, setActiveDrag } from './dnd'
import { LabelMenu } from './labels/LabelMenu'
import { LabelMenuButton } from './labels/LabelMenuButton'
import { useLabels } from './labels/use-labels'
import { type GridHandle, useListStore } from './list-store'
import type { Density, RowLabel } from './MessageRow'
import { MessageRow } from './MessageRow'
import { MoveDialog } from './MoveDialog'
import styles from './message-list.module.css'
import { useSnippets } from './search/use-snippets'
import { useSwipeLeft, useSwipeRight } from './swipe-prefs'
import { useMessageActions } from './use-message-actions'
import { type ListSource, type MessageSort, useMessageList } from './use-message-list'
import { type ResolvedSwipe, useRowSwipe } from './use-swipe'
import { useTriage } from './use-triage'

const OVERSCAN = 8
const ROW_HEIGHT: Record<Density, number> = { comfortable: 76, compact: 54 }

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
}

export function MessageList({ mailboxId, search, activeLabel }: MessageListProps) {
  const { t } = useTranslation()
  const route = useRoute()
  const navigate = useNavigate()
  const { db, accountId } = useReplica()
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
      // Toggle, not "mark read": the gesture stays useful on a row that is already read, and it is
      // the same rule `triage.flag` follows. Read from the row's state at THIS moment.
      if (action === 'read') return { kind: 'read', seen: row.keywords.$seen !== true }
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
      // The source travels WITH the decision — see {@link ResolvedRowSwipe}. Everything else the move
      // needs is re-derived at commit; this one value cannot be, because by then it may have changed.
      return { kind: action, from: sourceMailboxId }
    },
    [rowById, swipeLeftAction, swipeRightAction, rolesReady, archiveId, trashId, sourceMailboxId],
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
    (id: Id) => {
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
      const qs = route.search.toString()
      navigate(mailPath(targetMailbox, id) + (qs ? `?${qs}` : ''))
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
  const openRef = useRef(open)
  useEffect(() => {
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

  return (
    <div className={styles.container} ref={containerRef}>
      {selection.selected.size > 0 ? (
        <BulkBar
          count={selection.selected.size}
          ids={selectedIds}
          activeLabel={activeLabel}
          fromMailbox={sourceMailboxId ?? undefined}
          allSelected={allSelected}
          someSelected={someSelected}
          allSeen={selectedIds.every((id) => rowById.get(id)?.keywords.$seen === true)}
          actions={actions}
          onSelectAll={() => dispatchSelection({ type: 'selectAll', ordered: ids })}
          onClear={() => dispatchSelection({ type: 'clear' })}
          onRequestDelete={() => setConfirmDelete(true)}
          onRequestMove={() => requestMove(selectedIds)}
        />
      ) : (
        <Toolbar
          sort={sort}
          density={density}
          unreadFirst={unreadFirst}
          flat={flat}
          onChange={setPrefValue}
        />
      )}

      {search && (
        <VisuallyHidden aria-live="polite">
          {loading
            ? ''
            : ids.length === 0
              ? t('search.results.empty')
              : t('search.results.count', { count: total ?? ids.length })}
        </VisuallyHidden>
      )}

      {ids.length === 0 && !loading ? (
        <p className={styles.empty}>{search ? t('search.results.empty') : t('list.empty')}</p>
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
            <div role="presentation" className={styles.loading}>
              <Spinner label={t('list.loading')} />
            </div>
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
                  draggable={rowById.get(id) !== undefined && sourceMailboxId !== null}
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
                    setActiveDrag({ kind: 'messages', ids: dragged, from: sourceMailboxId })
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
                    density={density}
                    labels={labelLookup}
                    highlight={highlights.get(id)}
                    onOpen={() => open(id)}
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
          <p>{t('list.selected', { count: selection.selected.size })}</p>
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
  readonly density: Density
  readonly unreadFirst: boolean
  readonly flat: boolean
  readonly onChange: (key: string, value: unknown) => void
}

function Toolbar({ sort, density, unreadFirst, flat, onChange }: ToolbarProps) {
  const { t } = useTranslation()
  const sortId = useId()
  const viewId = useId()
  const densityId = useId()
  return (
    <div className={styles.toolbar}>
      <div className={styles.control}>
        <label htmlFor={sortId} className={styles.controlLabel}>
          {t('list.sort.label')}
        </label>
        <Select
          id={sortId}
          value={sort}
          onChange={(event) => onChange('list.sort', event.target.value)}
        >
          <option value="date">{t('list.sort.date')}</option>
          <option value="from">{t('list.sort.from')}</option>
          <option value="subject">{t('list.sort.subject')}</option>
          <option value="size">{t('list.sort.size')}</option>
        </Select>
      </div>
      <div className={styles.control}>
        <label htmlFor={viewId} className={styles.controlLabel}>
          {t('list.view.threaded')}
        </label>
        <Select
          id={viewId}
          value={flat ? 'flat' : 'threaded'}
          onChange={(event) => onChange('list.flat', event.target.value === 'flat')}
        >
          <option value="threaded">{t('list.view.threaded')}</option>
          <option value="flat">{t('list.view.flat')}</option>
        </Select>
      </div>
      <div className={styles.control}>
        <label htmlFor={densityId} className={styles.controlLabel}>
          {t('list.density.label')}
        </label>
        <Select
          id={densityId}
          value={density}
          onChange={(event) => onChange('list.density', event.target.value)}
        >
          <option value="comfortable">{t('list.density.comfortable')}</option>
          <option value="compact">{t('list.density.compact')}</option>
        </Select>
      </div>
      <Checkbox
        label={t('list.sort.unreadFirst')}
        checked={unreadFirst}
        onChange={(event) => onChange('list.unreadFirst', event.target.checked)}
      />
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
  /**
   * Whether every selected message is already read — the read button toggles on it. An unhydrated
   * row counts as unread, which is the safe way round: the button then offers "mark as read", and
   * re-reading an already-read message is harmless.
   */
  readonly allSeen: boolean
  readonly actions: ReturnType<typeof useMessageActions>
  readonly onSelectAll: () => void
  readonly onClear: () => void
  readonly onRequestDelete: () => void
  readonly onRequestMove: () => void
}

function BulkBar({
  count,
  ids,
  activeLabel,
  allSeen,
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
  const moveThenClear = (move: (ids: Id[], from: Id | null) => boolean) => {
    if (fromMailbox === undefined) return
    // Clear only over a move that actually dispatched: `useTriage`'s boolean is the one signal that
    // the mail left the folder, and dropping the selection without it discards the user's work to
    // report a filing that never happened.
    if (move(ids, fromMailbox)) onClear()
  }

  return (
    <div className={styles.bulkBar}>
      <Checkbox
        aria-label={t('list.selectAll')}
        checked={allSelected}
        indeterminate={someSelected}
        onChange={(event) => (event.target.checked ? onSelectAll() : onClear())}
      />
      <span className={styles.bulkCount}>{t('list.selected', { count })}</span>
      {/*
        A TOGGLE, not a setter — and that is a WCAG 2.2 SC 2.5.7 requirement here, not a nicety.
        Swipe-right toggles `$seen` against the row's current state, so SC 2.5.7 owes each swipe
        outcome a single-pointer, non-dragging equivalent. Archive and Trash had one; marking a
        message UNREAD was reachable only from the `u` chord, which is a keyboard path (SC 2.1.1)
        and no help to the pointer user this gesture exists for.
        It also ends a three-way drift that had grown across the entry points: the button SET
        `$seen`, `u` CLEARED it, the swipe TOGGLES it — exactly what `useTriage` exists to prevent.
      */}
      <IconButton
        label={allSeen ? t('list.actions.unread') : t('list.actions.read')}
        variant="ghost"
        onClick={() => triage.setSeen(ids, !allSeen)}
      >
        {allSeen ? <Mail /> : <MailOpen />}
      </IconButton>
      <IconButton
        label={t('list.actions.flag')}
        variant="ghost"
        onClick={() => triage.setFlagged(ids, true)}
      >
        <Flag />
      </IconButton>
      <LabelMenuButton ids={ids} />
      {activeLabel !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            actions.setKeyword(ids, activeLabel, false)
            onClear()
          }}
        >
          {t('labels.removeFromLabel')}
        </Button>
      )}
      {canMoveTo(archive?.id) && (
        <IconButton
          label={t('list.actions.archive')}
          variant="ghost"
          onClick={() => moveThenClear(triage.archive)}
        >
          <Archive />
        </IconButton>
      )}
      {canMoveTo(junk?.id) && (
        <IconButton
          label={t('list.actions.junk')}
          variant="ghost"
          onClick={() => moveThenClear(triage.junk)}
        >
          <Ban />
        </IconButton>
      )}
      {canMoveTo(trash?.id) && (
        <IconButton
          label={t('list.actions.trash')}
          variant="ghost"
          onClick={() => moveThenClear(triage.trash)}
        >
          <Trash2 />
        </IconButton>
      )}
      {/* Move to an arbitrary folder — the only non-pointer path to it, and the one WCAG 2.2
          SC 2.5.7 requires the drag (5b) to have. Opens the picker via the store, so `v` and this
          button are one path. Clearing the selection is the picker's job, not this button's. */}
      {canMove && (
        <IconButton label={t('list.actions.move')} variant="ghost" onClick={onRequestMove}>
          <FolderInput />
        </IconButton>
      )}
      <IconButton label={t('list.actions.delete')} variant="ghost" onClick={onRequestDelete}>
        <Trash2 />
      </IconButton>
    </div>
  )
}

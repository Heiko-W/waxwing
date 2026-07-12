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
import { Archive, Ban, Flag, MailOpen, Trash2 } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
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
  useReplica,
} from '../sync'
import { Button, Checkbox, Dialog, IconButton, Select, Spinner, VisuallyHidden } from '../ui'
import { LabelMenu } from './labels/LabelMenu'
import { LabelMenuButton } from './labels/LabelMenuButton'
import { useLabels } from './labels/use-labels'
import type { Density, RowLabel } from './MessageRow'
import { MessageRow } from './MessageRow'
import styles from './message-list.module.css'
import { EMPTY_SELECTION, selectionReducer } from './message-selection'
import { useSnippets } from './search/use-snippets'
import { useMessageActions } from './use-message-actions'
import { type ListSource, type MessageSort, useMessageList } from './use-message-list'

const OVERSCAN = 8
const ROW_HEIGHT: Record<Density, number> = { comfortable: 76, compact: 54 }

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
  const [selection, dispatchSelection] = useReducer(selectionReducer, EMPTY_SELECTION)
  const [focusIndex, setFocusIndex] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset selection/focus when the window (mailbox/sort/search) changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on window identity change.
  useEffect(() => {
    dispatchSelection({ type: 'clear' })
    setFocusIndex(0)
  }, [windowKey])

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

  // Registry name+color per keyword, so each row can render its label swatches without subscribing.
  const labels = useLabels()
  const labelLookup = useMemo(() => {
    const map = new Map<string, RowLabel>()
    for (const label of labels ?? [])
      map.set(label.keyword, { name: label.name, color: label.color })
    return map
  }, [labels])

  // The `l` shortcut opens a label picker for the selection / focused row, anchored to the container.
  const containerRef = useRef<HTMLDivElement>(null)
  const [labelTargets, setLabelTargets] = useState<Id[] | null>(null)

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
    [mailboxId, navigate, rowById, draftOpener, route.search],
  )

  // Move the roving position (keyboard) — scroll the target into view; the grid keeps DOM focus and
  // just repoints aria-activedescendant, so a row unmounting can never drop focus to <body>.
  const moveTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, ids.length - 1))
      setFocusIndex(clamped)
      virtualizer.scrollToIndex(clamped, { align: 'auto' })
    },
    [ids.length, virtualizer],
  )

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
      case 'l':
        // Label the current selection, or the focused row when nothing is selected (M3.2).
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          const targets =
            selection.selected.size > 0 ? [...selection.selected] : id !== undefined ? [id] : []
          if (targets.length > 0) {
            event.preventDefault()
            setLabelTargets(targets)
          }
        }
        break
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
          fromMailbox={search ? search.scopeMailboxId : mailboxId}
          allSelected={allSelected}
          someSelected={someSelected}
          actions={actions}
          onSelectAll={() => dispatchSelection({ type: 'selectAll', ordered: ids })}
          onClear={() => dispatchSelection({ type: 'clear' })}
          onRequestDelete={() => setConfirmDelete(true)}
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
                <div
                  key={id}
                  role="presentation"
                  className={styles.rowWrap}
                  style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                >
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
                      setFocusIndex(item.index)
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
        <LabelMenu ids={labelTargets} anchorRef={scrollRef} onClose={() => setLabelTargets(null)} />
      )}
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
  readonly actions: ReturnType<typeof useMessageActions>
  readonly onSelectAll: () => void
  readonly onClear: () => void
  readonly onRequestDelete: () => void
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
}: BulkBarProps) {
  const { t } = useTranslation()
  const archive = useMailboxByRole('archive')
  const junk = useMailboxByRole('junk')
  const trash = useMailboxByRole('trash')

  // Folder-move needs a known source mailbox; an all-mailboxes search selection spans folders, so the
  // move actions are gated off there (read/flag/delete, which need no source, stay). A moved message
  // leaves the folder → it must leave the selection too, or a follow-up move uses a stale `from`.
  const canMove = fromMailbox !== undefined
  const moveThenClear = (to: Id) => {
    if (fromMailbox === undefined) return
    actions.move(ids, fromMailbox, to)
    onClear()
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
      <IconButton
        label={t('list.actions.read')}
        variant="ghost"
        onClick={() => actions.setSeen(ids, true)}
      >
        <MailOpen />
      </IconButton>
      <IconButton
        label={t('list.actions.flag')}
        variant="ghost"
        onClick={() => actions.setFlagged(ids, true)}
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
      {canMove && archive && (
        <IconButton
          label={t('list.actions.archive')}
          variant="ghost"
          onClick={() => moveThenClear(archive.id)}
        >
          <Archive />
        </IconButton>
      )}
      {canMove && junk && (
        <IconButton
          label={t('list.actions.junk')}
          variant="ghost"
          onClick={() => moveThenClear(junk.id)}
        >
          <Ban />
        </IconButton>
      )}
      {canMove && trash && (
        <IconButton
          label={t('list.actions.trash')}
          variant="ghost"
          onClick={() => moveThenClear(trash.id)}
        >
          <Trash2 />
        </IconButton>
      )}
      <IconButton label={t('list.actions.delete')} variant="ghost" onClick={onRequestDelete}>
        <Trash2 />
      </IconButton>
    </div>
  )
}

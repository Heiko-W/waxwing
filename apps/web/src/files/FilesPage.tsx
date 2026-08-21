/**
 * The files screen (M5.7, FR-FILE-01) — a lazy route chunk.
 *
 * A single-pane browser: breadcrumbs, a list, search, sort, upload, new folder, rename, move,
 * delete, download and an inline preview (M5.17). Not a two-pane manager with drag-and-drop — that
 * is the part that needs a second milestone, and a file list that reliably does nine things beats
 * one that half-does fourteen.
 *
 * The preview surface is the reader's, deliberately: `preview-policy.ts` decides what may be shown
 * and where, so a file and an attachment of the same type are treated identically. Uploaded bytes
 * are no more trustworthy than emailed ones, and a second, more relaxed answer here would be a way
 * in that the stricter answer over there would not notice.
 *
 * Names are checked against the server's own rules BEFORE the round trip: a name containing `:`,
 * or called `AUX`, is refused for Windows-compatibility reasons that have nothing to do with what
 * the user meant, and "the server said no" is not an explanation anyone can act on.
 *
 * ---
 *
 * **The 2026-08-21 pass, and the shape it took.** Four findings landed on this screen at once
 * (D-1 move, D-2 multi-select, D-3 search and sort, B-7 delete), and the tempting answer — four
 * more controls in the row — is the one thing `use-row-actions.ts` exists to prevent. So the screen
 * follows the arrangement iOS Files and the Finder settled on, for the same reasons:
 *
 * - **The bar holds what you do HERE** (new folder, upload) and hands everything about the LISTING
 *   — how it is ordered, and whether you are picking things out of it — to one `⋯` menu. A phone
 *   header is one row; five controls in it is not a design, it is a queue.
 * - **Selecting is a MODE, entered on purpose.** "Select" turns every row into a checkbox and
 *   raises one bar of actions over the whole selection. Nothing is selectable until you say so, so
 *   an ordinary tap still opens a folder — which is what a tap on a file row means every other day.
 * - **Moving is a destination you WALK TO** ({@link FileMoveDialog}), never a drag. ADR-012 keeps
 *   HTML5 drag desktop-only; a move that exists only there would leave the phone exactly where
 *   this finding found it.
 * - **Search is a field above the list, not a screen you go to.** It searches the whole account —
 *   the server offers no subtree condition — so every hit states the folder it was found in, and
 *   that statement is the control that takes you there.
 */

import type { FileNode, Id } from '@waxwing/jmap'
import { fileNodeNameProblem } from '@waxwing/jmap'
import {
  ArrowDown,
  ArrowUp,
  CloudOff,
  Download,
  Ellipsis,
  Eye,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Info,
  ListChecks,
  type LucideIcon,
  Pencil,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { delegatedAccountsFor } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { useOnline } from '../app/use-online'
import { formatBytes, formatRelativeTime } from '../i18n/formatters'
import { isPreviewable, previewSurface } from '../mail/preview-policy'
import { safeDownloadName } from '../mail/safe-filename'
import { useFileNodes, useFileTreeState } from '../sync'
import { useAccountEngine } from '../sync/engine'
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  type MenuItemSpec,
  Spinner,
  TextInput,
  useToast,
} from '../ui'
import { FileMoveDialog } from './FileMoveDialog'
import {
  DEFAULT_FILE_SORT,
  type FileSort,
  type FileSortKey,
  fileComparator,
  offeredSortKeys,
  serverSort,
} from './file-sort'
import styles from './files.module.css'
import {
  currentUserPrincipalId,
  type FileSearchHit,
  FileSetError,
  type FilesClient,
  fileCapability,
  makeFilesClient,
} from './files-client'
import { ShareDialog } from './ShareDialog'
import { mayShare } from './sharing'
import { useFileSearch } from './use-file-tree'
import { ROW_PART, useRowGeometry, visibleRowActions } from './use-row-actions'

export interface FilesPageProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: FilesClient
  /**
   * Injected in tests that cross ACCOUNTS (S-4): the client for `accountId`, so a shared account's
   * listing can be told apart from the user's own. Takes precedence over {@link client}.
   */
  readonly clientFor?: (accountId: Id) => FilesClient
}

/**
 * The `download` value for a node whose name strips to nothing. Not localized: it becomes a file on
 * disk, and a filename that changes with the UI language is one the reader cannot find again.
 */
const DOWNLOAD_FALLBACK = 'file'

/**
 * How long the search field waits after the last keystroke.
 *
 * Every search is a round trip against an account-wide query, so a per-keystroke search would send
 * one for `r`, `re`, `rep`, … — most of them answered after the reader has already stopped caring.
 */
const SEARCH_DEBOUNCE_MS = 250

/** One step of the path the user has walked into. */
interface Crumb {
  readonly id: string | null
  readonly name: string
}

/**
 * A line in the listing: a node, and — in search results only — the folder it was found in.
 *
 * `parent` is what stops an account-wide search being useless. `report.txt` can exist three times
 * over, and three identical rows say less than no search at all.
 */
interface Row {
  readonly node: FileNode
  readonly parent: FileNode | null
}

/**
 * One thing a row offers to do with its node — as data, so the row and its `⋯` menu can be built
 * from the same array (N-1). Six conditional elements cannot be split between two surfaces without
 * writing the conditions twice, and a menu that drifts out of step with the bar it relieves is how
 * an action becomes unreachable.
 */
interface RowAction {
  readonly id: string
  /** Already names its node ("Rename report.txt") — the same string as button and as menu item. */
  readonly label: string
  readonly icon: LucideIcon
  readonly disabled: boolean
  readonly destructive: boolean
  /** Whether the surface this toggles is open; `undefined` for everything that is not a toggle. */
  readonly expanded: boolean | undefined
  readonly onSelect: () => void
}

export default function FilesPage(props: FilesPageProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** The listing, measured once for every row it holds — see `use-row-actions.ts`. */
  const listRef = useRef<HTMLUListElement>(null)

  const [path, setPath] = useState<Crumb[]>([{ id: null, name: '' }])
  /**
   * The listing when it comes from the SERVER — a visit to somebody else's files (S-4).
   *
   * The reader's own tree is replicated and read below; a shared account's is not, and cannot be:
   * the engine fleet runs one engine per MAIL account (`fleetAccounts`), so an account shared for
   * its files alone has no engine and no rows. Reading the replica there would show the reader
   * their OWN files under somebody else's name — the worst possible failure for a screen whose
   * whole job is saying where you are.
   */
  const [remoteNodes, setRemoteNodes] = useState<readonly FileNode[] | null>(null)
  const [remoteHits, setRemoteHits] = useState<readonly FileSearchHit[] | null>(null)
  const [remoteTruncated, setRemoteTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [newFolder, setNewFolder] = useState('')
  /**
   * The new-folder field is behind its button now.
   *
   * It used to sit open permanently: a 420px text input above a button that stayed disabled until
   * something was typed into it, which is a form that looks broken while it waits. Mail asks for a
   * folder name in a dialog; this asks the same question the same way.
   */
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  /**
   * Whether the reader is online.
   *
   * The screen no longer NEEDS this to show files — the tree is replicated (D-4) — but it still
   * needs it to be honest: what cannot work without a line (upload, share, opening a file's bytes)
   * is offered greyed out with a reason rather than removed, and the listing says quietly that it
   * is not being refreshed.
   */
  const online = useOnline()
  // The open preview, or null. Holds the object URL so the render stays synchronous.
  const [preview, setPreview] = useState<{ id: string; type: string; url: string } | null>(null)
  // The node whose sharing is being edited, or null.
  const [sharing, setSharing] = useState<FileNode | null>(null)
  /**
   * The node being renamed, or null — plus the name being typed for it.
   *
   * A dialog rather than an editable cell in the row, for the same reason the folder name is one:
   * a name is refused for reasons the reader cannot see coming (`fileNodeNameProblem` — a `:`, a
   * name like `AUX`), and a refusal needs somewhere to be said that is not the list. The field
   * opens with the CURRENT name selected, because renaming is far more often an edit of what is
   * there than a replacement of it.
   */
  const [renaming, setRenaming] = useState<FileNode | null>(null)
  const [renameTo, setRenameTo] = useState('')
  /** What the field holds, and what has actually been asked for — see {@link SEARCH_DEBOUNCE_MS}. */
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)
  /** Selecting is a mode. Nothing is pickable until the reader says so. */
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<Id>>(() => new Set())
  /** The nodes a move is being chosen for, or null. */
  const [moving, setMoving] = useState<readonly FileNode[] | null>(null)
  /** The nodes a delete is being confirmed for, or null (B-7). */
  const [deleting, setDeleting] = useState<readonly FileNode[] | null>(null)
  // One object URL per node, reused across toggles and revoked once on unmount — re-opening a
  // preview neither downloads the file again nor leaks the superseded URL.
  const urlCacheRef = useRef(new Map<string, string>())

  const injected = props.client
  const injectedFor = props.clientFor
  const sessionClient = connected?.client ?? null
  const ownAccountId = connected?.accountId ?? null
  /**
   * The delegated accounts that really have files in them (S-4).
   *
   * Not the ones the session lists — measured against Stalwart v0.16.18, a share of ANY single
   * object makes the whole account appear with all seventeen capabilities, `filenode` among them,
   * so the capability says nothing. `connected.delegated` carries the answer to a probe that asked
   * `FileNode/get` per account; `delegatedAccountsFor` keeps the ones it served.
   */
  const sharedAccounts = useMemo(
    () => (connected === null ? [] : delegatedAccountsFor(connected, 'files')),
    [connected],
  )
  /** The shared account being browsed, or `null` for the user's own — see {@link enterAccount}. */
  const [visitingId, setVisitingId] = useState<Id | null>(null)
  const visiting = sharedAccounts.find((account) => account.id === visitingId) ?? null
  /*
   * Not derived state, but corrected state: a session change can take a share away while the reader
   * is standing in it. Falling back silently to their own root would be the same "which account am
   * I looking at" confusion the account-qualified mail routes exist to prevent, so the crumb and
   * the listing move back together, here, in one place.
   */
  const accountId = visiting?.id ?? ownAccountId
  const selfPrincipalId = currentUserPrincipalId(connected?.jmapSession ?? null, accountId)
  const client = useMemo(
    () =>
      (accountId === null ? undefined : injectedFor?.(accountId)) ??
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeFilesClient(sessionClient, accountId, selfPrincipalId)),
    [injected, injectedFor, sessionClient, accountId, selfPrincipalId],
  )
  const capability = fileCapability(connected?.jmapSession ?? null, accountId)
  /** The engine that owns this account's replica; `null` before the session restores. */
  const engine = useAccountEngine()

  const here = path[path.length - 1]?.id ?? null
  const searching = query !== ''

  // The field leads the request by a beat. Trimmed here so " " is a blank search, not a search for
  // a space — which the server would answer with the whole account.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])

  /**
   * Whose files are on screen, and whether the replica holds them.
   *
   * `visiting === null` is the reader's own account, which the sync engine mirrors. Anything else is
   * a share, and a share stays online — see {@link remoteNodes}.
   */
  const replicated = visiting === null

  // ── The replicated read (D-4). Live queries: the engine writes, these re-render. ──────────────
  const levelRows = useFileNodes(here)
  const searchRows = useFileSearch(replicated ? query : '')
  const treeState = useFileTreeState()

  /** This level, from wherever this account's files come from. `null` = not answered yet. */
  const nodes: readonly FileNode[] | null = replicated ? (levelRows ?? null) : remoteNodes
  const hits: readonly FileSearchHit[] | null = replicated
    ? query === ''
      ? null
      : (searchRows ?? null)
    : remoteHits
  /** The listing stopped short of what the server holds — see `files-client.ts` (B-6). */
  const truncated = replicated ? (treeState?.truncated ?? false) : remoteTruncated
  /** This device has never walked the tree — "nothing yet", which is not "no files". */
  const neverSynced = replicated && treeState !== undefined && treeState.syncedAt === 0

  /**
   * Reloads what is on screen. Returns whether it arrived.
   *
   * For the reader's own account that means asking the ENGINE to re-read the tree — a
   * `FileNode/changes` and a `/get` of what moved, not the whole walk — and the rows appear through
   * the live queries above. For a share it is the round trip it always was.
   *
   * The return value is load-bearing: `run()` says something different when a write landed but the
   * listing did not come back, so the reader is never left to conclude from a stale list that
   * nothing was saved.
   */
  const load = useCallback(async (): Promise<boolean> => {
    if (replicated) {
      if (engine === null) return false
      const ok = await engine.refreshFileTree()
      setFailed(!ok)
      return ok
    }
    if (client === null) return false
    const wire = { sort: serverSort(sort, capability) }
    try {
      if (query !== '') {
        setRemoteHits(await client.search(query, wire))
        setRemoteTruncated(false)
      } else {
        const listing = await client.list(here, wire)
        setRemoteNodes(listing.nodes)
        setRemoteTruncated(listing.truncated)
        setRemoteHits(null)
      }
      setFailed(false)
      return true
    } catch {
      setFailed(true)
      return false
    }
  }, [replicated, engine, client, here, query, sort, capability])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The CURRENT `load`, for the one callback on this screen that outlives the render that made it.
   *
   * `load` is a `useCallback` over `here` — the folder on screen — so every render in a different
   * folder produces a different one. `run()` closes over whichever `load` its own render had, and
   * that is right for every caller but one: the move toast's **Undo**. That toast does not expire
   * (ADR-021), so the reader can walk into the folder they just moved the file to and press Undo
   * there — which is the obvious thing to do, and is exactly what the E2E does. The server move
   * back then ran correctly and the reload that followed it refreshed the folder the reader had
   * LEFT, so the row stayed on screen and Undo looked like it had done nothing.
   *
   * `useLayoutEffect` rather than `useEffect`, matching the fix recorded for B44: a passive effect
   * is scheduled as its own task, so between a commit and its effect a callback still reads the
   * previous render's value. The window is not what bites here — the gap is renders wide, not
   * microtasks — but there is no reason to leave the smaller hole open next to the larger one.
   */
  const loadRef = useRef(load)
  useLayoutEffect(() => {
    loadRef.current = load
  }, [load])

  // A selection is about the rows in front of you. Walking into a folder or typing a search puts
  // different rows there, and carrying ids across would leave a bulk action pointed at things the
  // reader can no longer see. The deps are the two navigations, not anything the body reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `here` and `query` are the triggers, by design.
  useEffect(() => {
    setSelected(new Set())
  }, [here, query])

  // Above the signed-out early return, because hooks must not be conditional. Revoking on unmount
  // is the only place it can happen: an object URL outlives the render that made it.
  useEffect(() => {
    const cache = urlCacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  /** What the list renders, in the reader's order — see `file-sort.ts` on why it is sorted twice. */
  const rows: Row[] | null = useMemo(() => {
    const compare = fileComparator(sort)
    if (searching) {
      if (hits === null) return null
      return [...hits]
        .map((hit) => ({ node: hit.node, parent: hit.parent }))
        .sort((a, b) => compare(a.node, b.node))
    }
    if (nodes === null) return null
    return [...nodes].sort(compare).map((node) => ({ node, parent: null }))
  }, [searching, hits, nodes, sort])

  // Above the early return for the same reason, and keyed to `rows`: a new listing brings new
  // names and new sizes, and the size column is part of what the row's actions have to fit around.
  const geometry = useRowGeometry(listRef, rows)

  if (client === null) {
    return (
      <div className={styles.page}>
        <EmptyState icon={FolderOpen} title={t('files.signedOut')} />
      </div>
    )
  }

  /** What the root of the account on screen is CALLED: "Files", or whose files these are. */
  const rootName = visiting === null ? t('files.root') : visiting.name
  /**
   * Whether the "Shared with me" section belongs on screen.
   *
   * Only at the reader's own root, and only outside a search: it is a place, and a place has one
   * spot in a hierarchy. Repeating it under every folder — or over a set of search hits that
   * deliberately span the whole account — would turn a location into decoration.
   */
  const showShared = visiting === null && !searching && here === null && sharedAccounts.length > 0

  const visibleNodes = (rows ?? []).map((row) => row.node)
  const selectedNodes = visibleNodes.filter((node) => selected.has(node.id))
  const allSelected = visibleNodes.length > 0 && selectedNodes.length === visibleNodes.length

  /** Runs a write, turning a refusal into a sentence the reader can act on. */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      /*
       * A WRITE THAT SUCCEEDED IS NEVER SILENT, even when the listing behind it does not come back.
       *
       * The normal path needs no toast: the uploaded file appears in the list, which is the
       * confirmation. But `load()` swallows its own failure into the error state, so while the
       * root listing was broken an upload landed on the server, the screen kept showing "could not
       * be loaded", and nothing anywhere said that the file was now there — the user uploaded into
       * a void. The reload failing is not the write failing, and the two must not look the same.
       */
      // `loadRef`, not `load`: reload what is on screen NOW, not what was on screen when this
      // callback was made. See the ref's own note — the move toast's Undo is the caller that can
      // be pressed several navigations later.
      if (!(await loadRef.current())) toast({ tone: 'warning', title: t('files.savedButNotShown') })
    } catch (thrown) {
      const key =
        thrown instanceof FileSetError ? `files.error.${thrown.failure}` : 'files.error.rejected'
      // Spelled out below rather than interpolated, so the i18n guard can see the keys.
      toast({ tone: 'danger', title: errorText(t, key) })
    } finally {
      setBusy(false)
    }
  }

  const checkName = (name: string): boolean => {
    if (capability === null) return true
    const problem = fileNodeNameProblem(name, capability)
    if (problem === null) return true
    toast({ tone: 'danger', title: nameProblemText(t, problem) })
    return false
  }

  const objectUrl = async (node: FileNode): Promise<string | null> => {
    const cached = urlCacheRef.current.get(node.id)
    if (cached !== undefined) return cached
    const blob = await client.download(node)
    if (blob === null) return null
    const url = URL.createObjectURL(blob)
    urlCacheRef.current.set(node.id, url)
    return url
  }

  const download = async (node: FileNode): Promise<void> => {
    const url = await objectUrl(node)
    if (url === null) return
    const anchor = document.createElement('a')
    anchor.href = url
    // Never `node.name` raw. This app validates a name before it creates one, but the name on a
    // node came from whatever wrote it — another client, or a server that does not agree with
    // `fileNodeNameProblem` — and this value becomes a path on the reader's disk.
    anchor.download = safeDownloadName(node.name, DOWNLOAD_FALLBACK)
    anchor.click()
  }

  const togglePreview = async (node: FileNode): Promise<void> => {
    if (preview?.id === node.id) {
      setPreview(null)
      return
    }
    const url = await objectUrl(node)
    if (url !== null) setPreview({ id: node.id, type: node.type ?? '', url })
  }

  /**
   * Walk the tree to `folder` and show it, leaving the search behind.
   *
   * A hit's row states where it was found, and that statement is the control that goes there — the
   * Finder's "Show in enclosing folder", which is the only way a flat result list can hand the
   * reader back their bearings. It costs one `FileNode/get` per level because the breadcrumb has to
   * be TRUE: dropping the reader into `Files / Invoices` when the folder is three deep would be a
   * cheaper lie, not a cheaper answer.
   */
  const openFolder = async (folder: FileNode): Promise<void> => {
    setTerm('')
    setQuery('')
    let chain: readonly FileNode[] = []
    try {
      chain = await client.ancestors(folder)
    } catch {
      // A failed walk is not a failed navigation: the folder is still the folder. The breadcrumb
      // is then shorter than the truth, which the next reload corrects.
    }
    setPath([
      { id: null, name: '' },
      ...chain.map((node) => ({ id: node.id, name: node.name })),
      { id: folder.id, name: folder.name },
    ])
  }

  /**
   * Move to another account's root — a shared one with an id, the user's own with `null` (S-4).
   *
   * Everything the previous account put on screen goes with it: the path, the search, the selection.
   * File node ids are per-account and short, so a selection carried across would name real but
   * DIFFERENT files in the account it landed in — the same hazard `resetMailScopedStores` exists for
   * in mail, and the reason this is one function rather than a `setVisitingId` at each call site.
   */
  const goToAccount = (id: Id | null): void => {
    setVisitingId(id)
    setPath([{ id: null, name: '' }])
    setTerm('')
    setQuery('')
    setSelecting(false)
    setSelected(new Set())
    setPreview(null)
    // The SERVER-backed listing only (a share). The replicated one is a live query keyed on the
    // level, so it re-answers for the new account by itself and has nothing to clear.
    setRemoteNodes(null)
    setRemoteHits(null)
    setRemoteTruncated(false)
  }

  const toggle = (id: Id): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  /**
   * Move, then offer to put it back.
   *
   * A move is the one file operation this server makes reversible — `parentId` is a property like
   * any other — so it gets ADR-021's undo: an action-bearing toast that does not expire, reachable
   * by `z` as well as by pointer. The nodes are grouped by where they CAME from, because a
   * selection made in search results can span several folders and "undo" has to mean "back where
   * each of them was", not "all into the first one".
   */
  const doMove = (targets: readonly FileNode[], parentId: Id | null, label: string): void => {
    const ids = targets.map((node) => node.id)
    const origin = new Map<Id | null, Id[]>()
    for (const node of targets) {
      const from = node.parentId ?? null
      origin.set(from, [...(origin.get(from) ?? []), node.id])
    }
    setMoving(null)
    setSelected(new Set())
    void run(async () => {
      await client.move(ids, parentId)
      toast({
        tone: 'success',
        title: t('files.move.done', { name: label }),
        duration: 0,
        action: {
          label: t('files.move.undo'),
          onAction: () => {
            void run(async () => {
              for (const [from, group] of origin) await client.move(group, from)
            })
          },
        },
      })
    })
  }

  const sortMenuItems: MenuItemSpec[] = offeredSortKeys(capability).map((key) => {
    const active = sort.key === key
    return {
      id: `sort-${key}`,
      label: sortLabel(t, key),
      // The arrow is both the checkmark and the direction: an active key shows which way it runs,
      // and choosing it again turns it round. That is the column header of every file manager,
      // reduced to the one gesture a menu can carry.
      ...(active ? { icon: sort.ascending ? ArrowUp : ArrowDown } : {}),
      onSelect: () => setSort({ key, ascending: active ? !sort.ascending : true }),
    }
  })

  const barMenuItems: MenuItemSpec[] = [
    {
      id: 'select',
      label: selecting ? t('files.selection.stop') : t('files.selection.start'),
      icon: ListChecks,
      onSelect: () => {
        setSelecting((was) => !was)
        setSelected(new Set())
      },
    },
    ...sortMenuItems,
  ]

  return (
    <div className={styles.page}>
      {/* Where you are and what you can do here, in the shell header on a phone and in its own
          strip elsewhere — the arrangement mail has had since the first audit. This screen used to
          state its location in a 12px breadcrumb and nothing else: it was the one screen with no
          heading at all. */}
      <ScreenBar>
        {/* The folder you are IN is the heading; the ones above it are the way back.
            It used to be a disabled ghost button at the end of a 12px breadcrumb — the only screen
            in the app with no heading at all, while mail, contacts and calendar all state where
            you are in the same 16px semibold. */}
        <nav className={styles.crumbs} aria-label={t('files.breadcrumb')}>
          {/* Inside a shared account the trail starts one step further back, at the reader's OWN
              root — the way out. Apple's Files does the same: "Shared" is a place you walked into
              and walk out of, not a mode you have to know how to leave. */}
          {visiting !== null && (
            <span className={styles.crumb}>
              <Button variant="ghost" size="sm" onClick={() => goToAccount(null)}>
                {t('files.root')}
              </Button>
              <span aria-hidden="true">/</span>
            </span>
          )}
          {path.slice(0, -1).map((crumb, index) => (
            <span key={crumb.id ?? 'root'} className={styles.crumb}>
              <Button variant="ghost" size="sm" onClick={() => setPath(path.slice(0, index + 1))}>
                {crumb.id === null ? rootName : crumb.name}
              </Button>
              <span aria-hidden="true">/</span>
            </span>
          ))}
        </nav>
        <h1 className={shellStyles.paneTitle}>
          {here === null ? rootName : (path.at(-1)?.name ?? t('files.title'))}
        </h1>
        <IconButton
          label={t('files.newFolder')}
          variant="ghost"
          disabled={busy}
          unavailableReason={online ? undefined : t('files.offline')}
          onClick={() => setFolderDialogOpen(true)}
        >
          <FolderPlus />
        </IconButton>
        <IconButton
          label={t('files.upload')}
          variant="ghost"
          disabled={busy}
          unavailableReason={online ? undefined : t('files.offline')}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload />
        </IconButton>
        {/* Everything about the LISTING rather than about this folder — how it is ordered, and
            whether you are picking things out of it. One trigger, because a phone header is one
            row and the two visible buttons above are the two things you came here to do. */}
        <Menu
          triggerLabel={t('files.listOptions')}
          trigger={<Ellipsis aria-hidden="true" />}
          align="end"
          triggerVariant="toolbar"
          items={barMenuItems}
        />
        <input
          ref={fileInputRef}
          type="file"
          // Several at once (D-2). The picker allowed exactly one file per trip to it, which for a
          // folder of scans means the dialog eleven times.
          multiple
          className={styles.fileInput}
          aria-label={t('files.upload')}
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])]
            event.target.value = ''
            if (chosen.length === 0) return
            // Every name checked BEFORE the first byte goes up: a batch that fails halfway leaves
            // the reader working out which of eleven files landed, and the check is free.
            if (!chosen.every((file) => checkName(file.name))) return
            void run(async () => {
              for (const file of chosen) await client.upload(file, here)
            })
          }}
        />
      </ScreenBar>

      {/* A field, not a screen. Above the list because that is where the list's own controls
          belong, and always visible because a search you have to reveal is one nobody finds. */}
      <div className={styles.search}>
        <Search aria-hidden="true" className={styles.searchIcon} />
        <TextInput
          type="search"
          value={term}
          aria-label={t('files.search.label')}
          placeholder={t('files.search.placeholder')}
          onChange={(event) => setTerm(event.target.value)}
        />
      </div>

      {/* A plain container, like mail's bulk bar: every control in it is named, and a `group` role
          over five labelled buttons adds an announcement without adding information. */}
      {selecting && (
        <div className={styles.selectionBar}>
          <Checkbox
            checked={allSelected}
            indeterminate={selectedNodes.length > 0 && !allSelected}
            // The name follows the ACTION. Once everything is picked this control clears the
            // selection, and a control that announces the opposite of what it does is worse than
            // an unnamed one — for a screen-reader user the name is all there is.
            aria-label={allSelected ? t('files.selection.clear') : t('files.selection.all')}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(visibleNodes.map((node) => node.id)))
            }
          />
          <span className={styles.selectionCount}>
            {t('files.selection.count', { count: selectedNodes.length })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || selectedNodes.length === 0}
            onClick={() => setMoving(selectedNodes)}
          >
            {t('files.move.action')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || selectedNodes.length === 0}
            onClick={() => setDeleting(selectedNodes)}
          >
            {t('files.deleteAction')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelecting(false)
              setSelected(new Set())
            }}
          >
            {t('files.selection.stop')}
          </Button>
        </div>
      )}

      {folderDialogOpen && (
        <Dialog
          open
          title={t('files.newFolder')}
          onClose={() => {
            setFolderDialogOpen(false)
            setNewFolder('')
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setFolderDialogOpen(false)
                  setNewFolder('')
                }}
              >
                {t('files.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || newFolder.trim() === ''}
                onClick={() => {
                  const name = newFolder.trim()
                  if (!checkName(name)) return
                  setNewFolder('')
                  setFolderDialogOpen(false)
                  void run(() => client.createFolder(name, here))
                }}
              >
                {t('files.newFolder')}
              </Button>
            </>
          }
        >
          <TextInput
            autoFocus
            value={newFolder}
            aria-label={t('files.newFolder')}
            onChange={(event) => setNewFolder(event.target.value)}
          />
        </Dialog>
      )}

      {renaming !== null && (
        <Dialog
          open
          title={t('files.rename.title', { name: renaming.name })}
          onClose={() => setRenaming(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                {t('files.cancel')}
              </Button>
              <Button
                variant="primary"
                // Unchanged is not a rename: `FileNode/set` would accept the no-op and the reader
                // would get a round trip and a reload for nothing.
                disabled={busy || renameTo.trim() === '' || renameTo.trim() === renaming.name}
                onClick={() => {
                  const name = renameTo.trim()
                  const { id } = renaming
                  // The same client-side name check the upload and the new folder go through, and
                  // for the same reason: the server refuses `:` and `AUX` for Windows-compatibility
                  // reasons that have nothing to do with what the user meant. Left OPEN on a bad
                  // name — the dialog is where the name is, so it is where the objection belongs.
                  if (!checkName(name)) return
                  setRenaming(null)
                  void run(() => client.rename(id, name))
                }}
              >
                {t('files.rename.confirm')}
              </Button>
            </>
          }
        >
          <TextInput
            autoFocus
            value={renameTo}
            aria-label={t('files.rename.label')}
            onChange={(event) => setRenameTo(event.target.value)}
          />
        </Dialog>
      )}

      {moving !== null && moving.length > 0 && (
        <FileMoveDialog
          nodes={moving}
          // Only where every node agrees on where it is now. A selection made in search results can
          // span three folders, and there is then no single "already here" to refuse.
          {...commonParent(moving)}
          client={client}
          onClose={() => setMoving(null)}
          onMove={(parentId, label) => doMove(moving, parentId, label)}
        />
      )}

      {deleting !== null && deleting.length > 0 && (
        <Dialog
          open
          size="sm"
          title={t('files.deleteAction')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                {t('files.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const ids = deleting.map((node) => node.id)
                  setDeleting(null)
                  setSelected(new Set())
                  void run(() => client.destroy(ids))
                }}
              >
                {t('files.deleteAction')}
              </Button>
            </>
          }
        >
          {/*
           * ASKED, NOT UNDONE — and the difference is the server's, not a preference (B-7).
           *
           * Triage offers Undo because an archived message still exists somewhere and can be moved
           * back. `FileNode/set destroy` has nowhere to move back FROM: this server keeps no trash
           * role for file nodes and offers no restore, so an "Undo" here could only mean re-uploading
           * bytes the client no longer holds. A toast promising that would be the worst kind of
           * wrong — the one that is believed. So the question is asked BEFORE, which is also the
           * Finder's answer to a delete that skips the trash, and the sentence says which kind of
           * delete this is rather than merely counting what is selected.
           */}
          <p>{t('files.confirmDeleteBody', { count: deleting.length })}</p>
          {deleting.some((node) => node.nodeType === 'directory') && (
            <p>{t('files.confirmDeleteFolder')}</p>
          )}
        </Dialog>
      )}

      {/*
        Failure, staleness and emptiness are three different things, and D-4 changed which one wins.

        It used to be failure-first, so a lost connection replaced a folder this device was holding
        with "Your files could not be loaded." Now a tree that has ever synced is SHOWN, and the fact
        that it is not being refreshed is one quiet line above it. The loud, retryable failure is
        reserved for the case where there is genuinely nothing to show.
      */}
      {!online && replicated && !neverSynced && (
        <p className={styles.truncated} role="status">
          <CloudOff aria-hidden="true" className={styles.icon} />
          {treeState !== undefined && treeState.syncedAt > 0
            ? t('files.offlineStale', { when: formatRelativeTime(treeState.syncedAt) })
            : t('files.offlineNotUpdating')}
        </p>
      )}
      {!online && neverSynced && (
        <EmptyState
          icon={CloudOff}
          title={t('files.offlineNever.title')}
          description={t('files.offlineNever.body')}
        />
      )}
      {online &&
        failed &&
        (rows === null || rows.length === 0 ? (
          <EmptyState
            tone="error"
            icon={TriangleAlert}
            title={t('files.loadFailed')}
            action={
              <Button variant="secondary" onClick={() => void load()}>
                {t('files.retry')}
              </Button>
            }
          />
        ) : (
          // A failure with usable rows keeps the rows and reports in one line above them. A red pane
          // over a listing that looks complete is the worse of the two answers (the calendar's T5).
          <p className={styles.truncated} role="alert">
            <TriangleAlert aria-hidden="true" className={styles.icon} />
            {t('files.refreshFailed')}
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t('files.retry')}
            </Button>
          </p>
        ))}

      {/*
       * SHARED CONTENT IS A SECTION OF THIS SCREEN, NOT ANOTHER SCREEN (S-4).
       *
       * The iCloud arrangement, and the one the mail rail already uses: your own things and other
       * people's sit in the same place, one under the other, and there is no account switcher to
       * find first. A reader who has been given a folder walks into it the way they walk into any
       * folder — which is also why the rows look like folder rows and carry the owner's name rather
       * than a badge saying "shared".
       *
       * It sits ABOVE the listing and outside its loading/empty branch on purpose: an own root that
       * is empty is exactly the account where someone else's folder is the only thing there is, and
       * hiding it behind "This folder is empty." would be the worst possible moment to.
       */}
      {showShared && (
        <section className={styles.sharedSection} aria-label={t('files.shared.title')}>
          <h2 className={styles.sharedHeading}>{t('files.shared.title')}</h2>
          <ul className={styles.list}>
            {sharedAccounts.map((account) => (
              <li key={account.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.name}
                  // The visible text is the name; the label says what the row DOES with it, and
                  // contains that name (WCAG 2.5.3) so speech input still works on what is read.
                  aria-label={t('files.shared.open', { name: account.name })}
                  onClick={() => goToAccount(account.id)}
                >
                  <span className={styles.nameInner}>
                    <UsersRound aria-hidden="true" className={styles.icon} />
                    <span className={styles.nameText}>{account.name}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows === null && !failed ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : !online && neverSynced ? null : rows !== null && rows.length === 0 ? (
        <EmptyState
          icon={searching ? Search : FolderOpen}
          title={searching ? t('files.search.none', { query }) : t('files.empty')}
        />
      ) : (
        <ul className={styles.list} ref={listRef}>
          {(rows ?? []).map(({ node, parent }) => {
            const isDirectory = node.nodeType === 'directory'
            /*
             * Every action this node grants, in the order the row has always shown them: view,
             * share, rename, move, download, delete. Built as data so the split below can hand the
             * tail to the `⋯` menu — see the `RowAction` note and `use-row-actions.ts`.
             */
            const actions: RowAction[] = []
            if (!isDirectory && node.myRights.mayRead && isPreviewable(node.type)) {
              const open = preview?.id === node.id
              actions.push({
                id: 'preview',
                label: open
                  ? t('files.hidePreview', { name: node.name })
                  : t('files.preview', { name: node.name }),
                icon: Eye,
                disabled: false,
                destructive: false,
                expanded: open,
                onSelect: () => void togglePreview(node),
              })
            }
            if (mayShare(node.myRights)) {
              actions.push({
                id: 'share',
                label: t('files.share.open', { name: node.name }),
                icon: UsersRound,
                disabled: false,
                destructive: false,
                expanded: undefined,
                onSelect: () => setSharing(node),
              })
            }
            // Gated on the server's own `mayRename`, like delete is on `mayDelete`: the flag is on
            // the record precisely so a client does not have to offer the failure. This was the one
            // action of the seven this screen claims that had no control at all —
            // `filesClient.rename()` existed and shipped with no caller outside its test.
            if (node.myRights.mayRename) {
              actions.push({
                id: 'rename',
                label: t('files.rename.open', { name: node.name }),
                icon: Pencil,
                disabled: busy,
                destructive: false,
                expanded: undefined,
                onSelect: () => {
                  setRenaming(node)
                  setRenameTo(node.name)
                },
              })
            }
            /*
             * MOVE IS OFFERED UNCONDITIONALLY, and that is a departure from the two above it.
             *
             * `myRights` is measured to be wrong for exactly this case: under a shared FOLDER the
             * download access is inherited correctly while every flag on the CHILD node comes back
             * `false` (D-7). Gating move on `mayRename` would therefore hide it precisely where a
             * grantee has been given the run of a folder — a capability the server would honour,
             * withheld by the client on the strength of a field the server fills in wrongly.
             *
             * The other direction is survivable: a refused move is one `FileNode/set`, and `run`
             * turns `forbidden` into a sentence. An action that fails loudly beats one that is
             * missing silently.
             */
            actions.push({
              id: 'move',
              label: t('files.move.open', { name: node.name }),
              icon: FolderInput,
              disabled: busy,
              destructive: false,
              expanded: undefined,
              onSelect: () => setMoving([node]),
            })
            if (!isDirectory && node.myRights.mayRead) {
              actions.push({
                id: 'download',
                label: t('files.download', { name: node.name }),
                icon: Download,
                disabled: false,
                destructive: false,
                expanded: undefined,
                onSelect: () => void download(node),
              })
            }
            if (node.myRights.mayDelete) {
              actions.push({
                id: 'delete',
                label: t('files.delete', { name: node.name }),
                icon: Trash2,
                disabled: busy,
                destructive: true,
                expanded: undefined,
                onSelect: () => setDeleting([node]),
              })
            }
            const visible = visibleRowActions(geometry, actions.length)
            const hidden: MenuItemSpec[] = actions.slice(visible).map((action) => ({
              id: action.id,
              label: action.label,
              icon: action.icon,
              disabled: action.disabled,
              // Spread rather than `destructive={false}`: `MenuItemSpec` states it as optional and
              // the repo compiles with `exactOptionalPropertyTypes`.
              ...(action.destructive ? { destructive: true } : {}),
              onSelect: action.onSelect,
            }))

            const label = (
              <span className={styles.nameInner}>
                {isDirectory ? (
                  <Folder aria-hidden="true" className={styles.icon} />
                ) : (
                  <FileIcon aria-hidden="true" className={styles.icon} />
                )}
                <span className={styles.nameText}>{node.name}</span>
              </span>
            )

            return (
              <li key={node.id} className={styles.row} {...{ [ROW_PART.row]: '' }}>
                {selecting ? (
                  // The checkbox IS the row: its own `<label>` carries the icon and the name, so
                  // the whole line is the target rather than a 1.15rem square beside one. Wrapped
                  // rather than class-named, because `Checkbox` hands `className` to its INPUT.
                  <span className={styles.selectName} {...{ [ROW_PART.name]: '' }}>
                    <Checkbox
                      checked={selected.has(node.id)}
                      onChange={() => toggle(node.id)}
                      label={label}
                    />
                  </span>
                ) : isDirectory ? (
                  <button
                    type="button"
                    className={styles.name}
                    {...{ [ROW_PART.name]: '' }}
                    onClick={() => {
                      // From a search result the way in has to be walked, so the breadcrumb tells
                      // the truth about where the folder actually sits.
                      if (searching) void openFolder(node)
                      else setPath([...path, { id: node.id, name: node.name }])
                    }}
                  >
                    {label}
                  </button>
                ) : (
                  <span className={styles.name} {...{ [ROW_PART.name]: '' }}>
                    {label}
                  </span>
                )}
                {/* Where a hit was found — and the way there. Only in search results: inside a
                    folder every row shares the same answer, and repeating it is noise. */}
                {searching && (
                  <span className={styles.location}>
                    {parent === null ? (
                      <Button variant="ghost" size="sm" onClick={() => void openFolder(node)}>
                        {t('files.search.inRoot')}
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => void openFolder(parent)}>
                        {t('files.search.in', { name: parent.name })}
                      </Button>
                    )}
                  </span>
                )}
                <span className={styles.size} {...{ [ROW_PART.size]: '' }}>
                  {isDirectory ? '' : formatBytes(node.size)}
                </span>
                {!selecting && (
                  <span className={styles.rowActions} {...{ [ROW_PART.actions]: '' }}>
                    {actions.slice(0, visible).map((action) => (
                      <IconButton
                        key={action.id}
                        label={action.label}
                        variant="ghost"
                        size="sm"
                        disabled={action.disabled}
                        aria-expanded={action.expanded}
                        onClick={action.onSelect}
                      >
                        <action.icon />
                      </IconButton>
                    ))}
                    {hidden.length > 0 && (
                      <Menu
                        triggerLabel={t('files.more', { name: node.name })}
                        trigger={<Ellipsis aria-hidden="true" />}
                        align="end"
                        triggerVariant="toolbar"
                        items={hidden}
                      />
                    )}
                  </span>
                )}
                {preview?.id === node.id && (
                  <div className={styles.preview}>
                    {previewSurface(preview.type) === 'image' ? (
                      // A blob: URL for the file just downloaded — no second network fetch, and no
                      // `<img src={downloadUrl}>`, which would send the bytes without our
                      // credentials.
                      <img src={preview.url} alt={node.name} className={styles.previewImage} />
                    ) : (
                      // `sandbox=""` denies everything, same-origin included: a blob: URL carries
                      // this app's origin, and taking it away is the whole reason the frame is safe.
                      <iframe
                        src={preview.url}
                        title={node.name}
                        sandbox=""
                        className={styles.previewFrame}
                      />
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/*
       * THE LISTING SAYS WHEN IT IS NOT ALL OF IT (B-6).
       *
       * `maxObjectsInGet` is 500 and the root query is unfiltered, so a large account outruns what
       * this client will fetch. The old behaviour was to stop and say nothing, which is the actual
       * defect: a folder that is short and LOOKS complete makes every conclusion drawn from it
       * wrong. Muted and at the end of the list rather than banner-loud at the top — it is a fact
       * about the listing, not a failure, and search is the way past it.
       */}
      {truncated && !searching && (
        <p className={styles.truncated} role="status">
          <Info aria-hidden="true" className={styles.icon} />
          {t('files.truncated')}
        </p>
      )}

      {sharing !== null && (
        <ShareDialog
          node={sharing}
          client={client}
          onClose={() => setSharing(null)}
          // The list carries `shareWith`, and the dialog has just changed it — without this the
          // row behind the dialog would keep claiming the old grant until the next navigation.
          onChanged={() => void load()}
        />
      )}
    </div>
  )
}

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function errorText(t: (key: string) => string, key: string): string {
  switch (key) {
    case 'files.error.nameTaken':
      return t('files.error.nameTaken')
    case 'files.error.tooLarge':
      return t('files.error.tooLarge')
    case 'files.error.overQuota':
      return t('files.error.overQuota')
    case 'files.error.forbidden':
      return t('files.error.forbidden')
    default:
      return t('files.error.rejected')
  }
}

function nameProblemText(t: (key: string) => string, problem: string): string {
  switch (problem) {
    case 'empty':
      return t('files.name.empty')
    case 'tooLong':
      return t('files.name.tooLong')
    case 'forbiddenCharacter':
      return t('files.name.forbiddenCharacter')
    default:
      return t('files.name.reservedName')
  }
}

/** Spelled out for the same reason as {@link errorText}. */
function sortLabel(t: (key: string) => string, key: FileSortKey): string {
  switch (key) {
    case 'size':
      return t('files.sort.bySize')
    case 'nodeType':
      return t('files.sort.byKind')
    default:
      return t('files.sort.byName')
  }
}

/**
 * The folder every one of these nodes is in, as a prop the picker can refuse to move them to.
 *
 * Absent — not `null` — where they disagree: `null` is a real answer here ("the root"), so the two
 * cases cannot share a value. Spread rather than passed, because the repo compiles with
 * `exactOptionalPropertyTypes` and `undefined` is not the same as not-there.
 */
function commonParent(nodes: readonly FileNode[]): { currentParentId?: Id | null } {
  const parents = new Set(nodes.map((node) => node.parentId ?? null))
  const only = [...parents][0]
  return parents.size === 1 ? { currentParentId: only ?? null } : {}
}

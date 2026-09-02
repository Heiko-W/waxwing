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
 *   header is one row; five controls in it is not a design, it is a queue. Below 40em even those
 *   two join the menu, because the row is shared with the shell's own controls and the folder name
 *   was what gave way (measured at 24px on 2026-08-22 — see the ScreenBar block).
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
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { delegatedAccountsFor } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import { useLayoutTier } from '../app/shell/layout'
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
import { ROW_PART, type RowGeometry, useRowGeometry, visibleRowActions } from './use-row-actions'

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
  /**
   * Why the action cannot be used right now, for an action that is REFUSED rather than absent.
   *
   * The page header promises everything that needs a line is "greyed out with a reason"; the three
   * writing actions in the row were the ones that were not (R-24). `IconButton` renders it as an
   * `aria-disabled` control with the reason as its description, so the control stays reachable by
   * keyboard and the reason is readable — which a `disabled` attribute alone is not.
   */
  readonly unavailableReason: string | undefined
  readonly destructive: boolean
  /** Whether the surface this toggles is open; `undefined` for everything that is not a toggle. */
  readonly expanded: boolean | undefined
  readonly onSelect: () => void
}

/**
 * ONE line of the listing, memoised (R-61).
 *
 * The list used to be built inline, so every keystroke in the search box, every checkbox and every
 * preview toggle re-rendered every row — and a row is not cheap: up to six `RowAction`s, a context
 * `Menu`, an overflow `Menu`, six `IconButton`s and a `Checkbox`. Measured in jsdom (not a browser,
 * so read the numbers as an order of magnitude, not a budget): one keystroke cost 43 ms over 100
 * rows, 135 ms over 300 and 455 ms over 1 000.
 *
 * NOT virtualised, deliberately. `MessageList` and `ContactList` are, because a mailbox and an
 * address book have no ceiling; a folder does — the listing stops at `MAX_PAGES` and says so — and
 * the review that raised this asked for a measurement before the machinery. With the search field
 * holding its own text ({@link FileSearchField}) the per-keystroke render is gone entirely, and
 * with this `memo` a checkbox re-renders one row instead of all of them. Virtualising on top of
 * that would buy the mount, at the price of the row heights this list does not have (a row grows
 * when its preview opens) — so it waits for a measurement in a real browser that asks for it.
 *
 * Every callback below is stable in the parent (`useCallback`, functional `setState`), which is
 * what makes the `memo` do anything at all.
 */
interface FileRowProps {
  readonly node: FileNode
  /** In search results only: the folder the hit was found in. */
  readonly parent: FileNode | null
  readonly geometry: RowGeometry
  readonly busy: boolean
  readonly online: boolean
  readonly searching: boolean
  readonly selecting: boolean
  readonly selected: boolean
  /** This row's open preview, or `null` — not the screen's, so a toggle elsewhere is not our news. */
  readonly preview: { readonly type: string; readonly url: string } | null
  readonly onToggleSelect: (id: Id) => void
  readonly onOpenFolder: (node: FileNode, searching: boolean) => void
  readonly onTogglePreview: (node: FileNode, open: boolean) => void
  readonly onDownload: (node: FileNode) => void
  readonly onShare: (node: FileNode) => void
  readonly onRename: (node: FileNode) => void
  readonly onMove: (node: FileNode) => void
  readonly onDelete: (node: FileNode) => void
}

const FileRow = memo(function FileRow({
  node,
  parent,
  geometry,
  busy,
  online,
  searching,
  selecting,
  selected,
  preview,
  onToggleSelect,
  onOpenFolder,
  onTogglePreview,
  onDownload,
  onShare,
  onRename,
  onMove,
  onDelete,
}: FileRowProps) {
  const { t } = useTranslation()
  /** This row's own `<li>`, so its secondary click finds itself (no shared map to keep in step). */
  const rowRef = useRef<HTMLLIElement>(null)
  const isDirectory = node.nodeType === 'directory'
  /** Everything that cannot happen without a line carries the reason rather than vanishing (R-24). */
  const offline = online ? undefined : t('files.offline')
  /*
   * Every action this node grants, in the order the row has always shown them: view, share,
   * rename, move, download, delete. Built as data so the split below can hand the tail to the `⋯`
   * menu — see the `RowAction` note and `use-row-actions.ts`.
   */
  const actions: RowAction[] = []
  if (!isDirectory && node.myRights.mayRead && isPreviewable(node.type)) {
    const open = preview !== null
    actions.push({
      id: 'preview',
      label: open
        ? t('files.hidePreview', { name: node.name })
        : t('files.preview', { name: node.name }),
      icon: Eye,
      disabled: false,
      // Opening the bytes needs a line — the page header says so, and this is where it has to be
      // said. Closing an open one does not, so it stays available.
      unavailableReason: open ? undefined : offline,
      destructive: false,
      expanded: open,
      onSelect: () => onTogglePreview(node, open),
    })
  }
  if (mayShare(node.myRights)) {
    actions.push({
      id: 'share',
      label: t('files.share.open', { name: node.name }),
      icon: UsersRound,
      disabled: false,
      unavailableReason: offline,
      destructive: false,
      expanded: undefined,
      onSelect: () => onShare(node),
    })
  }
  // Gated on the server's own `mayRename`, like delete is on `mayDelete`: the flag is on the record
  // precisely so a client does not have to offer the failure. This was the one action of the seven
  // this screen claims that had no control at all — `filesClient.rename()` existed and shipped with
  // no caller outside its test.
  if (node.myRights.mayRename) {
    actions.push({
      id: 'rename',
      label: t('files.rename.open', { name: node.name }),
      icon: Pencil,
      disabled: busy,
      unavailableReason: offline,
      destructive: false,
      expanded: undefined,
      onSelect: () => onRename(node),
    })
  }
  /*
   * MOVE IS OFFERED UNCONDITIONALLY, and that is a departure from the two above it.
   *
   * `myRights` is measured to be wrong for exactly this case: under a shared FOLDER the download
   * access is inherited correctly while every flag on the CHILD node comes back `false` (D-7).
   * Gating move on `mayRename` would therefore hide it precisely where a grantee has been given
   * the run of a folder — a capability the server would honour, withheld by the client on the
   * strength of a field the server fills in wrongly.
   *
   * The other direction is survivable: a refused move is one `FileNode/set`, and `run` turns
   * `forbidden` into a sentence. An action that fails loudly beats one that is missing silently.
   */
  actions.push({
    id: 'move',
    label: t('files.move.open', { name: node.name }),
    icon: FolderInput,
    disabled: busy,
    unavailableReason: offline,
    destructive: false,
    expanded: undefined,
    onSelect: () => onMove(node),
  })
  if (!isDirectory && node.myRights.mayRead) {
    actions.push({
      id: 'download',
      label: t('files.download', { name: node.name }),
      icon: Download,
      disabled: false,
      unavailableReason: offline,
      destructive: false,
      expanded: undefined,
      onSelect: () => onDownload(node),
    })
  }
  if (node.myRights.mayDelete) {
    actions.push({
      id: 'delete',
      label: t('files.delete', { name: node.name }),
      icon: Trash2,
      disabled: busy,
      unavailableReason: offline,
      destructive: true,
      expanded: undefined,
      onSelect: () => onDelete(node),
    })
  }
  const visible = visibleRowActions(geometry, actions.length)
  const asMenuItems = (list: typeof actions): MenuItemSpec[] =>
    list.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      // A menu item has nowhere to put `unavailableReason`, so there it is a plain `disabled` —
      // the same choice the bar menu makes for the same reason.
      disabled: action.disabled || action.unavailableReason !== undefined,
      // Spread rather than `destructive={false}`: `MenuItemSpec` states it as optional and the
      // repo compiles with `exactOptionalPropertyTypes`.
      ...(action.destructive ? { destructive: true } : {}),
      onSelect: action.onSelect,
    }))
  // The overflow menu carries what did not fit; the CONTEXT menu carries everything, which is the
  // difference between a spill-over and a menu of the row's commands.
  const hidden: MenuItemSpec[] = asMenuItems(actions.slice(visible))
  const rowMenuItems: MenuItemSpec[] = asMenuItems(actions)

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
    <li ref={rowRef} className={styles.row} {...{ [ROW_PART.row]: '' }}>
      {/* A secondary click anywhere in the row opens the row's commands — the same rule the folder
          tree, the label list and the message list follow. HIG `context-menus` asks for
          consistency by name: a feature offered on some rows and not others is one nobody learns.
          No trigger of its own; the visible affordances are the row's buttons and the ⋯ beside
          them. */}
      <Menu
        trigger={null}
        triggerLabel={t('files.more', { name: node.name })}
        contextTarget={() => rowRef.current}
        items={rowMenuItems}
      />
      {selecting ? (
        // The checkbox IS the row: its own `<label>` carries the icon and the name, so the whole
        // line is the target rather than a 1.15rem square beside one. Wrapped rather than
        // class-named, because `Checkbox` hands `className` to its INPUT.
        <span className={styles.selectName} {...{ [ROW_PART.name]: '' }}>
          <Checkbox checked={selected} onChange={() => onToggleSelect(node.id)} label={label} />
        </span>
      ) : isDirectory ? (
        <button
          type="button"
          className={styles.name}
          {...{ [ROW_PART.name]: '' }}
          onClick={() => onOpenFolder(node, searching)}
        >
          {label}
        </button>
      ) : (
        <span className={styles.name} {...{ [ROW_PART.name]: '' }}>
          {label}
        </span>
      )}
      {/* Where a hit was found — and the way there. Only in search results: inside a folder every
          row shares the same answer, and repeating it is noise. */}
      {searching && (
        <span className={styles.location}>
          {parent === null ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenFolder(node, true)}>
              {t('files.search.inRoot')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => onOpenFolder(parent, true)}>
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
              unavailableReason={action.unavailableReason}
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
      {preview !== null && (
        <div className={styles.preview}>
          {previewSurface(preview.type) === 'image' ? (
            // A blob: URL for the file just downloaded — no second network fetch, and no
            // `<img src={downloadUrl}>`, which would send the bytes without our credentials.
            <img src={preview.url} alt={node.name} className={styles.previewImage} />
          ) : (
            // `sandbox=""` denies everything, same-origin included: a blob: URL carries this app's
            // origin, and taking it away is the whole reason the frame is safe.
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
})

/**
 * The search box, holding its own text (R-61).
 *
 * The field used to be state of the whole screen, so every keystroke re-rendered the page and its
 * entire listing — while the rows themselves do not change until the 250 ms debounce fires. Only
 * the debounced value goes up now; the letters stay here.
 *
 * The screen resets it by changing `key` (walking into a folder, or into another account leaves
 * the search behind), which is React's own way of saying "start over" and needs no second channel
 * back down.
 */
const FileSearchField = memo(function FileSearchField({
  onQuery,
}: {
  readonly onQuery: (query: string) => void
}) {
  const { t } = useTranslation()
  const [term, setTerm] = useState('')

  // The field leads the request by a beat. Trimmed here so " " is a blank search, not a search for
  // a space — which the server would answer with the whole account.
  useEffect(() => {
    const timer = setTimeout(() => onQuery(term.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, onQuery])

  return (
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
  )
})

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
  /** Which shape the screen's own bar takes — see the ScreenBar block below. */
  const tier = useLayoutTier()
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
  /**
   * What has actually been asked for. The LETTERS live in {@link FileSearchField} (R-61); only the
   * debounced text arrives here, so typing does not re-render the listing.
   *
   * `searchEpoch` is how the screen clears the field: it is the field's `key`, so bumping it mounts
   * a fresh one — React's own "start over", rather than a second channel back down into a child.
   */
  const [query, setQuery] = useState('')
  const [searchEpoch, setSearchEpoch] = useState(0)
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)
  /** Selecting is a mode. Nothing is pickable until the reader says so. */
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<Id>>(() => new Set())
  /** The nodes a move is being chosen for, or null. */
  const [moving, setMoving] = useState<readonly FileNode[] | null>(null)
  /** The nodes a delete is being confirmed for, or null (B-7). */
  const [deleting, setDeleting] = useState<readonly FileNode[] | null>(null)
  /**
   * One object URL per set of BYTES, reused across toggles and revoked once on unmount — re-opening
   * a preview neither downloads the file again nor leaks the superseded URL.
   *
   * Keyed by account AND `blobId`, not by node id (R-22). Stalwart hands out short, per-account
   * node ids, so `n1` exists in almost every account: after previewing your own `photo.png` and
   * walking into "Shared with me → carol", the cache answered for carol's `n1` with YOUR bytes —
   * shown in the preview and saved under HER filename by Download. The blob id is what actually
   * names the bytes, so it also fixes the second half: a file replaced under the same node id gets
   * a new `blobId` and no longer serves the old content for the rest of the session.
   */
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
  /** The two name dialogs are forms, so Enter submits them; footer button ↔ body form by id. */
  const newFolderFormId = useId()
  const renameFormId = useId()

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
   * WHICH listing is being asked for, as one value — the stamp a late answer is checked against
   * (R-23).
   *
   * Every response of the remote path used to be written into the state unchecked. Walking into a
   * slow shared folder and then clicking the breadcrumb back to the root let the folder's answer
   * land AFTER the root's: heading and list disagreed, and a bulk action — Delete among them —
   * then pointed at nodes outside the folder on screen. The replicated path is immune because it
   * reads keyed, which is why this guard is only needed on the other one.
   *
   * The account is part of the stamp, not just the folder: `null` is the root of every account,
   * and the reader can leave a share while its root listing is in flight.
   */
  const request = `${accountId ?? ''}\u0000${here ?? ''}\u0000${query}`
  const requestRef = useRef(request)
  // `useLayoutEffect` for the reason `loadRef` below gives: a passive effect is its own task, and
  // the answer must not be checked against a stamp a commit out of date.
  useLayoutEffect(() => {
    requestRef.current = request
  }, [request])

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
        const found = await client.search(query, wire)
        if (requestRef.current !== request) return true
        setRemoteHits(found)
        setRemoteTruncated(false)
      } else {
        const listing = await client.list(here, wire)
        if (requestRef.current !== request) return true
        setRemoteNodes(listing.nodes)
        setRemoteTruncated(listing.truncated)
        setRemoteHits(null)
      }
      setFailed(false)
      return true
    } catch {
      if (requestRef.current !== request) return true
      setFailed(true)
      return false
    }
  }, [replicated, engine, client, here, query, sort, capability, request])

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

  /*
   * ── The row's callbacks ────────────────────────────────────────────────────────────────────
   *
   * Above the early return because they are hooks, and STABLE because {@link FileRow} is memoised
   * (R-61): a memo handed freshly-built closures is a memo that never hits. Functional `setState`
   * is what keeps `path` and `selected` out of the dependency lists; `client` being `null` is
   * answered here rather than at each call site.
   */
  const objectUrl = useCallback(
    async (node: FileNode): Promise<string | null> => {
      if (client === null) return null
      // No `blobId`, no identity for the bytes — download and do not remember it. (A node without
      // one has nothing to show anyway; this is the honest branch rather than a guessed key.)
      const key = node.blobId === null ? null : `${accountId ?? ''}:${node.blobId}`
      const cached = key === null ? undefined : urlCacheRef.current.get(key)
      if (cached !== undefined) return cached
      const blob = await client.download(node)
      if (blob === null) return null
      const url = URL.createObjectURL(blob)
      if (key !== null) urlCacheRef.current.set(key, url)
      return url
    },
    [client, accountId],
  )

  const download = useCallback(
    async (node: FileNode): Promise<void> => {
      const url = await objectUrl(node)
      if (url === null) return
      const anchor = document.createElement('a')
      anchor.href = url
      // Never `node.name` raw. This app validates a name before it creates one, but the name on a
      // node came from whatever wrote it — another client, or a server that does not agree with
      // `fileNodeNameProblem` — and this value becomes a path on the reader's disk.
      anchor.download = safeDownloadName(node.name, DOWNLOAD_FALLBACK)
      anchor.click()
    },
    [objectUrl],
  )

  /** `open` comes from the row rather than from `preview` here, so this does not change per toggle. */
  const togglePreview = useCallback(
    async (node: FileNode, open: boolean): Promise<void> => {
      if (open) {
        setPreview(null)
        return
      }
      const url = await objectUrl(node)
      if (url !== null) setPreview({ id: node.id, type: node.type ?? '', url })
    },
    [objectUrl],
  )

  const clearSearch = useCallback((): void => {
    setQuery('')
    setSearchEpoch((epoch) => epoch + 1)
  }, [])

  /**
   * Walk the tree to `folder` and show it, leaving the search behind.
   *
   * A hit's row states where it was found, and that statement is the control that goes there — the
   * Finder's "Show in enclosing folder", which is the only way a flat result list can hand the
   * reader back their bearings. It costs one `FileNode/get` per level because the breadcrumb has to
   * be TRUE: dropping the reader into `Files / Invoices` when the folder is three deep would be a
   * cheaper lie, not a cheaper answer.
   */
  const openFolder = useCallback(
    async (folder: FileNode): Promise<void> => {
      if (client === null) return
      clearSearch()
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
    },
    [client, clearSearch],
  )

  /**
   * Walking into a folder — from the listing, or from a search hit.
   *
   * From a search result the way in has to be WALKED, so the breadcrumb tells the truth about
   * where the folder actually sits; from the listing the folder is one step down from where the
   * reader already is.
   */
  const openFolderRow = useCallback(
    (node: FileNode, fromSearch: boolean): void => {
      if (fromSearch) void openFolder(node)
      else setPath((current) => [...current, { id: node.id, name: node.name }])
    },
    [openFolder],
  )

  const toggle = useCallback(
    (id: Id): void =>
      setSelected((current) => {
        const next = new Set(current)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    [],
  )
  /**
   * The rename field, opened with the CURRENT name selected (R-66).
   *
   * The state comment on {@link renaming} has claimed this since the dialog was written and
   * nothing did it — `grep -rn '\.select()' apps/web/src` found nothing anywhere in the app.
   * Renaming is far more often an edit of what is there than a replacement of it, so the old name
   * has to be both readable and replaceable by typing.
   *
   * In an effect rather than on `onFocus`, and it has to be: `Dialog`'s focus trap places focus
   * from an effect of its own, and a parent's effect runs after its child's — so this is the last
   * word on where the caret ends up.
   */
  const renameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming === null) return
    const field = renameInputRef.current
    field?.focus()
    field?.select()
  }, [renaming])

  const closeFolderDialog = useCallback((): void => {
    setFolderDialogOpen(false)
    setNewFolder('')
  }, [])
  const startRename = useCallback((node: FileNode): void => {
    setRenaming(node)
    setRenameTo(node.name)
  }, [])
  const moveOne = useCallback((node: FileNode): void => setMoving([node]), [])
  const deleteOne = useCallback((node: FileNode): void => setDeleting([node]), [])

  /**
   * What stands where the list would — exactly ONE of these, always.
   *
   * Written as one value rather than as a chain of `&&`s in the JSX because the states became
   * genuinely distinguishable with D-4 and the chain got two of them wrong: a first visit showed
   * "This folder is empty." while the tree was still being walked (the replica answers `[]` long
   * before the walk does), and a refused walk showed that same sentence UNDER the failure pane.
   *
   *  - `loading` — nothing is known yet, or the very first walk is still running.
   *  - `offlineNever` — no line and no copy: "not synced yet", which is not "no files".
   *  - `failed` — the read was refused and there is nothing to fall back on. The one state with a
   *    Try again, because it is the one the reader can do something about.
   *  - `empty` — an answer, and the answer is that there is nothing here.
   *  - `list` — rows.
   */
  const paneState: 'loading' | 'offlineNever' | 'failed' | 'empty' | 'list' = (() => {
    if (!online && neverSynced) return 'offlineNever'
    if (online && failed && (rows === null || rows.length === 0)) return 'failed'
    if (rows === null) return 'loading'
    // The replica answers `[]` the moment it is asked; the walk that fills it takes longer. Until
    // one of them has happened, "empty" would be a claim nobody has checked.
    if (rows.length === 0 && replicated && neverSynced && online && !failed) return 'loading'
    return rows.length === 0 ? 'empty' : 'list'
  })()

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
        thrown instanceof FileSetError ? `files.error.${thrown.failure}` : failureKey(thrown)
      // Spelled out below rather than interpolated, so the i18n guard can see the keys.
      toast({ tone: 'danger', title: errorText(t, key) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Upload a batch, and say which files did not make it (R-67).
   *
   * Not `run()` around the whole loop, which is what it was: the first refusal — a name already
   * taken, the quota reached — threw out of the `for`, so files 4 to 11 were never attempted, and
   * the toast named neither the file that was refused nor the ones that were skipped. Eleven scans
   * went in, some number of them arrived, and the reader was left to work out which.
   *
   * Every file is now tried, the failures are collected WITH their reasons, and one sentence names
   * them. The reload happens once at the end rather than per file.
   */
  const uploadAll = async (chosen: readonly File[]): Promise<void> => {
    setBusy(true)
    const failures: { readonly name: string; readonly key: string }[] = []
    try {
      for (const file of chosen) {
        try {
          await client.upload(file, here)
        } catch (thrown) {
          failures.push({
            name: file.name,
            key:
              thrown instanceof FileSetError ? `files.error.${thrown.failure}` : failureKey(thrown),
          })
        }
      }
      const first = failures[0]
      if (failures.length === 1 && first !== undefined) {
        // One failure gets the whole reason: with a single file there is room to say why.
        toast({
          tone: 'danger',
          title: t('files.uploadProblem.one', {
            name: first.name,
            reason: errorText(t, first.key),
          }),
        })
      } else if (failures.length > 1) {
        // Several: the names, because "which ones" is the question a batch raises. The reasons
        // would be a paragraph in a toast, and the row that is missing is where they belong.
        toast({
          tone: 'danger',
          title: t('files.uploadProblem.some', {
            count: failures.length,
            total: chosen.length,
            names: failures.map((failure) => failure.name).join(', '),
          }),
        })
      }
      // ONE reload for the batch, and only if anything landed — the same "a write that succeeded is
      // never silent" rule `run` follows.
      if (chosen.length > failures.length && !(await loadRef.current())) {
        toast({ tone: 'warning', title: t('files.savedButNotShown') })
      }
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
    clearSearch()
    setSelecting(false)
    setSelected(new Set())
    setPreview(null)
    // The downloaded bytes go with everything else. The cache is account-scoped now (R-22), so this
    // is no longer what keeps the two accounts apart — it is housekeeping: nothing on screen refers
    // to these URLs any more, and holding a departed account's file contents in memory for the rest
    // of the session is not something this screen should do.
    for (const url of urlCacheRef.current.values()) URL.revokeObjectURL(url)
    urlCacheRef.current.clear()
    // The SERVER-backed listing only (a share). The replicated one is a live query keyed on the
    // level, so it re-answers for the new account by itself and has nothing to clear.
    setRemoteNodes(null)
    setRemoteHits(null)
    setRemoteTruncated(false)
  }

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
    /*
     * On a phone the two creation actions live here rather than in the bar — see the ScreenBar
     * below for the measurement. First, and in the order they sit in on a wider screen, because
     * this is where a reader looks for them.
     *
     * Offline they are simply absent rather than present-and-refused: a menu has no room for the
     * `unavailableReason` an IconButton carries, and an item that does nothing is worse than one
     * that is not offered.
     */
    ...(tier === 'phone' && online && !busy
      ? [
          {
            id: 'newFolder',
            label: t('files.newFolder'),
            icon: FolderPlus,
            onSelect: () => setFolderDialogOpen(true),
          },
          {
            id: 'upload',
            label: t('files.upload'),
            icon: Upload,
            onSelect: () => fileInputRef.current?.click(),
          },
        ]
      : []),
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
        {/*
          On a phone these two are IN the menu below, not beside it.
          Measured at 390px, 2026-08-22: the bar carried the trail, the folder name, these two, the
          `⋯` and the shell's own two — five 44px controls and a breadcrumb — and the only element
          able to give way was the name, which came out at 24px. "Sicht phone 9502" read as "S…";
          the one thing the screen has to state was the one thing it did not.

          Same answer the calendar gives at the same width, in the same words: a control where
          there is room for one, a menu entry where there is not. The screen keeps a `⋯` either
          way, so nothing moves out of reach.
        */}
        {tier !== 'phone' && (
          <>
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
          </>
        )}
        {/* Everything about the LISTING rather than about this folder — how it is ordered, and
            whether you are picking things out of it. One trigger, because a phone header is one
            row. */}
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
            void uploadAll(chosen)
          }}
        />
      </ScreenBar>

      {/* A field, not a screen. Above the list because that is where the list's own controls
          belong, and always visible because a search you have to reveal is one nobody finds. */}
      <FileSearchField key={searchEpoch} onQuery={setQuery} />

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
          {/*
            NOT given `unavailableReason` offline, unlike the row's own actions (R-24), and the
            reason is `Button` rather than this screen: it renders the explanation as a
            visually-hidden span INSIDE the control, which an icon-only button hides behind its
            `aria-label` but a text button does not — the name would become "Move You are offline.
            Files can only be changed while connected." and be announced again as the description.
            Until that primitive puts the reason outside the button, the honest arrangement here is
            the one below plus `run`'s corrected message: the action is offered, and a write that
            cannot reach the server now says so instead of blaming it.
          */}
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
          onClose={closeFolderDialog}
          footer={
            <>
              <Button variant="ghost" onClick={closeFolderDialog}>
                {t('files.cancel')}
              </Button>
              {/* `type="submit" form=…` rather than `onClick`: the button is in the dialog's footer
                  and the field is in its body, so the form is joined by id — the arrangement
                  `AddressBookList` uses. That is also what makes Enter work (R-66). */}
              <Button
                variant="primary"
                type="submit"
                form={newFolderFormId}
                disabled={busy || newFolder.trim() === ''}
              >
                {t('files.newFolder')}
              </Button>
            </>
          }
        >
          {/*
            A FORM, so Enter submits it (R-66).
            The field asked for a name and then ignored the one key everybody presses after typing
            one: `Dialog` and `TextInput` have no Enter handling of their own, and this screen had
            neither a `<form>` nor an `onKeyDown`. Every other name-taking dialog in the app —
            `CalendarDialog`, `AddressBookList` — is a form already.
          */}
          <form
            id={newFolderFormId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const name = newFolder.trim()
              if (busy || name === '' || !checkName(name)) return
              setNewFolder('')
              setFolderDialogOpen(false)
              void run(() => client.createFolder(name, here))
            }}
          >
            <TextInput
              autoFocus
              value={newFolder}
              aria-label={t('files.newFolder')}
              onChange={(event) => setNewFolder(event.target.value)}
            />
          </form>
        </Dialog>
      )}

      {renaming !== null && (
        <Dialog
          open
          title={t('files.rename.title', { name: renaming.name })}
          onClose={() => setRenaming(null)}
          initialFocusRef={renameInputRef}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                {t('files.cancel')}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form={renameFormId}
                // Unchanged is not a rename: `FileNode/set` would accept the no-op and the reader
                // would get a round trip and a reload for nothing.
                disabled={busy || renameTo.trim() === '' || renameTo.trim() === renaming.name}
              >
                {t('files.rename.confirm')}
              </Button>
            </>
          }
        >
          {/* A form, so Enter renames — see the new-folder dialog above (R-66). */}
          <form
            id={renameFormId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const name = renameTo.trim()
              const { id } = renaming
              if (busy || name === '' || name === renaming.name) return
              // The same client-side name check the upload and the new folder go through, and for
              // the same reason: the server refuses `:` and `AUX` for Windows-compatibility reasons
              // that have nothing to do with what the user meant. Left OPEN on a bad name — the
              // dialog is where the name is, so it is where the objection belongs.
              if (!checkName(name)) return
              setRenaming(null)
              void run(() => client.rename(id, name))
            }}
          >
            <TextInput
              ref={renameInputRef}
              value={renameTo}
              aria-label={t('files.rename.label')}
              onChange={(event) => setRenameTo(event.target.value)}
            />
          </form>
        </Dialog>
      )}

      {moving !== null && moving.length > 0 && (
        <FileMoveDialog
          nodes={moving}
          // Only where every node agrees on where it is now. A selection made in search results can
          // span three folders, and there is then no single "already here" to refuse.
          {...commonParent(moving)}
          replicated={replicated}
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
      {paneState === 'offlineNever' && (
        <EmptyState
          icon={CloudOff}
          title={t('files.offlineNever.title')}
          description={t('files.offlineNever.body')}
        />
      )}
      {online &&
        failed &&
        (paneState === 'failed' ? (
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

      {paneState === 'loading' ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : paneState === 'offlineNever' || paneState === 'failed' ? null : paneState === 'empty' ? (
        <EmptyState
          icon={searching ? Search : FolderOpen}
          title={searching ? t('files.search.none', { query }) : t('files.empty')}
        />
      ) : (
        <ul className={styles.list} ref={listRef}>
          {(rows ?? []).map(({ node, parent }) => (
            <FileRow
              key={node.id}
              node={node}
              parent={parent}
              geometry={geometry}
              busy={busy}
              online={online}
              searching={searching}
              selecting={selecting}
              selected={selected.has(node.id)}
              preview={preview?.id === node.id ? preview : null}
              onToggleSelect={toggle}
              onOpenFolder={openFolderRow}
              onTogglePreview={togglePreview}
              onDownload={download}
              onShare={setSharing}
              onRename={startRename}
              onMove={moveOne}
              onDelete={deleteOne}
            />
          ))}
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
    case 'files.error.offline':
      return t('files.error.offline')
    default:
      return t('files.error.rejected')
  }
}

/**
 * What a throw that is NOT a `FileSetError` was: a lost line, or a server that said no (R-24).
 *
 * Everything used to be "The server declined that." — including `TypeError: Failed to fetch`,
 * which is what `fetch` throws when there is no connection at all. The server had not declined
 * anything; it had not been asked. A reader told the wrong cause looks for the wrong remedy, and
 * the right one here (reconnect, then try again) is one they can actually act on.
 */
function failureKey(thrown: unknown): string {
  if (thrown instanceof TypeError) return 'files.error.offline'
  if (thrown instanceof DOMException && thrown.name === 'AbortError') return 'files.error.offline'
  return 'files.error.rejected'
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

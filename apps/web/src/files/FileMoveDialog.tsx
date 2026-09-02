/**
 * "Move to…" for files (D-1) — a folder picker you walk, not a tree you read.
 *
 * The gap it closes: the server changes `parentId` without complaint, and the client had no way to
 * ask it to. Folders could be created and nothing could be put in one, which makes the whole tree
 * decoration.
 *
 * WHY A BROWSER AND NOT A FLAT LIST. Mail's {@link MoveDialog} lists every mailbox at once, and it
 * can: a mail account has a dozen folders and the replica already holds all of them. A file tree
 * has no bound on its depth, so the flat list would be a recursive crawl of the account to fill a
 * dialog. Walking it is also what iOS Files and the Finder's "Move to" sheet do, and for the same
 * reason: the reader picks a destination by recognising the way there.
 *
 * WHERE THE LEVELS COME FROM. The reader's OWN tree is replicated (D-4) and is read from there,
 * one indexed query per level — this file used to say a file tree has no replica, which stopped
 * being true with D-4, and it went on asking the server for every step of the walk. At the root
 * that meant the whole unfiltered account query (up to `MAX_PAGES` pages, `files-client.ts`) per
 * click, and offline it meant a spinner, "could not be loaded", and a "Move here" that stayed
 * live and then failed. A SHARED account has no engine and therefore no replica, so that one is
 * still a round trip per level — the same split the screen behind this dialog makes.
 *
 * NO DRAG AND DROP, and that is the point. ADR-012 keeps HTML5 drag a desktop gesture, so on a
 * phone a drag-only move would be no move at all. This dialog is the whole mechanism on every
 * viewport rather than the touch consolation prize for one — same control, same path, same test.
 *
 * WHAT CANNOT BE CHOSEN, and how. A folder may not be moved inside itself or inside its own child,
 * and the guard is structural rather than a check: the nodes being moved are absent from every
 * level this dialog lists, so the only way to reach their descendants — walking in through them —
 * is not on offer. "Move here" is refused for the folder the nodes already sit in, because a move
 * that changes nothing still costs a round trip and a reload.
 */

import type { FileNode, Id } from '@waxwing/jmap'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileNodes } from '../sync'
import { Button, Dialog, EmptyState, Spinner } from '../ui'
import { DEFAULT_FILE_SORT, sortNodes } from './file-sort'
import styles from './files.module.css'
import type { FilesClient } from './files-client'

export interface FileMoveDialogProps {
  /** The nodes to move. Never empty; its length is what the title counts. */
  readonly nodes: readonly FileNode[]
  /**
   * Where they are now — "Move here" is refused for it.
   *
   * Absent where they do not agree (a selection made in search results can span three folders).
   * `null` is a real value here — the root — so the two cases cannot share one.
   */
  readonly currentParentId?: Id | null
  /**
   * Whether the account being browsed is the reader's own, and therefore in the replica.
   *
   * Passed in rather than derived: only the screen knows which account it is showing (S-4), and
   * this dialog reads the replica for one answer and the network for the other.
   */
  readonly replicated: boolean
  readonly client: FilesClient
  readonly onClose: () => void
  /**
   * Runs the move. The caller owns the write, the toast and the reload.
   *
   * The destination's NAME comes up with its id, exactly as mail's `MoveDialog` hands one up: the
   * caller names the folder in the undo toast and cannot re-derive it — the picker may have walked
   * somewhere the screen behind it has never been.
   */
  readonly onMove: (parentId: Id | null, label: string) => void
}

/** One step of the path the picker has walked into. Mirrors the page's own crumbs. */
interface Step {
  readonly id: Id | null
  readonly name: string
}

export function FileMoveDialog({
  nodes,
  currentParentId,
  replicated,
  client,
  onClose,
  onMove,
}: FileMoveDialogProps) {
  const { t } = useTranslation()
  const [path, setPath] = useState<Step[]>([{ id: null, name: '' }])
  const [remoteFolders, setRemoteFolders] = useState<FileNode[] | null>(null)
  const [failed, setFailed] = useState(false)

  const here = path[path.length - 1]?.id ?? null
  /** This level from the replica — the reader's own account only (see the header). */
  const replicaRows = useFileNodes(here, replicated)
  /**
   * What is being moved, as a VALUE rather than as an object.
   *
   * The set is rebuilt on every render, so depending on it would reload the level on every render
   * the screen behind this dialog happens to have. The ids are what actually decide the listing,
   * and a string of them changes exactly when they do.
   */
  const movingIds = nodes.map((node) => node.id).join('\0')

  useEffect(() => {
    if (replicated) return
    let live = true
    const moving = new Set(movingIds.split('\0'))
    setRemoteFolders(null)
    setFailed(false)
    client
      .list(here)
      .then((listing) => {
        if (!live) return
        setRemoteFolders(
          listing.nodes.filter((node) => node.nodeType === 'directory' && !moving.has(node.id)),
        )
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [replicated, client, here, movingIds])

  /**
   * The destinations on offer: folders of this level, minus the nodes being moved.
   *
   * Dropping the moved nodes is the structural guard the header describes — a folder cannot be
   * walked into if it is not listed, so its own descendants are unreachable as destinations.
   */
  const folders = useMemo<FileNode[] | null>(() => {
    const level = replicated ? (replicaRows ?? null) : remoteFolders
    if (level === null) return null
    const moving = new Set(movingIds.split('\0'))
    return sortNodes(
      level.filter((node) => node.nodeType === 'directory' && !moving.has(node.id)),
      DEFAULT_FILE_SORT,
    )
  }, [replicated, replicaRows, remoteFolders, movingIds])

  const close = useCallback(() => onClose(), [onClose])

  const title =
    nodes.length === 1
      ? t('files.move.title', { name: nodes[0]?.name ?? '' })
      : t('files.move.titleMany', { count: nodes.length })
  /** What the level being shown is called — the button's label and the undo toast's. */
  const destination = here === null ? t('files.root') : (path.at(-1)?.name ?? '')

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('files.cancel')}
          </Button>
          <Button
            variant="primary"
            // A move to where they already are is not a move. The button says where it would put
            // them, so the refusal reads as "you are already there" rather than as a dead control.
            disabled={currentParentId !== undefined && here === currentParentId}
            onClick={() => onMove(here, destination)}
          >
            {t('files.move.here', { name: destination })}
          </Button>
        </>
      }
    >
      <div className={styles.picker}>
        {/* Where the picker is looking, and the way back out. The same breadcrumb the screen
            behind it uses, so "up one" means the same gesture in both. */}
        <nav className={styles.crumbs} aria-label={t('files.move.breadcrumb')}>
          {path.map((step, index) => {
            const label = step.id === null ? t('files.root') : step.name
            return (
              <span key={step.id ?? 'root'} className={styles.crumb}>
                {index > 0 && <span aria-hidden="true">/</span>}
                {/* The level being shown is stated, not offered: a control that navigates to where
                    you already are is the one thing a breadcrumb must not contain. */}
                {index === path.length - 1 ? (
                  <span aria-current="page">{label}</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPath(path.slice(0, index + 1))}
                  >
                    {label}
                  </Button>
                )}
              </span>
            )
          })}
        </nav>

        {failed ? (
          <EmptyState icon={FolderOpen} title={t('files.loadFailed')} />
        ) : folders === null ? (
          <div className={styles.loading}>
            <Spinner label={t('ui.spinner.label')} />
          </div>
        ) : folders.length === 0 ? (
          // Not an error and not a dead end: "Move here" is still the live control below.
          <p className={styles.pickerEmpty}>{t('files.move.noFolders')}</p>
        ) : (
          <ul className={styles.pickerList}>
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className={styles.pickerItem}
                  onClick={() => setPath([...path, { id: folder.id, name: folder.name }])}
                >
                  <Folder aria-hidden="true" className={styles.icon} />
                  <span className={styles.nameText}>{folder.name}</span>
                  <ChevronRight aria-hidden="true" className={styles.pickerChevron} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

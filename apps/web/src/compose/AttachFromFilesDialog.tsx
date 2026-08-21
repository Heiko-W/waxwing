/**
 * "Attach from Files" (D-5) — the picker that turns a stored file into an attachment.
 *
 * **Nothing is uploaded.** A picked node's `blobId` goes straight onto the draft; see
 * `attach-from-files.ts` for the measurement that establishes this and why it is the whole cost of
 * the feature. The practical effect on screen is that picking a 40 MB file is instant and works
 * offline — there is no progress bar here because there is no transfer.
 *
 * **Shape.** iOS's document picker is the reference the brief names: a browsable list with a path
 * above it and one confirm at the bottom. On a phone it is a sheet that fills the screen, not a
 * centred window — a file list in a 24 rem box shows four rows and asks the reader to scroll a
 * scroller inside a scroller.
 *
 * Lazy, and it stays that way: it pulls in the files client, which nothing else in the compose
 * chunk touches.
 */

import type { FileNode, Id } from '@waxwing/jmap'
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import type { LayoutTier } from '../app/shell/layout'
import { currentUserPrincipalId, type FilesClient, makeFilesClient } from '../files/files-client'
import { formatBytes } from '../i18n/formatters'
import { Button, Checkbox, Dialog, EmptyState, Spinner } from '../ui'
import styles from './composer.module.css'

export interface AttachFromFilesDialogProps {
  /** Injected in tests; production builds one from the live session. */
  readonly client?: FilesClient | undefined
  readonly tier: LayoutTier
  /** The picked file nodes. Size checks + toasts belong to the attachment controller, not here. */
  onPick: (nodes: readonly FileNode[]) => void
  onClose: () => void
}

/** Folders above files, then by name — the order every file browser has, and the one people expect. */
function order(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    const aDir = a.nodeType === 'directory'
    const bDir = b.nodeType === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export default function AttachFromFilesDialog({
  client: injected,
  tier,
  onPick,
  onClose,
}: AttachFromFilesDialogProps) {
  const { t } = useTranslation()
  const connected = useSessionOptional()
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  const selfPrincipalId = currentUserPrincipalId(connected?.jmapSession ?? null, accountId)
  const client = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeFilesClient(sessionClient, accountId, selfPrincipalId)),
    [injected, sessionClient, accountId, selfPrincipalId],
  )

  /** The folders walked into, root first. Empty = at the root. */
  const [path, setPath] = useState<readonly FileNode[]>([])
  const [nodes, setNodes] = useState<readonly FileNode[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  /** Picked files, keyed by id, in pick order — a selection survives walking into another folder. */
  const [picked, setPicked] = useState<readonly FileNode[]>([])

  const here = path[path.length - 1]?.id ?? null

  useEffect(() => {
    if (client === null) {
      setLoading(false)
      setFailed(true)
      return
    }
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void client
      .list(here)
      .then((listing) => {
        if (cancelled) return
        setNodes(order(listing.nodes))
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setFailed(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, here])

  const toggle = useCallback((node: FileNode): void => {
    setPicked((current) =>
      current.some((entry) => entry.id === node.id)
        ? current.filter((entry) => entry.id !== node.id)
        : [...current, node],
    )
  }, [])

  const confirm = (): void => onPick(picked)

  const isPicked = (id: Id): boolean => picked.some((entry) => entry.id === id)

  // Phone gets the full-screen sheet, everything else the tall panel. Spread rather than passed as
  // `string | undefined`: `exactOptionalPropertyTypes` is on, and a CSS-module lookup is optional.
  const panelClass = tier === 'phone' ? styles.pickerSheet : styles.pickerPanel

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('compose.attachFromFiles.title')}
      {...(panelClass === undefined ? {} : { className: panelClass })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('compose.attachFromFiles.cancel')}
          </Button>
          <Button variant="primary" disabled={picked.length === 0} onClick={confirm}>
            {/* Two keys, not a `_zero` plural: English has no zero category, so "Attach 0 files"
                is what the plural rule would produce on the button's resting state. */}
            {picked.length === 0
              ? t('compose.attachFromFiles.confirmEmpty')
              : t('compose.attachFromFiles.confirm', { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className={styles.pickerBody}>
        {/* The path is also the way back up: every crumb is a button. A picker one folder deep with
            no way out but Cancel is the classic dead end. */}
        <nav className={styles.pickerPath} aria-label={t('compose.attachFromFiles.path')}>
          <button type="button" className={styles.pickerCrumb} onClick={() => setPath([])}>
            {t('compose.attachFromFiles.root')}
          </button>
          {path.map((folder, index) => (
            <span key={folder.id} className={styles.pickerCrumbGroup}>
              <ChevronRight aria-hidden="true" className={styles.pickerCrumbSeparator} />
              <button
                type="button"
                className={styles.pickerCrumb}
                onClick={() => setPath(path.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>

        {loading ? (
          <div className={styles.pickerStatus}>
            <Spinner />
          </div>
        ) : failed ? (
          <EmptyState
            tone="error"
            title={t('compose.attachFromFiles.errorTitle')}
            description={t('compose.attachFromFiles.errorBody')}
          />
        ) : nodes.length === 0 ? (
          <EmptyState title={t('compose.attachFromFiles.empty')} />
        ) : (
          <ul className={styles.pickerList}>
            {nodes.map((node) =>
              node.nodeType === 'directory' ? (
                <li key={node.id}>
                  <button
                    type="button"
                    className={styles.pickerRow}
                    onClick={() => setPath([...path, node])}
                  >
                    <Folder aria-hidden="true" className={styles.pickerIcon} />
                    <span className={styles.pickerName}>{node.name}</span>
                    <ChevronRight aria-hidden="true" className={styles.pickerIcon} />
                  </button>
                </li>
              ) : (
                <li key={node.id}>
                  {/* A Checkbox with a full-width label, so the hit target is the ROW and not a
                      16 px box — the difference between usable and not under `pointer: coarse`. */}
                  <Checkbox
                    checked={isPicked(node.id)}
                    onChange={() => toggle(node)}
                    label={
                      <span className={styles.pickerRowInner}>
                        <FileIcon aria-hidden="true" className={styles.pickerIcon} />
                        <span className={styles.pickerName}>{node.name}</span>
                        <span className={styles.pickerSize}>{formatBytes(node.size)}</span>
                      </span>
                    }
                  />
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

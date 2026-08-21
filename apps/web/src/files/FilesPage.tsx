/**
 * The files screen (M5.7, FR-FILE-01) — a lazy route chunk.
 *
 * A single-pane browser: breadcrumbs, a list, upload, new folder, rename, delete, download and an
 * inline preview (M5.17). Not a two-pane manager with drag-and-drop — that is the part that needs a
 * second milestone, and a file list that reliably does seven things beats one that half-does twelve.
 *
 * The preview surface is the reader's, deliberately: `preview-policy.ts` decides what may be shown
 * and where, so a file and an attachment of the same type are treated identically. Uploaded bytes
 * are no more trustworthy than emailed ones, and a second, more relaxed answer here would be a way
 * in that the stricter answer over there would not notice.
 *
 * Names are checked against the server's own rules BEFORE the round trip: a name containing `:`,
 * or called `AUX`, is refused for Windows-compatibility reasons that have nothing to do with what
 * the user meant, and "the server said no" is not an explanation anyone can act on.
 */

import type { FileNode } from '@waxwing/jmap'
import { fileNodeNameProblem } from '@waxwing/jmap'
import {
  Download,
  Eye,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Trash2,
  TriangleAlert,
  Upload,
  UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { useOnline } from '../app/use-online'
import { formatBytes } from '../i18n/formatters'
import { isPreviewable, previewSurface } from '../mail/preview-policy'
import { safeDownloadName } from '../mail/safe-filename'
import { Button, Dialog, EmptyState, IconButton, Spinner, TextInput, useToast } from '../ui'
import styles from './files.module.css'
import {
  currentUserPrincipalId,
  FileSetError,
  type FilesClient,
  fileCapability,
  makeFilesClient,
} from './files-client'
import { ShareDialog } from './ShareDialog'
import { mayShare } from './sharing'

export interface FilesPageProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: FilesClient
}

/**
 * The `download` value for a node whose name strips to nothing. Not localized: it becomes a file on
 * disk, and a filename that changes with the UI language is one the reader cannot find again.
 */
const DOWNLOAD_FALLBACK = 'file'

/** One step of the path the user has walked into. */
interface Crumb {
  readonly id: string | null
  readonly name: string
}

export default function FilesPage(props: FilesPageProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [path, setPath] = useState<Crumb[]>([{ id: null, name: '' }])
  const [nodes, setNodes] = useState<FileNode[] | null>(null)
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
  /** No replica here either — see the note in CalendarPage. */
  const online = useOnline()
  // The open preview, or null. Holds the object URL so the render stays synchronous.
  const [preview, setPreview] = useState<{ id: string; type: string; url: string } | null>(null)
  // The node whose sharing is being edited, or null.
  const [sharing, setSharing] = useState<FileNode | null>(null)
  // One object URL per node, reused across toggles and revoked once on unmount — re-opening a
  // preview neither downloads the file again nor leaks the superseded URL.
  const urlCacheRef = useRef(new Map<string, string>())

  const injected = props.client
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
  const capability = fileCapability(connected?.jmapSession ?? null, accountId)

  const here = path[path.length - 1]?.id ?? null

  /** Reloads this level. Returns whether the listing arrived — see {@link run}. */
  const load = useCallback(async (): Promise<boolean> => {
    if (client === null) return false
    try {
      setNodes(await client.list(here))
      setFailed(false)
      return true
    } catch {
      setFailed(true)
      return false
    }
  }, [client, here])

  useEffect(() => {
    void load()
  }, [load])

  // Above the signed-out early return, because hooks must not be conditional. Revoking on unmount
  // is the only place it can happen: an object URL outlives the render that made it.
  useEffect(() => {
    const cache = urlCacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  if (client === null) {
    return (
      <div className={styles.page}>
        <EmptyState icon={FolderOpen} title={t('files.signedOut')} />
      </div>
    )
  }

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
      if (!(await load())) toast({ tone: 'warning', title: t('files.savedButNotShown') })
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
          {path.slice(0, -1).map((crumb, index) => (
            <span key={crumb.id ?? 'root'} className={styles.crumb}>
              <Button variant="ghost" size="sm" onClick={() => setPath(path.slice(0, index + 1))}>
                {crumb.id === null ? t('files.root') : crumb.name}
              </Button>
              <span aria-hidden="true">/</span>
            </span>
          ))}
        </nav>
        <h1 className={shellStyles.paneTitle}>
          {here === null ? t('files.root') : (path.at(-1)?.name ?? t('files.title'))}
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
        <input
          ref={fileInputRef}
          type="file"
          className={styles.fileInput}
          aria-label={t('files.upload')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file === undefined) return
            if (!checkName(file.name)) return
            void run(() => client.upload(file, here))
          }}
        />
      </ScreenBar>

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

      {/* Failure and emptiness look different now. They used to share one class, so "the server
          said no" and "this folder has nothing in it" were the same grey sentence — and only the
          failure has anything the reader can do about it. */}
      {failed && (
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
      )}

      {nodes === null && !failed ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : nodes !== null && nodes.length === 0 ? (
        <EmptyState icon={FolderOpen} title={t('files.empty')} />
      ) : (
        <ul className={styles.list}>
          {(nodes ?? []).map((node) => (
            <li key={node.id} className={styles.row}>
              {node.nodeType === 'directory' ? (
                <button
                  type="button"
                  className={styles.name}
                  onClick={() => setPath([...path, { id: node.id, name: node.name }])}
                >
                  <Folder aria-hidden="true" className={styles.icon} />
                  <span className={styles.nameText}>{node.name}</span>
                </button>
              ) : (
                <span className={styles.name}>
                  <FileIcon aria-hidden="true" className={styles.icon} />
                  <span className={styles.nameText}>{node.name}</span>
                </span>
              )}
              <span className={styles.size}>
                {node.nodeType === 'directory' ? '' : formatBytes(node.size)}
              </span>
              <span className={styles.rowActions}>
                {node.nodeType !== 'directory' &&
                  node.myRights.mayRead &&
                  isPreviewable(node.type) && (
                    <IconButton
                      label={
                        preview?.id === node.id
                          ? t('files.hidePreview', { name: node.name })
                          : t('files.preview', { name: node.name })
                      }
                      variant="ghost"
                      size="sm"
                      aria-expanded={preview?.id === node.id}
                      onClick={() => void togglePreview(node)}
                    >
                      <Eye />
                    </IconButton>
                  )}
                {mayShare(node.myRights) && (
                  <IconButton
                    label={t('files.share.open', { name: node.name })}
                    variant="ghost"
                    size="sm"
                    onClick={() => setSharing(node)}
                  >
                    <UsersRound />
                  </IconButton>
                )}
                {node.nodeType !== 'directory' && node.myRights.mayRead && (
                  <IconButton
                    label={t('files.download', { name: node.name })}
                    variant="ghost"
                    size="sm"
                    onClick={() => void download(node)}
                  >
                    <Download />
                  </IconButton>
                )}
                {node.myRights.mayDelete && (
                  <IconButton
                    label={t('files.delete', { name: node.name })}
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(() => client.destroy(node.id))}
                  >
                    <Trash2 />
                  </IconButton>
                )}
              </span>
              {preview?.id === node.id && (
                <div className={styles.preview}>
                  {previewSurface(preview.type) === 'image' ? (
                    // A blob: URL for the file just downloaded — no second network fetch, and no
                    // `<img src={downloadUrl}>`, which would send the bytes without our credentials.
                    <img src={preview.url} alt={node.name} className={styles.previewImage} />
                  ) : (
                    // `sandbox=""` denies everything, same-origin included: a blob: URL carries this
                    // app's origin, and taking it away is the whole reason the frame is safe.
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
          ))}
        </ul>
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

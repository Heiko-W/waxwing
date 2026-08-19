/**
 * The files screen (M5.7, FR-FILE-01) — a lazy route chunk.
 *
 * A single-pane browser: breadcrumbs, a list, upload, new folder, rename, delete, download. Not a
 * two-pane manager with drag-and-drop and previews — those are the parts that need a second
 * milestone, and a file list that reliably does six things beats one that half-does twelve.
 *
 * Names are checked against the server's own rules BEFORE the round trip: a name containing `:`,
 * or called `AUX`, is refused for Windows-compatibility reasons that have nothing to do with what
 * the user meant, and "the server said no" is not an explanation anyone can act on.
 */

import type { FileNode } from '@waxwing/jmap'
import { fileNodeNameProblem } from '@waxwing/jmap'
import { Download, File as FileIcon, Folder, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import { formatBytes } from '../i18n/formatters'
import { Button, IconButton, Spinner, TextInput, useToast } from '../ui'
import styles from './files.module.css'
import { FileSetError, type FilesClient, fileCapability, makeFilesClient } from './files-client'

export interface FilesPageProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: FilesClient
}

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

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  const client = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeFilesClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )
  const capability = fileCapability(connected?.jmapSession ?? null, accountId)

  const here = path[path.length - 1]?.id ?? null

  const load = useCallback(async () => {
    if (client === null) return
    try {
      setNodes(await client.list(here))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [client, here])

  useEffect(() => {
    void load()
  }, [load])

  if (client === null) {
    return (
      <div className={styles.page}>
        <p className={styles.empty}>{t('files.signedOut')}</p>
      </div>
    )
  }

  /** Runs a write, turning a refusal into a sentence the reader can act on. */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await load()
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

  const download = async (node: FileNode): Promise<void> => {
    const blob = await client.download(node)
    if (blob === null) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = node.name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.crumbs} aria-label={t('files.breadcrumb')}>
          {path.map((crumb, index) => (
            <span key={crumb.id ?? 'root'} className={styles.crumb}>
              <Button
                variant="ghost"
                size="sm"
                disabled={index === path.length - 1}
                onClick={() => setPath(path.slice(0, index + 1))}
              >
                {crumb.id === null ? t('files.root') : crumb.name}
              </Button>
              {index < path.length - 1 && <span aria-hidden="true">/</span>}
            </span>
          ))}
        </nav>

        <div className={styles.actions}>
          <TextInput
            value={newFolder}
            placeholder={t('files.newFolderPlaceholder')}
            aria-label={t('files.newFolder')}
            onChange={(event) => setNewFolder(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || newFolder.trim() === ''}
            onClick={() => {
              if (!checkName(newFolder.trim())) return
              const name = newFolder.trim()
              setNewFolder('')
              void run(() => client.createFolder(name, here))
            }}
          >
            {t('files.newFolder')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" />
            {t('files.upload')}
          </Button>
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
        </div>
      </header>

      {failed && (
        <p className={styles.empty} role="alert">
          {t('files.loadFailed')}
        </p>
      )}

      {nodes === null && !failed ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : nodes !== null && nodes.length === 0 ? (
        <p className={styles.empty}>{t('files.empty')}</p>
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
            </li>
          ))}
        </ul>
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

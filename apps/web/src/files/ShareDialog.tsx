/**
 * Sharing one file or folder (M5.18, RFC 9670).
 *
 * Two lists: who has access now, and who could be given it. The rights model is in `sharing.ts`,
 * tested without rendering; this file is the surface.
 *
 * **Every change is written immediately**, not on an OK button. `FileNode/set` replaces the whole
 * `shareWith` map, so a dialog holding pending edits would be holding a value that goes stale the
 * moment another client touches the node — and would then overwrite their change on save. Writing
 * each grant as it is made keeps the window in which that can happen as short as a round trip.
 *
 * A grant this client cannot express — set by another client, or in a combination these three
 * roles do not produce — is shown as "custom" and left alone. It can be revoked, because revoking
 * is unambiguous; it cannot be silently rewritten into whichever role looks closest.
 */

import type { FileNode, FileNodeRights, Id, Principal } from '@waxwing/jmap'
import { Check, UserMinus, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Select, Spinner, TextInput } from '../ui'
import styles from './files.module.css'
import type { FilesClient } from './files-client'
import {
  grantees,
  SHARE_ROLES,
  type ShareRole,
  type ShareRoleOrCustom,
  withGrant,
  withoutGrant,
} from './sharing'

export interface ShareDialogProps {
  readonly node: FileNode
  readonly client: FilesClient
  onClose: () => void
  /** Called after every successful write, so the list behind the dialog stays true. */
  onChanged: () => void
}

/** How long to wait after a keystroke before asking the server. */
const SEARCH_DELAY_MS = 250

function principalLabel(principal: Principal): string {
  const name = principal.name?.trim()
  if (name !== undefined && name !== '') return name
  const email = principal.email?.trim()
  if (email !== undefined && email !== '') return email
  // A principal with neither is legal in the RFC. Its id is not a name, but it is not nothing, and
  // an empty row would be worse than an ugly one.
  return principal.id
}

export function ShareDialog({ node, client, onClose, onChanged }: ShareDialogProps) {
  const { t } = useTranslation()
  const searchId = useId()
  const roleId = useId()
  const [shareWith, setShareWith] = useState<Record<Id, Partial<FileNodeRights>>>(
    node.shareWith ?? {},
  )
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Principal[] | null>(null)
  const [role, setRole] = useState<ShareRole>('viewer')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Names for the ids in `shareWith`: the map holds ids alone, and an id is not something to show
  // a person. Filled from whatever the search has returned so far.
  const [names, setNames] = useState<Record<Id, string>>({})

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const principals = await client.searchPrincipals(query)
          if (cancelled) return
          setFound(principals)
          setNames((current) => {
            const next = { ...current }
            for (const principal of principals) next[principal.id] = principalLabel(principal)
            return next
          })
        } catch {
          if (!cancelled) setFound([])
        }
      })()
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, query])

  const write = useCallback(
    async (next: Record<Id, Partial<FileNodeRights>>): Promise<void> => {
      setBusy(true)
      setFailed(false)
      try {
        await client.setShareWith(node.id, next as Record<Id, FileNodeRights>)
        setShareWith(next)
        onChanged()
      } catch {
        // The local map is deliberately NOT updated: the screen keeps showing what the server still
        // has, which is the only honest thing to show after a write that did not happen.
        setFailed(true)
      } finally {
        setBusy(false)
      }
    },
    [client, node.id, onChanged],
  )

  const current = grantees(shareWith)
  const currentIds = new Set(current.map((entry) => entry.principalId))
  const candidates = (found ?? []).filter((principal) => !currentIds.has(principal.id))

  const roleLabel = (value: ShareRoleOrCustom): string =>
    value === 'custom' ? t('files.share.custom') : t(`files.share.role.${value}`)

  return (
    <Dialog
      open
      title={t('files.share.title', { name: node.name })}
      onClose={onClose}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          <Check aria-hidden="true" />
          {t('files.share.done')}
        </Button>
      }
    >
      <div className={styles.share}>
        <section aria-label={t('files.share.currentHeading')}>
          <h3 className={styles.shareHeading}>{t('files.share.currentHeading')}</h3>
          {current.length === 0 ? (
            <p className={styles.empty}>{t('files.share.none')}</p>
          ) : (
            <ul className={styles.shareList}>
              {current.map((entry) => {
                const name = names[entry.principalId] ?? entry.principalId
                return (
                  <li key={entry.principalId} className={styles.shareRow}>
                    <span className={styles.shareName}>{name}</span>
                    {entry.role === 'custom' ? (
                      // Not a Select: there is no role to preselect, and offering one would invite
                      // overwriting a grant this client did not make and cannot describe.
                      <span className={styles.shareRole}>{roleLabel('custom')}</span>
                    ) : (
                      <Select
                        aria-label={t('files.share.roleFor', { name })}
                        value={entry.role}
                        disabled={busy}
                        onChange={(event) =>
                          void write(
                            withGrant(
                              shareWith,
                              entry.principalId,
                              event.target.value as ShareRole,
                            ),
                          )
                        }
                      >
                        {SHARE_ROLES.map((value) => (
                          <option key={value} value={value}>
                            {roleLabel(value)}
                          </option>
                        ))}
                      </Select>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('files.share.revokeFrom', { name })}
                      onClick={() => void write(withoutGrant(shareWith, entry.principalId))}
                    >
                      <UserMinus aria-hidden="true" />
                      {t('files.share.revoke')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section aria-label={t('files.share.addHeading')}>
          <h3 className={styles.shareHeading}>{t('files.share.addHeading')}</h3>
          <div className={styles.shareControls}>
            <span className={styles.shareField}>
              <label className={styles.shareLabel} htmlFor={searchId}>
                {t('files.share.search')}
              </label>
              <TextInput
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('files.share.searchPlaceholder')}
              />
            </span>
            <span className={styles.shareField}>
              <label className={styles.shareLabel} htmlFor={roleId}>
                {t('files.share.roleLabel')}
              </label>
              <Select
                id={roleId}
                value={role}
                onChange={(event) => setRole(event.target.value as ShareRole)}
              >
                {SHARE_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(value)}
                  </option>
                ))}
              </Select>
            </span>
          </div>
          {/* The role's meaning, spelled out. "Manager" is a word; "can share this with other
              people" is what the user is actually agreeing to. */}
          <p className={styles.shareHint}>{t(`files.share.explain.${role}`)}</p>

          {found === null ? (
            <div className={styles.loading}>
              <Spinner label={t('ui.spinner.label')} />
            </div>
          ) : candidates.length === 0 ? (
            <p className={styles.empty}>{t('files.share.noMatches')}</p>
          ) : (
            <ul className={styles.shareList}>
              {candidates.map((principal) => {
                const name = principalLabel(principal)
                return (
                  <li key={principal.id} className={styles.shareRow}>
                    <span className={styles.shareName}>{name}</span>
                    {principal.email !== null &&
                      principal.email !== undefined &&
                      principal.email !== name && (
                        <span className={styles.shareEmail}>{principal.email}</span>
                      )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t('files.share.grantTo', { name })}
                      onClick={() => void write(withGrant(shareWith, principal.id, role))}
                    >
                      <UserPlus aria-hidden="true" />
                      {t('files.share.grant')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Assertive: a share that did not happen is not something to find out about later. */}
        <p aria-live="assertive" className={styles.shareStatus}>
          {failed ? t('files.share.failed') : ''}
        </p>
      </div>
    </Dialog>
  )
}

export default ShareDialog

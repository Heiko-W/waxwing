/**
 * Settings → Identities (M5.1, FR-CMP-06).
 *
 * The user's send addresses and their signatures, editable in the client. Until now Waxwing only
 * READ `Identity/get`, which meant a signature could be changed by nobody but the server admin —
 * Stalwart's own self-service console covers passwords, app passwords and 2FA, not identities.
 *
 * Rendered only when the server advertises `urn:ietf:params:jmap:submission` (FR-SRV-02: an absent
 * capability is hidden, never broken).
 *
 * **It always edits the user's OWN account.** `connected.accountId` is
 * `primaryAccounts['urn:ietf:params:jmap:mail']`, never the account the mail pane is currently
 * acting in — a delegated mailbox grants access to messages and nothing about sending (ADR-020,
 * where Stalwart answers `Identity/get` on a delegated account with `forbidden` despite advertising
 * the capability on it), so offering to manage its identities would offer a send-as this client
 * deliberately does not do.
 *
 * The server, not the replica, is the source of truth here: the list is read through the client so
 * every write can carry the `ifInState` that came with it. Each successful write then mirrors the
 * fresh list into the replica, because the composer's From selector reads THAT — and the engine
 * pulls identities exactly once per leadership session, so without the mirror an edit made here
 * would not reach a draft until the next sign-in.
 */

import type { Id, Identity } from '@waxwing/jmap'
import { JmapMethodError } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import type { EditorFactory } from '../compose'
import { replaceIdentities, useReplicaOptional } from '../sync'
import { useEngineStatus } from '../sync/engine'
import { Button, Dialog, useToast } from '../ui'
import { IdentityForm } from './IdentityForm'
import {
  type IdentityClient,
  IdentitySetError,
  type IdentitySnapshot,
  makeIdentityClient,
  serverSupportsIdentities,
} from './identity-client'
import {
  EMPTY_IDENTITY_DRAFT,
  type IdentityDraft,
  toCreate,
  toDraft,
  toPatch,
} from './identity-model'
import styles from './settings.module.css'

export { serverSupportsIdentities }

export interface IdentitiesSectionProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: IdentityClient
  /** Injected in tests — the real editor lazy-loads Squire, which jsdom cannot run. */
  readonly editorFactory?: EditorFactory
}

type Editing = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly id: Id } | null

type Failure =
  | 'loadFailed'
  | 'conflict'
  | 'forbiddenFrom'
  | 'forbidden'
  | 'emailNotConfigured'
  | 'invalidProperties'
  | 'rejected'
  | 'offline'
  | 'generic'

/**
 * Spelled out rather than `t(\`settings.identities.error.${failure}\`)`: `guards.test.ts` only sees
 * LITERAL keys, so a computed one passes every gate and then renders the key itself on screen.
 */
function failureText(t: TFunction, failure: Failure): string {
  switch (failure) {
    case 'loadFailed':
      return t('settings.identities.error.loadFailed')
    case 'conflict':
      return t('settings.identities.error.conflict')
    case 'forbiddenFrom':
      return t('settings.identities.error.forbiddenFrom')
    case 'forbidden':
      return t('settings.identities.error.forbidden')
    case 'emailNotConfigured':
      return t('settings.identities.error.emailNotConfigured')
    case 'invalidProperties':
      return t('settings.identities.error.invalidProperties')
    case 'rejected':
      return t('settings.identities.error.rejected')
    case 'offline':
      return t('settings.identities.error.offline')
    case 'generic':
      return t('settings.identities.error.generic')
  }
}

/** Which failure a rejected write was. `stateMismatch` is handled by the caller (it repaints). */
function classify(thrown: unknown, offline: boolean): Failure {
  if (thrown instanceof IdentitySetError) {
    // `forbiddenFrom` (create — the user may not send from that address) and `forbidden` (destroy of
    // a `mayDelete: false` identity) are the two RFC 8621 §6 defines here, and the only two we can
    // explain precisely. Everything else is the server declining for a reason it did not name.
    if (thrown.type === 'forbiddenFrom') return 'forbiddenFrom'
    if (thrown.type === 'forbidden') return 'forbidden'
    if (thrown.type === 'invalidProperties') {
      // Measured against Stalwart v0.16.14 (ADR-022): creating an identity for an address the
      // account does not own comes back as `invalidProperties` naming `email`, NOT as the
      // `forbiddenFrom` the RFC defines for exactly that case. It is the likeliest way a create
      // fails, and "the server rejected one of these values" would leave the user with nothing to
      // act on — the fix is an alias, added server-side.
      return thrown.properties.includes('email') ? 'emailNotConfigured' : 'invalidProperties'
    }
    return 'rejected'
  }
  return offline ? 'offline' : 'generic'
}

export function IdentitiesSection(props: IdentitiesSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const status = useEngineStatus()
  const replica = useReplicaOptional()

  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [pendingDelete, setPendingDelete] = useState<Identity | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  // MEMOIZED for the reason VacationSection spells out at length: `makeIdentityClient` returns a
  // fresh object, the load effect below depends on it, and an unmemoized client would therefore
  // reload on every render — a request storm that Stalwart answers with HTTP 429.
  const client: IdentityClient | null = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeIdentityClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  const replicaDb = replica?.db ?? null
  const replicaAccountId = replica?.accountId ?? null
  /** Server list → state, and on into the replica the composer's From selector reads. */
  const apply = useCallback(
    (next: IdentitySnapshot): void => {
      setSnapshot(next)
      if (replicaDb !== null && replicaAccountId !== null) {
        // `replaceIdentities`, not `putIdentities`: a destroyed identity has to leave the replica,
        // or it keeps appearing in the From selector of every draft.
        void replaceIdentities(replicaDb, replicaAccountId, next.identities)
      }
    },
    [replicaDb, replicaAccountId],
  )

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === null) return
      apply(await client.list(signal))
    },
    [client, apply],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      // A load that SUCCEEDED clears whatever the last one said, or a transient failure is permanent
      // on screen — nothing else resets it, and the message would sit under a list that is
      // demonstrably fine. Only here, though: `failed()` repaints through `load()` too, and its
      // conflict message has to survive that repaint.
      .then(() => {
        if (!controller.signal.aborted) setFailure(null)
      })
      .catch((thrown: unknown) => {
        // An aborted request is not a failure — it is us, tearing the effect down. React StrictMode
        // double-invokes effects in development, and the client identity changes on reconnect or an
        // account switch, so treating the abort as an error would paint "could not be loaded" over a
        // list that loaded perfectly on the second run.
        if (controller.signal.aborted) return
        if (thrown instanceof DOMException && thrown.name === 'AbortError') return
        setFailure('loadFailed')
      })
    return () => controller.abort()
  }, [load])

  const offline = !status.online

  /** Shared tail of every write: classify the failure, and repaint on a state conflict. */
  const failed = useCallback(
    async (thrown: unknown): Promise<void> => {
      // A stale `ifInState` aborts the METHOD (RFC 8620 §5.3), so it lands here rather than in
      // `notUpdated`. Repaint from the server: we cannot know which version the user meant, and
      // keeping ours would discard whatever the other client wrote.
      if (thrown instanceof JmapMethodError && thrown.type === 'stateMismatch') {
        setFailure('conflict')
        await load().catch(() => {})
        return
      }
      setFailure(classify(thrown, offline))
    },
    [load, offline],
  )

  const identities = snapshot?.identities ?? []
  const current =
    editing?.mode === 'edit' ? identities.find((identity) => identity.id === editing.id) : undefined
  const initial: IdentityDraft =
    editing?.mode === 'edit' && current !== undefined ? toDraft(current) : EMPTY_IDENTITY_DRAFT
  const label = (identity: Identity): string =>
    identity.name.trim() !== '' ? identity.name : identity.email

  async function submit(draft: IdentityDraft): Promise<void> {
    if (client === null || snapshot === null || editing === null) return
    setBusy(true)
    setFailure(null)
    try {
      if (editing.mode === 'create') {
        const { snapshot: next } = await client.create(toCreate(draft), snapshot.state)
        apply(next)
        toast({ title: t('settings.identities.created') })
      } else if (current !== undefined) {
        const patch = toPatch(draft, current)
        // Nothing changed ⇒ no request. A `/set` that writes nothing still spends its `ifInState`,
        // so it can come back as a conflict caused by somebody ELSE's edit — a baffling thing to
        // show someone who typed nothing and pressed Save.
        if (Object.keys(patch).length > 0) {
          apply(await client.update(editing.id, patch, snapshot.state))
          toast({ title: t('settings.identities.saved') })
        }
      }
      setEditing(null)
    } catch (thrown) {
      await failed(thrown)
    } finally {
      setBusy(false)
    }
  }

  async function destroy(identity: Identity): Promise<void> {
    if (client === null || snapshot === null) return
    setBusy(true)
    setFailure(null)
    try {
      apply(await client.destroy(identity.id, snapshot.state))
      // Deleting the identity currently being edited has to close the form, or the next save would
      // patch an id the server no longer has.
      setEditing((current) =>
        current?.mode === 'edit' && current.id === identity.id ? null : current,
      )
      toast({ title: t('settings.identities.deleted') })
    } catch (thrown) {
      await failed(thrown)
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

  return (
    <div className={styles.controls}>
      <p className={styles.hint}>{t('settings.identities.description')}</p>

      {/* "Not loaded yet" and "no identities" look identical in a list, so say which it is —
          VacationSection can render defaults into a form and be corrected a moment later; a list
          cannot. */}
      {snapshot === null && failure === null && (
        <p className={styles.hint}>{t('settings.identities.loading')}</p>
      )}
      {snapshot !== null && identities.length === 0 && (
        <p className={styles.hint}>{t('settings.identities.empty')}</p>
      )}

      {identities.length > 0 && (
        <ul className={styles.identityList}>
          {identities.map((identity) => (
            <li key={identity.id} className={styles.identityRow}>
              <div className={styles.identityText}>
                <span className={styles.identityName}>{label(identity)}</span>
                <span className={styles.hint}>{identity.email}</span>
                {!identity.mayDelete && (
                  <span className={styles.hint}>{t('settings.identities.protected')}</span>
                )}
              </div>
              <div className={styles.rowActions}>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setEditing((now) =>
                      now?.mode === 'edit' && now.id === identity.id
                        ? null
                        : { mode: 'edit', id: identity.id },
                    )
                  }
                >
                  {t('settings.identities.edit.open', { name: label(identity) })}
                </Button>
                {/* Gated on `mayDelete` rather than letting the server answer `forbidden`: the flag
                    is on the record precisely so a client does not have to offer the failure. */}
                {identity.mayDelete && (
                  <Button
                    variant="ghost"
                    disabled={busy || offline}
                    onClick={() => setPendingDelete(identity)}
                  >
                    {t('settings.identities.delete.open', { email: identity.email })}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing === null && (
        <div>
          <Button
            variant="ghost"
            disabled={busy || offline || snapshot === null}
            onClick={() => {
              setFailure(null)
              setEditing({ mode: 'create' })
            }}
          >
            {t('settings.identities.create.open')}
          </Button>
        </div>
      )}

      {editing !== null && (
        <IdentityForm
          // Remounting on every switch is what resets the draft to the identity being edited.
          key={editing.mode === 'edit' ? editing.id : 'new'}
          initial={initial}
          creating={editing.mode === 'create'}
          busy={busy}
          saveError={failure !== null ? failureText(t, failure) : null}
          onSubmit={(draft) => void submit(draft)}
          onCancel={() => {
            setEditing(null)
            setFailure(null)
          }}
          {...(props.editorFactory ? { editorFactory: props.editorFactory } : {})}
        />
      )}

      {failure !== null && editing === null && (
        <p role="alert" className={styles.hint}>
          {failureText(t, failure)}
        </p>
      )}

      {offline && <p className={styles.hint}>{t('settings.identities.error.offline')}</p>}

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('settings.identities.delete.title')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('settings.identities.delete.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pendingDelete !== null) void destroy(pendingDelete)
              }}
            >
              {t('settings.identities.delete.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('settings.identities.delete.body', { email: pendingDelete?.email ?? '' })}</p>
        {/* A saved draft keeps `fromIdentityId`, and the send path fails with `noIdentity` when the
            row is gone — so this warning is about drafts that already exist, not a hypothetical. */}
        <p>{t('settings.identities.delete.draftsWarning')}</p>
      </Dialog>
    </div>
  )
}

/**
 * Settings → Account & security — the self-service surface Stalwart exposes over
 * `urn:stalwart:jmap` (findings X-1, X-2, X-4, X-5, X-6 of the 2026-08-21 JMAP gap analysis).
 *
 * App passwords, the account password, the language the server writes its own notifications in,
 * whether it encrypts the mailbox at rest, and which of the reader's messages it is keeping as spam
 * training samples. Until now none of this existed in Waxwing at all: a Waxwing user had to open
 * Stalwart's own console to change their password, and had no way whatsoever to give a phone its
 * own credential.
 *
 * **Rendered only where the server advertises the capability, and there is a test that fails if
 * that stops being true** (product principle 6; FR-SRV-02: an absent capability is hidden, never
 * broken). The check is `serverSupportsSelfService`, which asks BOTH capability levels — Stalwart
 * announces this URN on the account and not on the session, so a session-level probe would hide the
 * section on the only server that has it.
 *
 * Inside the section the gating goes one level finer. The registry has a permission per object type
 * and a server may withhold any of them — an external LDAP directory takes the password away
 * (`sysAccountPassword*`), a restricted app password takes nearly everything away — so each block
 * is present only if its read came back. A block whose only possible outcome is `forbidden` does
 * not appear.
 *
 * The section edits the user's OWN account (`connected.accountId`), never a delegated one: ADR-020.
 */

import type { TFunction } from 'i18next'
import { useCallback, useContext, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../app/config-context'
import { SessionContext, useSessionOptional } from '../app/session/context'
import { formatDate } from '../i18n/formatters'
import { useEngineStatus } from '../sync/engine'
import { Button, Dialog, Select, useToast } from '../ui'
import { AppPasswordDialog } from './AppPasswordDialog'
import { PasswordChangeDialog } from './PasswordChangeDialog'
import styles from './settings.module.css'
import {
  makeSelfServiceClient,
  type SelfServiceClient,
  type SelfServiceSnapshot,
  StalwartSetError,
  serverSupportsSelfService,
} from './stalwart-client'
import {
  type AppPasswordView,
  languageLabel,
  languageOptions,
  type SpamSampleView,
} from './stalwart-model'

export { serverSupportsSelfService }

export interface SecuritySectionProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: SelfServiceClient
}

/**
 * A refusal, as something the screen can say.
 *
 * `detail` is the SERVER's own sentence, shown verbatim after a translated headline. It is the
 * honest answer to a registry that returns `forbidden` both for "your current password is wrong"
 * and for "an external directory owns this password": the two are indistinguishable by `type`, and
 * translating a guess would be worse than quoting the server.
 */
type Failure =
  | { readonly kind: 'offline' }
  | { readonly kind: 'generic' }
  | { readonly kind: 'rejected'; readonly detail: string | null }

/** Spelled out, not computed: `guards.test.ts` only sees LITERAL keys, so a computed one ships broken. */
function failureText(t: TFunction, failure: Failure): string {
  switch (failure.kind) {
    case 'offline':
      return t('settings.security.error.offline')
    case 'generic':
      return t('settings.security.error.generic')
    case 'rejected':
      return failure.detail === null
        ? t('settings.security.error.rejected')
        : `${t('settings.security.error.rejected')} ${t('settings.security.error.server', {
            detail: failure.detail,
          })}`
  }
}

function classify(thrown: unknown, offline: boolean): Failure {
  if (thrown instanceof StalwartSetError) {
    return { kind: 'rejected', detail: thrown.serverDescription }
  }
  return offline ? { kind: 'offline' } : { kind: 'generic' }
}

/** A date the server sent, or nothing at all — never the string "Invalid Date". */
function day(iso: string | null): string | null {
  if (iso === null) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? formatDate(at) : null
}

export function SecuritySection(props: SecuritySectionProps) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const session = useContext(SessionContext)
  // Four sentences name the client itself ("… has no OpenPGP support"). FR-THEME-02: the name is
  // read from the deployment's branding, never written into a string.
  const product = useConfig().branding.productName
  const status = useEngineStatus()
  const languageId = useId()

  const [snapshot, setSnapshot] = useState<SelfServiceSnapshot | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [creating, setCreating] = useState(false)
  const [changing, setChanging] = useState(false)
  const [revoking, setRevoking] = useState<AppPasswordView | null>(null)
  const [busy, setBusy] = useState(false)

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  // MEMOIZED for the reason VacationSection spells out: `makeSelfServiceClient` returns a fresh
  // object, the load effect depends on it, and an unmemoized one reloads on every render — a
  // request storm Stalwart answers with HTTP 429.
  const client: SelfServiceClient | null = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeSelfServiceClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === null) return
      setSnapshot(await client.load(signal))
    },
    [client],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setLoadFailed(false)
      })
      .catch((thrown: unknown) => {
        // An aborted request is us tearing the effect down (React StrictMode double-invokes), not a
        // failure — painting "could not be loaded" over a list that loaded on the second run is how
        // that mistake looks.
        if (controller.signal.aborted) return
        if (thrown instanceof DOMException && thrown.name === 'AbortError') return
        setLoadFailed(true)
      })
    return () => controller.abort()
  }, [load])

  const offline = !status.online

  /** Every write ends the same way: reload, or say why not. */
  const after = useCallback(
    async (thrown: unknown): Promise<void> => {
      setFailure(classify(thrown, offline))
    },
    [offline],
  )

  async function revoke(password: AppPasswordView): Promise<void> {
    if (client === null) return
    setBusy(true)
    setFailure(null)
    try {
      await client.destroyAppPassword(password.id)
      await load()
      toast({ title: t('settings.security.appPasswords.revoked') })
      setRevoking(null)
    } catch (thrown) {
      await after(thrown)
    } finally {
      setBusy(false)
    }
  }

  async function chooseLanguage(locale: string): Promise<void> {
    if (client === null) return
    setBusy(true)
    setFailure(null)
    try {
      await client.setLanguage(locale)
      await load()
      toast({ title: t('settings.security.language.saved') })
    } catch (thrown) {
      await after(thrown)
    } finally {
      setBusy(false)
    }
  }

  async function forget(sample: SpamSampleView): Promise<void> {
    if (client === null) return
    setBusy(true)
    setFailure(null)
    try {
      await client.destroySpamSample(sample.id)
      await load()
      toast({ title: t('settings.security.spam.deleted') })
    } catch (thrown) {
      await after(thrown)
    } finally {
      setBusy(false)
    }
  }

  /**
   * The password just changed, so the credential this device is signing in with is now the wrong
   * one.
   *
   * Waxwing signs in over HTTP Basic and re-sends those credentials on every request; nothing about
   * a password change reaches them. Left alone, the reader would keep working until some unrelated
   * request came back 401 and the app asked for a password out of nowhere. `reportAuthExpired()` is
   * the FR-AUTH-06 funnel — it asks now, in the context of what they just did, and it does not
   * discard a single draft doing it. An OAuth session keeps its access token and needs none of
   * this.
   */
  function reauthenticate(): void {
    toast({ title: t('settings.security.password.changed') })
    setChanging(false)
    if (connected?.method === 'basic') session?.reportAuthExpired()
  }

  async function createAppPassword(input: {
    description: string
    expiresAt: string | null
  }): Promise<{ secret: string }> {
    if (client === null) throw new StalwartSetError('serverFail', null)
    setFailure(null)
    // The secret is RETURNED, not stored: it goes straight into the dialog's own state and this
    // component never sees it again. Nothing here logs, toasts or persists it.
    return await client.createAppPassword(input)
  }

  const appPasswords = snapshot?.appPasswords ?? null
  const spamSamples = snapshot?.spamSamples ?? null
  const encryption = snapshot?.encryption ?? null
  const language = snapshot?.language ?? null
  const nothingOffered =
    snapshot !== null &&
    appPasswords === null &&
    spamSamples === null &&
    encryption === null &&
    !snapshot.passwordReadable

  const uiLanguage = i18n.resolvedLanguage ?? i18n.language

  return (
    <>
      <p className={styles.hint}>{t('settings.security.description')}</p>

      {snapshot === null && !loadFailed && (
        <p className={styles.hint}>{t('settings.security.loading')}</p>
      )}
      {loadFailed && (
        <p role="alert" className={styles.error}>
          {t('settings.security.error.loadFailed')}
        </p>
      )}
      {nothingOffered && <p className={styles.hint}>{t('settings.security.unavailable')}</p>}

      {snapshot?.passwordReadable === true && (
        <fieldset className={styles.groupBox}>
          <legend className={styles.label}>{t('settings.security.password.label')}</legend>
          <p className={styles.hint}>{t('settings.security.password.hint')}</p>
          <Button variant="ghost" disabled={offline || busy} onClick={() => setChanging(true)}>
            {t('settings.security.password.change')}
          </Button>
        </fieldset>
      )}

      {appPasswords !== null && (
        <fieldset className={styles.groupBox}>
          <legend className={styles.label}>{t('settings.security.appPasswords.label')}</legend>
          <p className={styles.hint}>{t('settings.security.appPasswords.hint')}</p>
          {appPasswords.length === 0 ? (
            <p className={styles.hint}>{t('settings.security.appPasswords.empty')}</p>
          ) : (
            // The card's "list of records" recipe, shared with Identities: rows of the one card,
            // never a card of their own (G2).
            <ul className={styles.identityList}>
              {appPasswords.map((password) => {
                const created = day(password.createdAt)
                const expires = day(password.expiresAt)
                return (
                  <li key={password.id} className={styles.identityRow}>
                    <div className={styles.identityText}>
                      <span className={styles.identityName}>{password.description}</span>
                      {created !== null && (
                        <span className={styles.hint}>
                          {t('settings.security.appPasswords.created', { date: created })}
                        </span>
                      )}
                      {password.expired ? (
                        <span className={styles.hint}>
                          {t('settings.security.appPasswords.expired')}
                        </span>
                      ) : (
                        expires !== null && (
                          <span className={styles.hint}>
                            {t('settings.security.appPasswords.expires', { date: expires })}
                          </span>
                        )
                      )}
                      {/* Waxwing never sets `permissions` or `allowedIps` — see stalwart-client.ts.
                          Saying so is the difference between "this password is broken" and "this
                          password only works from the office". */}
                      {password.restricted && (
                        <span className={styles.hint}>
                          {t('settings.security.appPasswords.restricted', { product })}
                        </span>
                      )}
                    </div>
                    <div className={styles.rowActions}>
                      <Button
                        variant="ghost"
                        disabled={busy || offline}
                        onClick={() => setRevoking(password)}
                      >
                        {t('settings.security.appPasswords.revoke', {
                          name: password.description,
                        })}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <div className={styles.rowActions}>
            <Button variant="ghost" disabled={busy || offline} onClick={() => setCreating(true)}>
              {t('settings.security.appPasswords.create')}
            </Button>
          </div>
        </fieldset>
      )}

      {language !== null && (
        <div className={styles.group}>
          <label htmlFor={languageId} className={styles.label}>
            {t('settings.security.language.label')}
          </label>
          <Select
            id={languageId}
            value={language}
            disabled={busy || offline}
            onChange={(event) => void chooseLanguage(event.target.value)}
          >
            {languageOptions(language).map((option) => (
              <option key={option} value={option}>
                {languageLabel(option, uiLanguage)}
              </option>
            ))}
          </Select>
          <p className={styles.hint}>{t('settings.security.language.hint', { product })}</p>
        </div>
      )}

      {encryption !== null && (
        <div className={styles.group}>
          <p className={styles.label}>{t('settings.security.encryption.label')}</p>
          {/*
           * Read-only, deliberately, and this is the one place in the section where that is a
           * safety decision rather than a scope one.
           *
           * The switch exists in the registry and Waxwing could throw it. But Waxwing has no
           * OpenPGP stack: with encryption at rest on, incoming mail is stored as
           * `multipart/encrypted` and this client cannot display a word of it. Offering the switch
           * would mean offering to make the reader's mailbox unreadable in the very app they threw
           * it from — and turning it back off does not decrypt what arrived meanwhile. So Waxwing
           * reports the state, explains what it means for this client, and points at the console
           * that owns it.
           */}
          {encryption.kind === 'off' ? (
            <p className={styles.hint}>{t('settings.security.encryption.off')}</p>
          ) : (
            <>
              <p className={styles.identityName}>
                {t('settings.security.encryption.on', { cipher: encryption.cipher })}
              </p>
              {encryption.keyLabel !== null && (
                <p className={styles.hint}>
                  {t('settings.security.encryption.key', { name: encryption.keyLabel })}
                </p>
              )}
              <p className={styles.findingWarn}>
                {t('settings.security.encryption.explain', { product })}
              </p>
              <p className={styles.hint}>{t('settings.security.encryption.manage', { product })}</p>
            </>
          )}
        </div>
      )}

      {spamSamples !== null && (
        <fieldset className={styles.groupBox}>
          <legend className={styles.label}>{t('settings.security.spam.label')}</legend>
          <p className={styles.hint}>{t('settings.security.spam.hint')}</p>
          {spamSamples.length === 0 ? (
            <p className={styles.hint}>{t('settings.security.spam.empty')}</p>
          ) : (
            <ul className={styles.identityList}>
              {spamSamples.map((sample) => {
                const subject =
                  sample.subject.trim() === ''
                    ? t('settings.security.spam.noSubject')
                    : sample.subject
                return (
                  <li key={sample.id} className={styles.identityRow}>
                    <div className={styles.identityText}>
                      <span className={styles.identityName}>{subject}</span>
                      <span className={styles.hint}>{sample.from}</span>
                      <span className={styles.hint}>
                        {sample.isSpam
                          ? t('settings.security.spam.isSpam')
                          : t('settings.security.spam.isHam')}
                      </span>
                    </div>
                    <div className={styles.rowActions}>
                      <Button
                        variant="ghost"
                        disabled={busy || offline}
                        onClick={() => void forget(sample)}
                      >
                        {t('settings.security.spam.delete', { subject })}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </fieldset>
      )}

      {failure !== null && !creating && !changing && (
        <p role="alert" className={styles.error}>
          {failureText(t, failure)}
        </p>
      )}

      {offline && snapshot !== null && (
        <p className={styles.hint}>{t('settings.security.error.offline')}</p>
      )}

      <PasswordChangeDialog
        open={changing}
        offline={offline}
        failure={changing && failure !== null ? failureText(t, failure) : null}
        onClose={() => {
          setChanging(false)
          setFailure(null)
        }}
        change={async (currentSecret, secret) => {
          if (client === null) throw new StalwartSetError('serverFail', null)
          setFailure(null)
          try {
            await client.changePassword(currentSecret, secret)
          } catch (thrown) {
            await after(thrown)
            throw thrown
          }
        }}
        onChanged={reauthenticate}
      />

      <AppPasswordDialog
        open={creating}
        offline={offline}
        failure={creating && failure !== null ? failureText(t, failure) : null}
        onClose={() => {
          setCreating(false)
          setFailure(null)
        }}
        create={async (input) => {
          try {
            return await createAppPassword(input)
          } catch (thrown) {
            await after(thrown)
            throw thrown
          }
        }}
        onCreated={() => void load().catch(() => {})}
      />

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('settings.security.appPasswords.revokeTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t('settings.security.appPasswords.revokeCancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (revoking !== null) void revoke(revoking)
              }}
            >
              {t('settings.security.appPasswords.revokeConfirm')}
            </Button>
          </>
        }
      >
        <p>
          {t('settings.security.appPasswords.revokeBody', { name: revoking?.description ?? '' })}
        </p>
      </Dialog>
    </>
  )
}

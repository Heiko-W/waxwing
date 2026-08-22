/**
 * Create an app password, and show its secret — once.
 *
 * The whole flow lives in one dialog because the secret does: the server generates it, returns it
 * in the `created` echo, and answers `"****"` to every read afterwards. There is no second chance
 * and no "show it again", so the moment it arrives is the only moment it can be handed over.
 *
 * **The secret is held in this component's state and nowhere else.** Not in the replica, not in
 * `localStorage`, not in a toast, not in a log line, and never in the props the parent passes back
 * down — closing the dialog is what destroys it. `security.test.tsx` holds that as an assertion
 * rather than as an intention.
 *
 * The shape follows Apple's app-specific passwords: a name so it can be told apart later, then a
 * screen whose only job is the secret — large, monospace, selectable in one gesture, with a copy
 * button and a calm sentence saying it will not be shown again. Not a red alert: nothing has gone
 * wrong, and the way out if it is lost (revoke it, make another) is one line away.
 */

import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Select, TextInput } from '../ui'
import styles from './settings.module.css'
import { APP_PASSWORD_LIFETIMES, expiryFromDays } from './stalwart-model'

export interface AppPasswordDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Resolves with the one-and-only copy of the secret. */
  create(input: {
    readonly description: string
    readonly expiresAt: string | null
  }): Promise<{ readonly secret: string }>
  /** The server has one more app password now — the parent re-reads its list. */
  onCreated: () => void
  /** A finished, translated sentence for a refusal, or `null`. Owned by the parent. */
  readonly failure: string | null
  readonly offline: boolean
}

/** How long "Copied" stands before the button goes back to offering the action. */
const COPIED_RESET_MS = 2000

export function AppPasswordDialog(props: AppPasswordDialogProps) {
  const { t } = useTranslation()
  const nameId = useId()
  const expiryId = useId()
  const secretId = useId()

  const [description, setDescription] = useState('')
  const [days, setDays] = useState<number | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [nameMissing, setNameMissing] = useState(false)
  const [copied, setCopied] = useState(false)

  /*
   * Closing wipes it.
   *
   * The dialog stays MOUNTED between openings (that is what lets `Dialog` return focus to the
   * button that opened it), so without this the last secret would still be in React state — and
   * back on screen — the next time the reader opened the dialog to make a different one.
   */
  useEffect(() => {
    if (props.open) return
    setDescription('')
    setDays(null)
    setSecret(null)
    setNameMissing(false)
    setCopied(false)
  }, [props.open])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])

  async function submit(): Promise<void> {
    const name = description.trim()
    if (name === '') {
      setNameMissing(true)
      return
    }
    setNameMissing(false)
    setBusy(true)
    try {
      const created = await props.create({
        description: name,
        expiresAt: expiryFromDays(days, Date.now()),
      })
      setSecret(created.secret)
      props.onCreated()
    } catch {
      // The parent classified it and owns the sentence; it comes back down as `failure`.
    } finally {
      setBusy(false)
    }
  }

  function copy(): void {
    if (secret === null) return
    void navigator.clipboard?.writeText(secret).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  const revealing = secret !== null

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={
        revealing
          ? t('settings.security.appPasswords.secretTitle')
          : t('settings.security.appPasswords.createTitle')
      }
      size="sm"
      // While the secret is on screen a stray press on the backdrop throws away something that
      // cannot be fetched again. Escape and the close button still work — the sentence above the
      // button says what to do if it is lost — but nothing here is lost by ACCIDENT.
      dismissOnBackdrop={!revealing}
      footer={
        revealing ? (
          <Button onClick={props.onClose}>{t('settings.security.appPasswords.done')}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              {t('settings.security.appPasswords.cancel')}
            </Button>
            <Button loading={busy} disabled={props.offline} onClick={() => void submit()}>
              {t('settings.security.appPasswords.submit')}
            </Button>
          </>
        )
      }
    >
      {revealing ? (
        <div className={styles.form}>
          <p className={styles.hint}>{t('settings.security.appPasswords.secretIntro')}</p>
          <div className={styles.group}>
            <span id={secretId} className={styles.label}>
              {t('settings.security.appPasswords.secretLabel')}
            </span>
            {/* `aria-labelledby` and a text role, not a read-only input: the value must be
                selectable and announced, and an <input> would invite a browser's password manager
                to offer to remember something we have just promised not to keep. */}
            <output className={styles.secret} aria-labelledby={secretId}>
              {secret}
            </output>
            <Button variant="ghost" onClick={copy}>
              {copied
                ? t('settings.security.appPasswords.copied')
                : t('settings.security.appPasswords.copy')}
            </Button>
          </div>
          <p className={styles.secretWarning}>
            {t('settings.security.appPasswords.secretWarning')}
          </p>
        </div>
      ) : (
        <div className={styles.form}>
          <p className={styles.hint}>{t('settings.security.appPasswords.createIntro')}</p>
          <div className={styles.group}>
            <label htmlFor={nameId} className={styles.label}>
              {t('settings.security.appPasswords.name')}
            </label>
            <TextInput
              id={nameId}
              value={description}
              invalid={nameMissing}
              autoComplete="off"
              placeholder={t('settings.security.appPasswords.namePlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
            {nameMissing && (
              <p role="alert" className={styles.error}>
                {t('settings.security.appPasswords.nameMissing')}
              </p>
            )}
          </div>
          <div className={styles.group}>
            <label htmlFor={expiryId} className={styles.label}>
              {t('settings.security.appPasswords.expiry')}
            </label>
            <Select
              id={expiryId}
              value={days === null ? 'never' : String(days)}
              onChange={(event) =>
                setDays(event.target.value === 'never' ? null : Number(event.target.value))
              }
            >
              {APP_PASSWORD_LIFETIMES.map((lifetime) => (
                <option
                  key={lifetime ?? 'never'}
                  value={lifetime === null ? 'never' : String(lifetime)}
                >
                  {lifetime === null
                    ? t('settings.security.appPasswords.expiryNever')
                    : t('settings.security.appPasswords.expiryDays', { days: lifetime })}
                </option>
              ))}
            </Select>
          </div>
          {props.failure !== null && (
            <p role="alert" className={styles.error}>
              {props.failure}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}

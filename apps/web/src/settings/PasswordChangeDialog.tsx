/**
 * Change the account password (`x:AccountPassword/set`).
 *
 * Three fields, in the order every operating system asks for them: the current password, the new
 * one, and the new one again. The current password is not a formality — the server requires it
 * (`"Current secret must be provided to change the password or OTP auth."`) and bans an account
 * that gets it wrong too often, so it is a field, never an assumption.
 *
 * The passwords are held in state for the length of the dialog and cleared when it closes. They are
 * not passed upward: the parent gets told "it worked", not what was typed.
 *
 * **What this deliberately does NOT do is judge the new password.** Stalwart checks strength itself
 * (`is_secure_password`) and answers `invalidProperties` on `secret` with a sentence naming the
 * rule it broke — "Password must be at least 8 characters long." A second, client-side rule would
 * be a guess at a policy the server owns, and would reject passwords the server would have taken.
 * The one check here is that the two new fields agree, which no server can make for us.
 */

import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../ui'
import styles from './settings.module.css'

export interface PasswordChangeDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  change(currentSecret: string, secret: string): Promise<void>
  /** The server accepted it. The parent decides what that means for this signed-in device. */
  onChanged: () => void
  /** A finished, translated sentence for a refusal, or `null`. Owned by the parent. */
  readonly failure: string | null
  readonly offline: boolean
}

export function PasswordChangeDialog(props: PasswordChangeDialogProps) {
  const { t } = useTranslation()
  const currentId = useId()
  const nextId = useId()
  const confirmId = useId()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [local, setLocal] = useState<'missing' | 'mismatch' | null>(null)
  const [busy, setBusy] = useState(false)

  // Closing wipes all three. The dialog stays mounted so `Dialog` can hand focus back to the button
  // that opened it, which means state outlives the closing unless something clears it.
  useEffect(() => {
    if (props.open) return
    setCurrent('')
    setNext('')
    setConfirm('')
    setLocal(null)
  }, [props.open])

  async function submit(): Promise<void> {
    if (current === '' || next === '' || confirm === '') {
      setLocal('missing')
      return
    }
    if (next !== confirm) {
      setLocal('mismatch')
      return
    }
    setLocal(null)
    setBusy(true)
    try {
      await props.change(current, next)
      props.onChanged()
    } catch {
      // The parent classified it and owns the sentence; it comes back down as `failure`.
    } finally {
      setBusy(false)
    }
  }

  const localText =
    local === 'missing'
      ? t('settings.security.password.missing')
      : local === 'mismatch'
        ? t('settings.security.password.mismatch')
        : null

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('settings.security.password.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t('settings.security.password.cancel')}
          </Button>
          <Button loading={busy} disabled={props.offline} onClick={() => void submit()}>
            {t('settings.security.password.submit')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.group}>
          <label htmlFor={currentId} className={styles.label}>
            {t('settings.security.password.current')}
          </label>
          <TextInput
            id={currentId}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </div>
        <div className={styles.group}>
          <label htmlFor={nextId} className={styles.label}>
            {t('settings.security.password.next')}
          </label>
          <TextInput
            id={nextId}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </div>
        <div className={styles.group}>
          <label htmlFor={confirmId} className={styles.label}>
            {t('settings.security.password.confirm')}
          </label>
          <TextInput
            id={confirmId}
            type="password"
            autoComplete="new-password"
            invalid={local === 'mismatch'}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        {/* What happens NEXT, said before it happens: a Basic-auth session keeps sending the old
            password, so this device will ask for the new one, and every other mail app on every
            other device will too. A password change that silently breaks four clients is how a
            settings screen earns a support ticket. */}
        <p className={styles.hint}>{t('settings.security.password.devices')}</p>
        {(localText ?? props.failure) !== null && (
          <p role="alert" className={styles.error}>
            {localText ?? props.failure}
          </p>
        )}
      </div>
    </Dialog>
  )
}

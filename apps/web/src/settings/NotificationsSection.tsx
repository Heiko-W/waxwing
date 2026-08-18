/**
 * Settings → "Notifications" (M3.6, FR-NOTIF-03).
 *
 * Two things it must never do, and the reasons they are worth a comment:
 *
 *  - **It never asks for permission except from the switch's click.** A prompt that did not follow a
 *    user gesture is auto-denied, and that denial sticks to the origin forever — an unsolicited
 *    prompt does not annoy the user, it destroys the feature for them. So the request lives in
 *    `onCheckedChange` and nowhere else.
 *  - **It never claims more about background notifications than the code delivers.** Since M4.0 the
 *    client half exists (ADR-017, owner decision D6a), so the capability probe now selects between
 *    "this server cannot" and "this server can" — but the second case is deliberately THREE
 *    sentences, not one. A closed-app banner names no sender and no subject, the folder list on this
 *    very screen does not apply to it, and the subscription expires after seven days unless the app
 *    is opened. Showing the good news without those would be the same lie in a friendlier register,
 *    and NFR-PRIV-02 is the requirement that forbids it.
 *
 * Lives in the lazy `/settings` chunk, so none of it costs the entry bundle anything.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../app/config-context'
import {
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_QUIET_HOURS,
  minutesToTimeValue,
  NOTIFY_PREF_KEY,
  type NotificationPermissionApi,
  type NotificationPrefs,
  timeValueToMinutes,
  useBackgroundPushSupport,
  useNotificationPermission,
} from '../notify'
import { coerceNotificationPrefs } from '../notify/notify-model'
import { useInstallPrompt } from '../pwa/install/use-install-prompt'
import {
  mailboxByRole,
  updateNotificationPrefs,
  useLocalPref,
  useMailboxByRole,
  useMailboxes,
  useReplica,
} from '../sync'
import { Checkbox, Switch, TextInput } from '../ui'
import styles from './settings.module.css'

export interface NotificationsSectionProps {
  /** Injected in tests — jsdom has no Notification API at all. */
  readonly permission?: NotificationPermissionApi
  /** Injected in tests; defaults to the RFC 9749 probe against the live session. */
  readonly backgroundPush?: boolean
}

/**
 * One bound of the quiet-hours range, holding its OWN editing state.
 *
 * A plain controlled `<input type="time">` bound straight to `useLocalPref` is unusable: the pref is
 * written on every keystroke and the Dexie liveQuery re-emits BETWEEN the two digits of an hour,
 * resetting the sub-field mid-edit — typing "18" landed as "08" (2026-07-24 hand-test, no automated
 * test could see it: the race is between the human's second keystroke and the async round-trip). The
 * displayed value therefore has to be local. The only external change to a bound is the user's own
 * echo (which must be ignored) or toggling quiet hours off (which unmounts this), so the value is
 * initialised once and never re-synced from the prop.
 */
export function QuietBoundInput({
  id,
  minutes,
  onCommit,
}: {
  readonly id: string
  readonly minutes: number
  readonly onCommit: (minutes: number) => void
}) {
  const [value, setValue] = useState(() => minutesToTimeValue(minutes))
  return (
    <TextInput
      id={id}
      type="time"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
        const next = timeValueToMinutes(event.target.value)
        // A cleared field is not a new time — keep the local value, write nothing.
        if (next !== null) onCommit(next)
      }}
    />
  )
}

export function NotificationsSection(props: NotificationsSectionProps) {
  const { t } = useTranslation()
  const config = useConfig()
  const product = config.branding.productName
  const { db, accountId } = useReplica()

  const realPermission = useNotificationPermission()
  const permission = props.permission ?? realPermission
  const realBackgroundPush = useBackgroundPushSupport()
  const backgroundPush = props.backgroundPush ?? realBackgroundPush

  const install = useInstallPrompt()
  const stored = useLocalPref<unknown>(NOTIFY_PREF_KEY)
  const prefs = stored === undefined ? DEFAULT_NOTIFICATION_PREFS : coerceNotificationPrefs(stored)

  const mailboxes = useMailboxes()
  const inbox = useMailboxByRole('inbox')

  /**
   * The user opened the browser's permission prompt and DISMISSED it (the X, or Escape) — the state
   * stays `default`. Without this, the switch simply springs back to off and the app says nothing at
   * all, which reads like a bug. Purely local: the browser will ask again next time, so there is
   * nothing here worth persisting.
   */
  const [promptDismissed, setPromptDismissed] = useState(false)

  const ids = {
    enable: useId(),
    folders: useId(),
    quiet: useId(),
    quietFrom: useId(),
    quietTo: useId(),
    preview: useId(),
    sound: useId(),
  }

  function write(fn: (current: NotificationPrefs) => NotificationPrefs): void {
    void updateNotificationPrefs(db, accountId, fn)
  }

  /**
   * The master switch. Turning it ON is the only moment we may prompt, and the only moment at which
   * we have a granted permission — so it is also where the default folder is seeded.
   *
   * The Inbox is read from the REPLICA here, not from the rendered `useMailboxByRole` value. That
   * hook is a liveQuery: on a cold Settings screen it is still `undefined` for the first frames, and
   * a user who flips this switch inside that window would have enabled notifications with an EMPTY
   * folder list — permission granted, switch on, and nothing would ever notify. Silently.
   *
   * Turning it OFF writes `enabled: false` and nothing else: it must never look like it revoked the
   * browser permission, because it cannot.
   */
  async function toggleEnabled(next: boolean): Promise<void> {
    if (!next) {
      write((current) => ({ ...current, enabled: false }))
      return
    }
    const state = permission.state === 'default' ? await permission.request() : permission.state
    // Still `default` ⇒ the prompt was dismissed rather than answered. Say so; a switch that silently
    // springs back is indistinguishable from a broken one.
    setPromptDismissed(state === 'default')
    if (state !== 'granted') return

    const seeded = inbox ?? (await mailboxByRole(db, accountId, 'inbox'))
    write((current) => ({
      ...current,
      enabled: true,
      // Inbox only, by default: it is the one folder whose arrivals are unfiled new mail. Everything
      // else fills up as a RESULT of the user's own filing or a server-side rule, and buzzing for
      // those is noise. (Apple Mail defaults the same way.)
      mailboxIds: current.mailboxIds.length > 0 ? current.mailboxIds : seeded ? [seeded.id] : [],
    }))
  }

  function toggleQuietHours(next: boolean): void {
    write((current) => ({ ...current, quietHours: next ? DEFAULT_QUIET_HOURS : null }))
  }

  function setQuietBound(bound: 'fromMinutes' | 'toMinutes', minutes: number): void {
    write((current) => ({
      ...current,
      quietHours: { ...(current.quietHours ?? DEFAULT_QUIET_HOURS), [bound]: minutes },
    }))
  }

  function toggleFolder(mailboxId: string, next: boolean): void {
    write((current) => ({
      ...current,
      mailboxIds: next
        ? [...current.mailboxIds, mailboxId]
        : current.mailboxIds.filter((id) => id !== mailboxId),
    }))
  }

  const supported = permission.state !== 'unsupported'
  const blocked = permission.state === 'denied'
  const showDetails = permission.state === 'granted' && prefs.enabled

  // iOS has no Notification API outside a home-screen install, so "unsupported" there is not a dead
  // end — it is an instruction.
  const unsupportedNote =
    install.platform === 'ios' && !install.isStandalone
      ? t('notify.permission.iosInstall', { product })
      : t('notify.permission.unsupported')

  const stateNote = !supported
    ? unsupportedNote
    : blocked
      ? t('notify.permission.denied', { product })
      : promptDismissed
        ? t('notify.permission.dismissed')
        : null

  return (
    <div className={styles.controls}>
      <p className={styles.hint}>{t('notify.description', { product })}</p>

      <div className={styles.field}>
        <Switch
          block
          id={ids.enable}
          checked={prefs.enabled && permission.state === 'granted'}
          disabled={!supported || blocked}
          label={t('notify.enable.label')}
          {...(stateNote === null ? {} : { 'aria-describedby': `${ids.enable}-note` })}
          onCheckedChange={(next) => void toggleEnabled(next)}
        />
        {stateNote !== null && (
          <p id={`${ids.enable}-note`} className={styles.hint}>
            {stateNote}
          </p>
        )}
      </div>

      {showDetails && (
        <>
          {/* A real <fieldset>/<legend>: a group of checkboxes is exactly what they are for, and a
              screen reader announces the legend before each folder name without any ARIA at all. */}
          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>{t('notify.folders.label')}</legend>
            {(mailboxes ?? []).map((mailbox) => (
              <Checkbox
                key={mailbox.id}
                checked={prefs.mailboxIds.includes(mailbox.id)}
                label={mailbox.name}
                onChange={(event) => toggleFolder(mailbox.id, event.target.checked)}
              />
            ))}
            <p className={styles.hint}>{t('notify.folders.hint')}</p>
          </fieldset>

          <div className={styles.field}>
            <Switch
              block
              id={ids.quiet}
              checked={prefs.quietHours !== null}
              label={t('notify.quiet.label')}
              aria-describedby={`${ids.quiet}-hint`}
              onCheckedChange={toggleQuietHours}
            />
            {prefs.quietHours !== null && (
              <div className={styles.controls}>
                <label htmlFor={ids.quietFrom} className={styles.label}>
                  {t('notify.quiet.from')}
                </label>
                <QuietBoundInput
                  id={ids.quietFrom}
                  minutes={prefs.quietHours.fromMinutes}
                  onCommit={(minutes) => setQuietBound('fromMinutes', minutes)}
                />
                <label htmlFor={ids.quietTo} className={styles.label}>
                  {t('notify.quiet.to')}
                </label>
                <QuietBoundInput
                  id={ids.quietTo}
                  minutes={prefs.quietHours.toMinutes}
                  onCommit={(minutes) => setQuietBound('toMinutes', minutes)}
                />
              </div>
            )}
            <p id={`${ids.quiet}-hint`} className={styles.hint}>
              {t('notify.quiet.hint')}
            </p>
          </div>

          <div className={styles.field}>
            <Switch
              block
              id={ids.preview}
              checked={prefs.preview}
              label={t('notify.preview.label')}
              aria-describedby={`${ids.preview}-hint`}
              onCheckedChange={(next) => write((current) => ({ ...current, preview: next }))}
            />
            <p id={`${ids.preview}-hint`} className={styles.hint}>
              {t('notify.preview.hint')}
            </p>
          </div>

          <div className={styles.field}>
            <Switch
              block
              id={ids.sound}
              checked={prefs.sound}
              label={t('notify.sound.label')}
              aria-describedby={`${ids.sound}-hint`}
              onCheckedChange={(next) => write((current) => ({ ...current, sound: next }))}
            />
            <p id={`${ids.sound}-hint`} className={styles.hint}>
              {t('notify.sound.hint')}
            </p>
          </div>
        </>
      )}

      {/* Always rendered, whatever the switch says: it is a fact about the SERVER, not a setting.
          Since M4.0 there IS a string for "it works" — and it never appears alone. The two lines
          beside it are the limits an owner decision accepted (ADR-017): the banner names no sender
          or subject, the folder list above does not apply to it, and the subscription lapses after a
          week without a visit. A user who reads only the first line would believe something the code
          does not do, which is the failure NFR-PRIV-02 exists to forbid. */}
      {backgroundPush ? (
        <>
          <p className={styles.hint}>{t('notify.background.available', { product })}</p>
          <p className={styles.hint}>{t('notify.background.contentless')}</p>
          <p className={styles.hint}>{t('notify.background.renewal', { product })}</p>
        </>
      ) : (
        <p className={styles.hint}>{t('notify.background.unavailable', { product })}</p>
      )}
    </div>
  )
}

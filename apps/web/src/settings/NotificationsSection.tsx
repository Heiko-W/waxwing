/**
 * Settings → "Notifications" (M3.6, FR-NOTIF-03).
 *
 * Two things it must never do, and the reasons they are worth a comment:
 *
 *  - **It never asks for permission except from the switch's click.** A prompt that did not follow a
 *    user gesture is auto-denied, and that denial sticks to the origin forever — an unsolicited
 *    prompt does not annoy the user, it destroys the feature for them. So the request lives in
 *    `onCheckedChange` and nowhere else.
 *  - **It never claims we can notify while the app is closed.** Servers that sign a browser push do
 *    exist now — Stalwart v0.16.14 ships RFC 9749 — but Waxwing has no client half: no
 *    `PushSubscription/set`, no `push` listener (ADR-010 and its amendment). So the capability probe
 *    decides only WHICH honest sentence is shown: "this server cannot" or "this server can, we do
 *    not yet". Neither says it works. Promising it and silently not delivering is exactly the
 *    failure NFR-PRIV-02 exists to forbid.
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
import { Switch, TextInput } from '../ui'
import { Checkbox } from '../ui/Checkbox'
import styles from './settings.module.css'

export interface NotificationsSectionProps {
  /** Injected in tests — jsdom has no Notification API at all. */
  readonly permission?: NotificationPermissionApi
  /** Injected in tests; defaults to the RFC 9749 probe against the live session. */
  readonly backgroundPush?: boolean
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

  function setQuietBound(bound: 'fromMinutes' | 'toMinutes', value: string): void {
    const minutes = timeValueToMinutes(value)
    if (minutes === null) return // the field can be CLEARED; that is not a new time, so ignore it
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
                <TextInput
                  id={ids.quietFrom}
                  type="time"
                  value={minutesToTimeValue(prefs.quietHours.fromMinutes)}
                  onChange={(event) => setQuietBound('fromMinutes', event.target.value)}
                />
                <label htmlFor={ids.quietTo} className={styles.label}>
                  {t('notify.quiet.to')}
                </label>
                <TextInput
                  id={ids.quietTo}
                  type="time"
                  value={minutesToTimeValue(prefs.quietHours.toMinutes)}
                  onChange={(event) => setQuietBound('toMinutes', event.target.value)}
                />
              </div>
            )}
            <p id={`${ids.quiet}-hint`} className={styles.hint}>
              {t('notify.quiet.hint')}
            </p>
          </div>

          <div className={styles.field}>
            <Switch
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
          Two honest states, and no third: the server cannot, or the server can and WE cannot yet.
          There is deliberately no string for "it works" — see ADR-010's amendment. */}
      <p className={styles.hint}>
        {backgroundPush
          ? t('notify.background.notImplemented', { product })
          : t('notify.background.unavailable', { product })}
      </p>
    </div>
  )
}

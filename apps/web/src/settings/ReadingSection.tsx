/**
 * Settings → Reading (M3.7, FR-RD-02 / FR-RD-07).
 *
 * Two of these three controls close gaps rather than add features. `reading.autoMarkRead` has gated
 * the reader's dwell timer since M1.8 with no way to set it, and the "always load remote content from
 * this sender" list has been APPENDED to since M1.7 with no way to see it, let alone undo it — a
 * privacy decision the user could make but never unmake.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clearRemoteAllowList,
  READING_PREF_KEYS,
  useAutoMarkRead,
  useRemoteAllowList,
  useRemoteContentDefault,
} from '../mail/reading-prefs'
import { setPref, useReplica } from '../sync'
import { Button, Switch, useToast } from '../ui'
import styles from './settings.module.css'

export function ReadingSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { db, accountId } = useReplica()

  const remoteContent = useRemoteContentDefault()
  const allowList = useRemoteAllowList()
  const autoMarkRead = useAutoMarkRead()

  const ids = { remote: useId(), autoMark: useId() }

  return (
    <div className={styles.controls}>
      <div className={styles.field}>
        <Switch
          block
          checked={remoteContent === 'allow'}
          label={t('settings.reading.remote.label')}
          aria-describedby={ids.remote}
          onCheckedChange={(next) => {
            void setPref(db, accountId, READING_PREF_KEYS.remoteContent, next ? 'allow' : 'block')
          }}
        />
        <p id={ids.remote} className={styles.hint}>
          {t('settings.reading.remote.hint')}
        </p>
      </div>

      {allowList.length > 0 && (
        <div className={styles.field}>
          <p className={styles.hint}>
            {t('settings.reading.allowList', { count: allowList.length })}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              void clearRemoteAllowList(db, accountId).then(() =>
                toast({ title: t('settings.reading.cleared') }),
              )
            }}
          >
            {t('settings.reading.clearAllowList')}
          </Button>
        </div>
      )}

      <div className={styles.field}>
        <Switch
          block
          checked={autoMarkRead}
          label={t('settings.reading.autoMarkRead.label')}
          aria-describedby={ids.autoMark}
          onCheckedChange={(next) => {
            void setPref(db, accountId, READING_PREF_KEYS.autoMarkRead, next)
          }}
        />
        <p id={ids.autoMark} className={styles.hint}>
          {t('settings.reading.autoMarkRead.hint')}
        </p>
      </div>
    </div>
  )
}

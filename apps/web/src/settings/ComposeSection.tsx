/**
 * Settings → Compose (M3.7, FR-CMP-08 undo-send, FR-CMP-02 signature placement).
 *
 * The undo-send picker is the one M2.8 explicitly deferred to this milestone: until now the grace
 * period was whatever the hoster's `config.json` said, and a user who found ten seconds of "Undo"
 * either patronising or far too short had no say at all.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  COMPOSE_PREF_KEYS,
  UNDO_SEND_OPTIONS,
  useSignaturePlacement,
  useUndoSendSeconds,
} from '../compose'
import { setPref, useReplica } from '../sync'
import { Select } from '../ui'
import styles from './settings.module.css'

export function ComposeSection() {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const undoSeconds = useUndoSendSeconds()
  const placement = useSignaturePlacement()
  const ids = { undo: useId(), undoHint: useId(), signature: useId(), signatureHint: useId() }

  // Rows, not a card: `Section` wraps whatever a section returns in the one `.controls` there is.
  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.undo}>
          {t('settings.compose.undoSend.label')}
        </label>
        <Select
          id={ids.undo}
          value={String(undoSeconds)}
          aria-describedby={ids.undoHint}
          onChange={(event) => {
            void setPref(
              db,
              accountId,
              COMPOSE_PREF_KEYS.undoSendSeconds,
              Number(event.target.value),
            )
          }}
        >
          {UNDO_SEND_OPTIONS.map((seconds) => (
            <option key={seconds} value={String(seconds)}>
              {seconds === 0
                ? t('settings.compose.undoSend.off')
                : t('settings.compose.undoSend.seconds', { count: seconds })}
            </option>
          ))}
        </Select>
        <p id={ids.undoHint} className={styles.hint}>
          {t('settings.compose.undoSend.hint')}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.signature}>
          {t('settings.compose.signature.label')}
        </label>
        <Select
          id={ids.signature}
          value={placement}
          aria-describedby={ids.signatureHint}
          onChange={(event) => {
            void setPref(db, accountId, COMPOSE_PREF_KEYS.signaturePlacement, event.target.value)
          }}
        >
          <option value="aboveQuote">{t('settings.compose.signature.aboveQuote')}</option>
          <option value="belowQuote">{t('settings.compose.signature.belowQuote')}</option>
        </Select>
        <p id={ids.signatureHint} className={styles.hint}>
          {t('settings.compose.signature.hint')}
        </p>
      </div>
    </>
  )
}

/**
 * Settings → Swipe actions (M3.9, FR-LST-06).
 *
 * Each direction carries exactly one action, so the picker is the whole story: there is no peek and
 * nothing to choose from once the finger is down. A direction set to "Nothing" never arms at all.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { SWIPE_ACTIONS, SWIPE_PREF_KEYS, useSwipeLeft, useSwipeRight } from '../mail/swipe-prefs'
import { setPref, useReplica } from '../sync'
import { Select } from '../ui'
import styles from './settings.module.css'

export function SwipeSection() {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const left = useSwipeLeft()
  const right = useSwipeRight()
  const ids = { left: useId(), leftHint: useId(), right: useId(), rightHint: useId() }

  return (
    <div className={styles.controls}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.left}>
          {t('settings.swipe.left.label')}
        </label>
        <Select
          id={ids.left}
          value={left}
          aria-describedby={ids.leftHint}
          onChange={(event) => {
            void setPref(db, accountId, SWIPE_PREF_KEYS.left, event.target.value)
          }}
        >
          {SWIPE_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`settings.swipe.action.${action}`)}
            </option>
          ))}
        </Select>
        <p id={ids.leftHint} className={styles.hint}>
          {t('settings.swipe.left.hint')}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.right}>
          {t('settings.swipe.right.label')}
        </label>
        <Select
          id={ids.right}
          value={right}
          aria-describedby={ids.rightHint}
          onChange={(event) => {
            void setPref(db, accountId, SWIPE_PREF_KEYS.right, event.target.value)
          }}
        >
          {SWIPE_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`settings.swipe.action.${action}`)}
            </option>
          ))}
        </Select>
        <p id={ids.rightHint} className={styles.hint}>
          {t('settings.swipe.right.hint')}
        </p>
      </div>
    </div>
  )
}

/**
 * The `?` cheat-sheet (M3.8, FR-UI-04) — GENERATED from the registry, so it can never drift from what
 * the keys actually do. A hand-maintained shortcut list is wrong within two work packages; this one is
 * wrong only if `registry.ts` is, and `registry.test.ts` guards that (every chord parses, every title
 * resolves in `en` and `de`, no two actions share a chord in an overlapping scope).
 *
 * LAZY: `default` export, mounted via `lazy(() => import('./ShortcutHelp'))`.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../ui'
import { formatChord, isApplePlatform } from './keys'
import { SHORTCUTS } from './registry'
import styles from './shortcuts.module.css'
import { GROUP_ORDER, type ShortcutAction, type ShortcutContext } from './types'

/** The scope pill: nothing for a global chord, else the (disjoint) scopes it is limited to. */
function scopeLabel(action: ShortcutAction, t: (key: string) => string): string | null {
  if (action.scopes.includes('global')) return null
  return action.scopes.map((scope) => t(`shortcuts.scopes.${scope}`)).join(' · ')
}

/**
 * A chord the ACCOUNT cannot run is DIMMED and explained — never removed (G2/B3). Hiding is the wrong
 * verb for a reference surface: the user who pressed `e` and got nothing opens this sheet precisely to
 * find out why, and an absent row answers "that key does not exist", which is a different falsehood —
 * the key exists, the mailbox does not. The ⌘K palette is a different kind of surface ("what can I do
 * right now"), so the hide it already does is correct there and unchanged.
 */
export default function ShortcutHelp({
  context,
  onClose,
}: {
  readonly context: ShortcutContext
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const apple = useMemo(() => isApplePlatform(), [])

  return (
    <Dialog open onClose={onClose} title={t('shortcuts.title')} size="lg">
      <div className={styles.help}>
        {GROUP_ORDER.map((group) => {
          const actions = SHORTCUTS.filter((action) => action.group === group)
          if (actions.length === 0) return null
          return (
            <section key={group} className={styles.helpGroup}>
              <h3 className={styles.helpGroupTitle}>{t(`shortcuts.groups.${group}`)}</h3>
              <dl className={styles.helpList}>
                {actions.map((action) => {
                  const scope = scopeLabel(action, t)
                  const reason = action.unavailable?.(context) ?? null
                  return (
                    <div
                      key={action.id}
                      className={`${styles.helpRow}${reason === null ? '' : ` ${styles.helpRowUnavailable}`}`}
                    >
                      <dt className={styles.helpTerm}>
                        {t(action.titleKey)}
                        {scope !== null && <span className={styles.scopePill}>{scope}</span>}
                        {/* The reason is TEXT, not merely a shade: dimming alone reaches neither a
                            screen reader nor anyone who cannot resolve the contrast step. */}
                        {reason !== null && <span className={styles.helpReason}>{t(reason)}</span>}
                      </dt>
                      <dd className={styles.helpKeys}>
                        {action.keys.map((chord, chordIndex) => (
                          <span key={chord} className={styles.chord}>
                            {chordIndex > 0 && (
                              <span className={styles.chordOr}>{t('shortcuts.or')}</span>
                            )}
                            {formatChord(chord, apple, t('shortcuts.modKey')).map((part) => (
                              <kbd key={part} className={styles.kbd}>
                                {part}
                              </kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          )
        })}
        <p className={styles.helpNote}>{t('shortcuts.targetNote')}</p>
        <p className={styles.helpNote}>{t('shortcuts.editorNote')}</p>
      </div>
    </Dialog>
  )
}

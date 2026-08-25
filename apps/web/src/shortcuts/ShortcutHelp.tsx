/**
 * The `?` cheat-sheet (M3.8, FR-UI-04) — GENERATED from the registry, so it can never drift from what
 * the keys actually do. A hand-maintained shortcut list is wrong within two work packages; this one is
 * wrong only if `registry.ts` is, and `registry.test.ts` guards that (every chord parses, every title
 * resolves in `en` and `de`, no two actions share a chord in an overlapping scope).
 *
 * One section is NOT from the registry, and says so: the message grid's own keys (B21). Arrows,
 * Home/End, Space, Enter, Escape and ⌘A are handled by `MessageList`'s `onKeyDown` because they are
 * the APG `grid` pattern's keys and belong to the focused widget, not to an app-wide chord table.
 * Generating the sheet from the registry ALONE therefore documented every key except the ones a
 * reader uses most — select-all in particular had no keyboard route named anywhere in the app.
 * `LIST_KEYS` is that table, and `list-keys.test.ts` pins it against the handler it describes.
 *
 * LAZY: `default` export, mounted via `lazy(() => import('./ShortcutHelp'))`.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { KEY_CAP_KEYS, LIST_KEYS } from '../mail/list-keys'
import { Dialog, SectionLabel } from '../ui'
import { formatChord, isApplePlatform } from './keys'
import { SHORTCUTS } from './registry'
import styles from './shortcuts.module.css'
import { GROUP_ORDER, type ShortcutAction, type ShortcutContext } from './types'

/**
 * Display caps for a grid key (B21) — `['⇧', '↓']`, `['⌘', 'A']`, `['Leertaste']`.
 *
 * Separate from {@link formatChord} because the inputs are different in kind: that one renders a
 * `keys.ts` CHORD, which the dispatcher also matches events against, while these are key CAPS for a
 * switch statement that does its own matching. Sharing one function would mean teaching the chord
 * grammar a `Shift+` prefix it has no matcher for, and a grammar with an unmatchable production is
 * how a chord table starts lying.
 */
function keyCaps(chord: string, apple: boolean, t: (key: string) => string): string[] {
  const caps: string[] = []
  let rest = chord
  if (rest.startsWith('Mod+')) {
    caps.push(apple ? '⌘' : t('shortcuts.modKey'))
    rest = rest.slice('Mod+'.length)
  }
  if (rest.startsWith('Shift+')) {
    caps.push('⇧')
    rest = rest.slice('Shift+'.length)
  }
  const cap = KEY_CAP_KEYS[rest]
  caps.push(cap !== undefined ? t(cap) : rest.length === 1 ? rest.toUpperCase() : rest)
  return caps
}

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
              <SectionLabel>{t(`shortcuts.groups.${group}`)}</SectionLabel>
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
                        {t(action.titleKeyFor?.(context) ?? action.titleKey)}
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
        <section className={styles.helpGroup}>
          <SectionLabel>{t('shortcuts.groups.list')}</SectionLabel>
          <dl className={styles.helpList}>
            {LIST_KEYS.map((row) => (
              <div key={row.titleKey} className={styles.helpRow}>
                <dt className={styles.helpTerm}>
                  {t(row.titleKey)}
                  <span className={styles.scopePill}>{t('shortcuts.scopes.list')}</span>
                </dt>
                <dd className={styles.helpKeys}>
                  {row.keys.map((chord, chordIndex) => (
                    <span key={chord} className={styles.chord}>
                      {chordIndex > 0 && (
                        <span className={styles.chordOr}>{t('shortcuts.or')}</span>
                      )}
                      {keyCaps(chord, apple, t).map((part, partIndex) => (
                        // The caps of ONE chord are positional, and two of them can repeat (⇧ + ⇧
                        // never, but a localised cap could equal a glyph). Index keys are correct
                        // here: this list is static and never reordered.
                        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
                        <kbd key={partIndex} className={styles.kbd}>
                          {part}
                        </kbd>
                      ))}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <p className={styles.helpNote}>{t('shortcuts.targetNote')}</p>
        <p className={styles.helpNote}>{t('shortcuts.editorNote')}</p>
      </div>
    </Dialog>
  )
}

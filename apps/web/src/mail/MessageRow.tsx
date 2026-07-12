/**
 * A single message-list row (M1.6, FR-LST-03) — pure presentational. `undefined` email → a
 * Skeleton row (the not-yet-hydrated window slice; the list's one live region announces loading, not
 * each row). Loaded → a selectable `role="row"` with the sender avatar/name, subject, server
 * preview, a compact localized time, and unread/flag/attachment/answered indicators (each with a
 * screen-reader label). It is NOT individually focusable — the `role="grid"` container holds focus
 * and moves an `aria-activedescendant` to this row's stable `id`; the row's `aria-rowindex` is its
 * ABSOLUTE 1-based position so a screen reader reports it correctly under virtualization.
 */

import { Paperclip, Reply, Star } from 'lucide-react'
import type { CSSProperties, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { EmailRow } from '../sync'
import { Avatar, Checkbox, Skeleton, VisuallyHidden } from '../ui'
import { formatMessageTime } from './format-message-time'
import { LabelSwatch } from './labels/LabelSwatch'
import { isCustomKeyword, type LabelColor } from './labels/label-model'
import labelStyles from './labels/labels.module.css'
import styles from './message-list.module.css'

export type Density = 'comfortable' | 'compact'

/** The registry name+color a row needs to render one label swatch (keyed by keyword upstream). */
export interface RowLabel {
  readonly name: string
  readonly color: LabelColor
}

/** Max swatches shown before collapsing to "+N", tuned per density. */
const MAX_SWATCHES: Record<Density, number> = { comfortable: 3, compact: 2 }

export interface MessageRowProps {
  /** Stable DOM id — the grid points `aria-activedescendant` here when this row is the roving one. */
  readonly id: string
  /** Absolute 1-based position in the full window (for `aria-rowindex` under virtualization). */
  readonly rowIndex: number
  readonly email: EmailRow | undefined
  readonly selected: boolean
  readonly active: boolean
  readonly density: Density
  readonly style?: CSSProperties
  /** Registry name+color per keyword, so this row can render its label swatches (M3.2). */
  readonly labels?: ReadonlyMap<string, RowLabel> | undefined
  /** Sanitized `<mark>` highlights for a search result (M3.1); plain text is used when absent. */
  readonly highlight?: { readonly subject: string; readonly preview: string } | undefined
  readonly onOpen: () => void
  readonly onSelectToggle: () => void
  readonly onSelectRange: () => void
  /** Make this row the roving one (on pointer interaction) so keyboard continues from here. */
  readonly onActivate: () => void
}

function senderName(email: EmailRow, fallback: string): string {
  const first = email.from?.[0]
  return first?.name || first?.email || fallback
}

export function MessageRow({
  id,
  rowIndex,
  email,
  selected,
  active,
  density,
  style,
  labels,
  highlight,
  onOpen,
  onSelectToggle,
  onSelectRange,
  onActivate,
}: MessageRowProps) {
  const { t } = useTranslation()
  const rowClass = `${styles.row} ${density === 'compact' ? styles.compact : styles.comfortable}`

  if (email === undefined) {
    return (
      <div
        id={id}
        role="row"
        aria-rowindex={rowIndex}
        aria-selected="false"
        tabIndex={-1}
        className={`${rowClass} ${styles.skeletonRow}`}
        style={style}
      >
        <div role="gridcell" aria-hidden="true" className={styles.selectCell}>
          <Skeleton circle width={20} height={20} />
        </div>
        <div role="gridcell" aria-hidden="true" className={styles.avatarCell}>
          <Skeleton circle width={32} height={32} />
        </div>
        <div role="gridcell" aria-hidden="true" className={styles.mainCell}>
          <Skeleton width="40%" height={12} />
          <Skeleton width="70%" height={12} />
        </div>
      </div>
    )
  }

  const unread = email.keywords.$seen !== true
  const flagged = email.keywords.$flagged === true
  const answered = email.keywords.$answered === true
  const name = senderName(email, t('list.noSender'))

  // Label swatches for this row's custom keywords (color resolved from the registry, gray when the
  // keyword is discovered-but-unregistered), capped per density with an accessible "+N" overflow.
  const customKeywords = Object.keys(email.keywords).filter(isCustomKeyword)
  const shownLabels = customKeywords.slice(0, MAX_SWATCHES[density]).map((keyword) => ({
    keyword,
    ...(labels?.get(keyword) ?? { name: keyword, color: 'gray' as LabelColor }),
  }))
  const overflowLabels = customKeywords.length - shownLabels.length

  function onRowClick(event: MouseEvent): void {
    onActivate()
    if (event.metaKey || event.ctrlKey) onSelectToggle()
    else if (event.shiftKey) onSelectRange()
    else onOpen()
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the role="grid" container (APG grid delegation).
    <div
      id={id}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      aria-current={active ? 'page' : undefined}
      tabIndex={-1}
      className={`${rowClass}${unread ? ` ${styles.unread}` : ''}${selected ? ` ${styles.selected}` : ''}`}
      style={style}
      onClick={onRowClick}
    >
      <div role="gridcell" className={styles.selectCell}>
        <Checkbox
          aria-label={t('list.select')}
          checked={selected}
          onChange={onSelectToggle}
          // Stop the click bubbling to the row so selecting does not also open the message.
          onClick={(event) => event.stopPropagation()}
          tabIndex={-1}
        />
      </div>
      <div role="gridcell" className={styles.avatarCell}>
        {unread && (
          <span className={styles.unreadDot}>
            <VisuallyHidden>{t('list.unread')}</VisuallyHidden>
          </span>
        )}
        <Avatar name={name} size="sm" />
      </div>
      <div role="gridcell" className={styles.mainCell}>
        <div className={styles.rowTop}>
          <span className={styles.sender}>{name}</span>
          <span className={styles.meta}>
            {shownLabels.length > 0 && (
              <span
                className={labelStyles.rowSwatches}
                role="group"
                aria-label={t('labels.rowLabels')}
              >
                {shownLabels.map((label) => (
                  <span key={label.keyword}>
                    <LabelSwatch color={label.color} size="sm" />
                    <VisuallyHidden>{label.name}</VisuallyHidden>
                  </span>
                ))}
                {overflowLabels > 0 && (
                  <span className={labelStyles.more}>
                    <span aria-hidden="true">+{overflowLabels}</span>
                    <VisuallyHidden>
                      {t('labels.moreLabels', { count: overflowLabels })}
                    </VisuallyHidden>
                  </span>
                )}
              </span>
            )}
            {answered && (
              <>
                <Reply aria-hidden="true" className={styles.icon} />
                <VisuallyHidden>{t('list.answered')}</VisuallyHidden>
              </>
            )}
            {flagged && (
              <>
                <Star aria-hidden="true" className={`${styles.icon} ${styles.flag}`} />
                <VisuallyHidden>{t('list.flagged')}</VisuallyHidden>
              </>
            )}
            {email.hasAttachment && (
              <>
                <Paperclip aria-hidden="true" className={styles.icon} />
                <VisuallyHidden>{t('list.attachment')}</VisuallyHidden>
              </>
            )}
            <time dateTime={email.receivedAt} className={styles.time}>
              {formatMessageTime(email.receivedAt)}
            </time>
          </span>
        </div>
        {highlight?.subject ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizeSnippet permits only bare <mark> (M3.1)
          <div className={styles.subject} dangerouslySetInnerHTML={{ __html: highlight.subject }} />
        ) : (
          <div className={styles.subject}>{email.subject || t('list.noSubject')}</div>
        )}
        {highlight?.preview ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizeSnippet permits only bare <mark> (M3.1)
          <div className={styles.preview} dangerouslySetInnerHTML={{ __html: highlight.preview }} />
        ) : (
          <div className={styles.preview}>{email.preview}</div>
        )}
      </div>
    </div>
  )
}

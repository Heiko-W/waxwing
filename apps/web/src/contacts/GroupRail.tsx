/**
 * The rail's groups section (M4.2, stage 6a) — below the address-book list, mirroring Apple Contacts,
 * which shows groups in the sidebar. Unlike the book list (route {@link Link}s), a group is a LOCAL
 * selection: picking one filters the list pane to that group's members without a route change, so the
 * selected group is component state the screen owns. The New-group affordance is rights-gated by the
 * caller (`onNew` omitted when no writable book exists).
 */

import type { Id } from '@waxwing/jmap'
import { Plus, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ContactCardRow } from '../sync'
import { IconButton, Spinner } from '../ui'
import { contactDisplayName } from './contact-fields'
import styles from './contacts.module.css'

export interface GroupRailProps {
  /** The account's groups for the current book, or `undefined` while loading. */
  readonly groups: readonly ContactCardRow[] | undefined
  readonly selectedGroupId: Id | null
  readonly onSelect: (groupId: Id) => void
  /** Open the create-group form. Omitted when no writable book exists (New disabled). */
  readonly onNew?: () => void
}

export function GroupRail({ groups, selectedGroupId, onSelect, onNew }: GroupRailProps) {
  const { t } = useTranslation()

  return (
    <div className={styles.books}>
      <div className={styles.railHeader}>
        <h2 className={styles.railTitle}>{t('contacts.groups.title')}</h2>
        <IconButton
          label={t('contacts.groups.new')}
          variant="ghost"
          size="sm"
          disabled={onNew === undefined}
          onClick={() => onNew?.()}
        >
          <Plus />
        </IconButton>
      </div>
      {groups === undefined ? (
        <div className={styles.railLoading}>
          <Spinner size="sm" label={t('contacts.groups.loading')} />
        </div>
      ) : groups.length === 0 ? (
        <p className={styles.railEmpty}>{t('contacts.groups.empty')}</p>
      ) : (
        <ul className={styles.bookList}>
          {groups.map((group) => {
            const name = contactDisplayName(group) || t('contacts.noName')
            const selected = group.id === selectedGroupId
            return (
              <li key={group.id}>
                <button
                  type="button"
                  className={styles.bookItem}
                  onClick={() => onSelect(group.id)}
                  {...(selected ? { 'aria-current': 'page' as const } : {})}
                >
                  <UsersRound aria-hidden="true" className={styles.bookIcon} />
                  <span className={styles.bookName}>{name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

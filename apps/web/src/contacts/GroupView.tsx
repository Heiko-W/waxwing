/**
 * Group member view (M4.2, stage 6a) — what the list pane shows when a group is selected in the rail.
 * A header with the group's name, its member count and the rights-gated Edit / Delete affordances,
 * over a list of the group's members. Membership is resolved LOCALLY from the replica (a group's
 * `members` set holds member `uid`s), so the view is offline-complete and needs no extra query.
 *
 * Each member is a {@link Link} to that contact's detail route, exactly like {@link ./ContactList} —
 * opening a member keeps the group selected (the list still shows the group) while the detail pane
 * follows the route. Delete raises an in-place confirmation; the enqueue lives in the parent.
 */

import type { Id } from '@waxwing/jmap'
import { ChevronLeft, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactsPath, Link } from '../app/route'
import type { ContactCardRow } from '../sync'
import { Avatar, Button, Dialog, IconButton } from '../ui'
import { contactDisplayName } from './contact-fields'
import { groupName } from './contact-group-mapping'
import styles from './contacts.module.css'

export interface GroupViewProps {
  readonly group: ContactCardRow
  /** The group's resolved member cards, in display order. */
  readonly members: readonly ContactCardRow[]
  /** The book context for member links (`undefined` = the "All Contacts" view). */
  readonly bookId: Id | undefined
  /** The card the route currently opens, if any (highlighted in the member list). */
  readonly selectedCardId: Id | undefined
  /** True when the group sits in at least one writable book; gates Edit and Delete. */
  readonly canWrite: boolean
  readonly onEdit?: () => void
  readonly onDelete?: () => void
  /** Deselect the group and return to the book's full contact list. */
  readonly onClose: () => void
}

export function GroupView({
  group,
  members,
  bookId,
  selectedCardId,
  canWrite,
  onEdit,
  onDelete,
  onClose,
}: GroupViewProps) {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const name = groupName(group) || t('contacts.noName')

  return (
    <div className={styles.contactListPane}>
      <div className={styles.paneToolbar}>
        <Button variant="ghost" onClick={onClose}>
          <ChevronLeft aria-hidden="true" />
          {t('contacts.groups.backToContacts')}
        </Button>
        <span className={styles.toolbarSpacer} />
        {/* Icon-only, because this toolbar lives in the list column — 340px by default and 260px at
            its narrowest. Three labelled buttons did not fit: "Gruppe löschen" ran off the edge of
            the column. The way BACK keeps its words (it is the one thing a reader has to find in a
            hurry); the two actions on the group keep their names as accessible labels. */}
        {onEdit && (
          <IconButton
            label={t('contacts.groups.edit')}
            variant="ghost"
            disabled={!canWrite}
            onClick={onEdit}
          >
            <Pencil />
          </IconButton>
        )}
        {onDelete && (
          <IconButton
            label={t('contacts.groups.delete')}
            variant="ghost"
            disabled={!canWrite}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 />
          </IconButton>
        )}
      </div>

      <div className={styles.groupViewHead}>
        <h2 className={styles.groupViewTitle}>{name}</h2>
        <p className={styles.groupViewCount}>
          {t('contacts.groups.membersCount', { count: members.length })}
        </p>
      </div>

      {members.length === 0 ? (
        <p className={styles.listEmpty}>{t('contacts.groups.noMembers')}</p>
      ) : (
        <ul className={styles.groupMemberList} aria-label={t('contacts.groups.membersLabel')}>
          {members.map((member) => {
            const memberName = contactDisplayName(member) || t('contacts.noName')
            const selected = member.id === selectedCardId
            return (
              <li key={member.id}>
                <Link
                  to={contactsPath(bookId, member.id)}
                  className={`${styles.groupMemberLink}${selected ? ` ${styles.groupMemberLinkSelected}` : ''}`}
                  {...(selected ? { 'aria-current': 'page' as const } : {})}
                >
                  <span aria-hidden="true">
                    <Avatar name={memberName} size="sm" />
                  </span>
                  <span className={styles.groupMemberName}>{memberName}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {onDelete && (
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={t('contacts.groups.deleteTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                {t('contacts.delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false)
                  onDelete()
                }}
              >
                {t('contacts.delete.confirm')}
              </Button>
            </>
          }
        >
          <p>{t('contacts.groups.deleteBody', { name })}</p>
        </Dialog>
      )}
    </div>
  )
}

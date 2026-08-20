/**
 * The address-book rail (M4.2) — the contacts analogue of the folder tree. Lists every address book
 * for the account ({@link useAddressBooks}), preceded by an "All Contacts" entry, and marks the one
 * the route selects with `aria-current`. Entries are real {@link Link}s (base-path-safe,
 * open-in-new-tab friendly), exactly like the primary nav and the folder tree.
 *
 * RIGHTS-AWARE now, though create/edit land in a later stage: a book the user cannot write to
 * (`myRights.mayWrite === false`) carries a discreet read-only marker, and a shared / default book is
 * labelled too — the information the write affordances will key off belongs on screen from the read
 * path so the list never silently changes shape when those buttons arrive.
 */

import { BookOpen, Lock, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { contactsPath, Link } from '../app/route'
import type { AddressBookRow } from '../sync'
import { useAddressBooks } from '../sync'
import { Badge, Spinner } from '../ui'
import styles from './contacts.module.css'

export interface AddressBookListProps {
  /** The address book the route currently selects (`undefined` = the "All Contacts" view). */
  readonly selectedBookId: string | undefined
  /**
   * Fired when the user picks a book (or "All Contacts"). The screen uses it to drop any local group
   * selection, since choosing a book means leaving the group's member view — a book is a route change,
   * a group is not, so the two selections cannot both be the route.
   */
  readonly onSelectBook?: () => void
}

export function AddressBookList({ selectedBookId, onSelectBook }: AddressBookListProps) {
  const { t } = useTranslation()
  const books = useAddressBooks()

  return (
    <div className={styles.books}>
      <h2 className={styles.railTitle}>{t('contacts.books.title')}</h2>
      <ul className={styles.bookList}>
        <li>
          <Link
            to={contactsPath()}
            className={styles.bookItem}
            {...(onSelectBook ? { onClick: onSelectBook } : {})}
            {...(selectedBookId === undefined ? { 'aria-current': 'page' as const } : {})}
          >
            <UsersRound aria-hidden="true" className={styles.bookIcon} />
            <span className={styles.bookName}>{t('contacts.books.all')}</span>
          </Link>
        </li>
        {books === undefined ? (
          <li className={styles.railLoading}>
            <Spinner size="sm" label={t('contacts.books.loading')} />
          </li>
        ) : books.length === 0 ? (
          <li className={styles.railEmpty}>{t('contacts.books.empty')}</li>
        ) : (
          books.map((book) => (
            <AddressBookItem
              key={book.id}
              book={book}
              selected={book.id === selectedBookId}
              {...(onSelectBook ? { onSelect: onSelectBook } : {})}
            />
          ))
        )}
      </ul>
    </div>
  )
}

function isShared(book: AddressBookRow): boolean {
  const shareWith = book.shareWith
  return shareWith != null && Object.keys(shareWith).length > 0
}

function AddressBookItem({
  book,
  selected,
  onSelect,
}: {
  book: AddressBookRow
  selected: boolean
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  const readOnly = book.myRights.mayWrite === false
  return (
    <li>
      <Link
        to={contactsPath(book.id)}
        className={styles.bookItem}
        {...(onSelect ? { onClick: onSelect } : {})}
        {...(selected ? { 'aria-current': 'page' as const } : {})}
      >
        <BookOpen aria-hidden="true" className={styles.bookIcon} />
        {/* Name on its own line, markers under it. Side by side, the markers took the width the
            name needed: in a 215px rail "Stalwart Address Book" rendered as "Stalwart Addr…"
            because a "Default" badge sat beside it — the same defect the folder rail had, where
            the folder you were IN was the only one whose name got cut. A book's name is the thing
            being chosen; a badge describes it and can wait for the second line. */}
        <span className={styles.bookText}>
          <span className={styles.bookName}>{book.name}</span>
          {(book.isDefault || isShared(book) || readOnly) && (
            <span className={styles.bookMarkers}>
              {book.isDefault && <Badge tone="neutral">{t('contacts.books.default')}</Badge>}
              {isShared(book) && <Badge tone="neutral">{t('contacts.books.shared')}</Badge>}
              {readOnly && (
                <span className={styles.readOnly}>
                  <Lock aria-hidden="true" className={styles.readOnlyIcon} />
                  <span>{t('contacts.books.readOnly')}</span>
                </span>
              )}
            </span>
          )}
        </span>
      </Link>
    </li>
  )
}

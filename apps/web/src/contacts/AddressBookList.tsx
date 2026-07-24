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

import { BookOpen, Lock, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { contactsPath, Link } from '../app/route'
import type { AddressBookRow } from '../sync'
import { useAddressBooks } from '../sync'
import { Badge, Spinner } from '../ui'
import styles from './contacts.module.css'

export interface AddressBookListProps {
  /** The address book the route currently selects (`undefined` = the "All Contacts" view). */
  readonly selectedBookId: string | undefined
}

export function AddressBookList({ selectedBookId }: AddressBookListProps) {
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
            {...(selectedBookId === undefined ? { 'aria-current': 'page' as const } : {})}
          >
            <Users aria-hidden="true" className={styles.bookIcon} />
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
            <AddressBookItem key={book.id} book={book} selected={book.id === selectedBookId} />
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

function AddressBookItem({ book, selected }: { book: AddressBookRow; selected: boolean }) {
  const { t } = useTranslation()
  const readOnly = book.myRights.mayWrite === false
  return (
    <li>
      <Link
        to={contactsPath(book.id)}
        className={styles.bookItem}
        {...(selected ? { 'aria-current': 'page' as const } : {})}
      >
        <BookOpen aria-hidden="true" className={styles.bookIcon} />
        <span className={styles.bookName}>{book.name}</span>
        {book.isDefault && <Badge tone="neutral">{t('contacts.books.default')}</Badge>}
        {isShared(book) && <Badge tone="neutral">{t('contacts.books.shared')}</Badge>}
        {readOnly && (
          <span className={styles.readOnly}>
            <Lock aria-hidden="true" className={styles.readOnlyIcon} />
            <span>{t('contacts.books.readOnly')}</span>
          </span>
        )}
      </Link>
    </li>
  )
}

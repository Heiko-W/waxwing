/**
 * The address-book rail (M4.2) — the contacts analogue of the folder tree. Lists every address book
 * for the account ({@link useAddressBooks}), preceded by an "All Contacts" entry, and marks the one
 * the route selects with `aria-current`. Entries are real {@link Link}s (base-path-safe,
 * open-in-new-tab friendly), exactly like the primary nav and the folder tree.
 *
 * **Management (JMAP gap analysis, B-5).** Creating a book had been implemented, tested and exported
 * since M4.2 stage 5a with no caller anywhere in the UI, and renaming/removing did not exist at all —
 * so this list was read-only in practice and its own header comment said "create/edit land in a later
 * stage". They land here: a create affordance beside the heading and a per-book action menu, both
 * dispatching through {@link useAddressBookActions} (the outbox, not the network).
 *
 * The shape is the one macOS Contacts uses for its sidebar lists — a quiet "+" on the section header,
 * and the per-row actions kept out of the way until the row is pointed at or focused (always visible
 * under a coarse pointer, where there is no hover to reveal them with).
 *
 * RIGHTS-AWARE: a book the user cannot write to (`myRights.mayWrite === false`) carries a discreet
 * read-only marker and offers no rename; one that cannot be deleted (`mayDelete === false`, or the
 * account's default book, which the server will not destroy) offers no delete.
 */

import type { Id } from '@waxwing/jmap'
import { BookOpen, Ellipsis, Lock, Plus, UserPlus, UsersRound } from 'lucide-react'
import { type FormEvent, lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ACCOUNT_PARAM, contactsPath, Link, useRoute } from '../app/route'
import { delegatedAccountsFor } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import type { DelegatedAccount } from '../app/session/types'
import { makeAddressBookSharingClient } from '../sharing/addressbook-client'
import { mayShareAddressBook } from '../sharing/addressbook-roles'
import { IncomingShares } from '../sharing/IncomingShares'
import { currentUserPrincipalId } from '../sharing/principals'
import { useIncomingShares } from '../sharing/use-incoming-shares'
import type { AddressBookRow } from '../sync'
import { useAddressBooks, useAddressBooksFor } from '../sync'
import {
  Badge,
  Button,
  Dialog,
  IconButton,
  Menu,
  type MenuItemSpec,
  Spinner,
  TextInput,
} from '../ui'
import styles from './contacts.module.css'
import { useAddressBookActions } from './use-address-book-actions'

/*
 * The share dialog is a chunk of its own (registered in `.size-limit.js`): it pulls in the generic
 * `ShareDialog` and the principal picker, and the great majority of sessions never open it.
 */
const AddressBookShareDialog = lazy(() => import('../sharing/AddressBookShareDialog'))

/**
 * A defensive cap on the name a book may be given. JMAP publishes no `maxSizeAddressBookName`
 * capability (unlike `maxSizeMailboxName`), so this is the same round number the folder dialog uses
 * rather than a negotiated limit — it exists to stop a paste of a whole document, not to second-guess
 * the server, which is still free to reject a shorter one.
 */
const MAX_NAME_LENGTH = 255

type BookDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly book: AddressBookRow }
  | { readonly kind: 'delete'; readonly book: AddressBookRow }
  | { readonly kind: 'share'; readonly book: AddressBookRow }

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
  const actions = useAddressBookActions()
  const connected = useSessionOptional()
  const route = useRoute()
  const [dialog, setDialog] = useState<BookDialog | null>(null)
  /*
   * The share seam (S-2). Online-only and outside the replica by design — see
   * `sharing/addressbook-client.ts`: the engine's `AddressBook/get` names no `properties`, so no row
   * here has been proved to carry a `shareWith` at all.
   *
   * Memoized because the dialog holds it across an async load and in a `useEffect` dependency list.
   */
  const sharingClient = useMemo(
    () =>
      connected === null
        ? null
        : makeAddressBookSharingClient(
            connected.client,
            connected.accountId,
            currentUserPrincipalId(connected.jmapSession, connected.accountId),
          ),
    [connected],
  )
  /*
   * Incoming address-book shares (S-1, extended to this type by S-2).
   *
   * The card announces the share and offers Hide — see `IncomingShares` on why a button that led
   * nowhere would be worse. Opening the shared content happens in the rail: the delegated account it
   * arrived for gets its own section below (S-4).
   */
  const incoming = useIncomingShares('AddressBook')

  const takenNames = (except?: Id): string[] =>
    (books ?? []).filter((book) => book.id !== except).map((book) => book.name)

  /*
   * The accounts whose `contacts` area the server actually serves (S-4). With none, this rail is
   * byte-for-byte the pre-S-4 one — no grouping, no extra landmark, and the tests stand unchanged.
   */
  const ownAccountId = connected?.accountId ?? null
  const sharedAccounts = useMemo(
    () => (connected === null ? [] : delegatedAccountsFor(connected, 'contacts')),
    [connected],
  )
  const grouped = ownAccountId !== null && sharedAccounts.length > 0
  /*
   * The account the CONTACTS SCREEN is acting in, from `?account=` on the route (S-4, B37's vetting:
   * only a granted account may be named, anything else falls back to the user's own).
   */
  const actingAccountId = useMemo(() => {
    if (ownAccountId === null) return null
    const fromRoute = route.search.get(ACCOUNT_PARAM)
    return fromRoute !== null && sharedAccounts.some((account) => account.id === fromRoute)
      ? fromRoute
      : ownAccountId
  }, [ownAccountId, route.search, sharedAccounts])
  /*
   * Own-book management is offered only while acting in the OWN account. The action hooks bind to the
   * ACTING account's replica context, so a rename/share/delete dispatched from the own section while
   * visiting a delegated account would write against the wrong account — the ADR-018 id collision,
   * in its contacts form. While visiting, the own rows are plain links back to the own account.
   */
  const canManageOwn = !grouped || actingAccountId === ownAccountId

  const booksRegion =
    grouped && ownAccountId !== null ? (
      <GroupedBookList
        ownAccountId={ownAccountId}
        sharedAccounts={sharedAccounts}
        actingAccountId={actingAccountId}
        canManageOwn={canManageOwn}
        selectedBookId={selectedBookId}
        onRename={(book) => setDialog({ kind: 'rename', book })}
        onDelete={(book) => setDialog({ kind: 'delete', book })}
        {...(sharingClient === null
          ? {}
          : { onShare: (book) => setDialog({ kind: 'share', book }) })}
        {...(onSelectBook !== undefined ? { onSelectBook } : {})}
      />
    ) : (
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
              onRename={() => setDialog({ kind: 'rename', book })}
              onDelete={() => setDialog({ kind: 'delete', book })}
              {...(sharingClient === null
                ? {}
                : { onShare: () => setDialog({ kind: 'share', book }) })}
              {...(onSelectBook ? { onSelect: onSelectBook } : {})}
            />
          ))
        )}
      </ul>
    )

  return (
    <div className={styles.books}>
      <div className={styles.railHeader}>
        <h2 className={styles.railTitle}>{t('contacts.books.title')}</h2>
        {/* While visiting a delegated account the rail's create button would dispatch against the
            ACTING account's engine — hide it rather than write to the wrong account (S-4). */}
        {canManageOwn && (
          <IconButton
            label={t('contacts.books.new')}
            variant="ghost"
            size="sm"
            // Until the books query resolves there is no name list to check a new name against.
            disabled={books === undefined}
            onClick={() => setDialog({ kind: 'create' })}
          >
            <Plus />
          </IconButton>
        )}
      </div>
      {booksRegion}

      {/* LAST in the rail (B61): a share card arrives on a sync pass, and above the list it moved
          every row out from under the pointer mid-click. Below it, nothing is pushed. */}
      <IncomingShares announcements={incoming.announcements} onDismiss={incoming.dismiss} />

      {dialog?.kind === 'create' && (
        <NameDialog
          title={t('contacts.books.create.title')}
          submitLabel={t('contacts.books.create.submit')}
          initialName=""
          taken={takenNames()}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            /*
             * Created, not opened. `actions.create` resolves with the CREATION id, and the ack
             * re-files the row under the id the server chose — so navigating there would point the
             * route at an id that stops existing a moment later. That is exactly the defect
             * `ContactsScreen`'s `pendingCreate` exists to repair for cards, and a book has no `uid`
             * to follow it by. The new book appears in the rail; opening it is one click.
             */
            void actions.create(name)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t('contacts.books.rename.title')}
          submitLabel={t('contacts.books.rename.submit')}
          initialName={dialog.book.name}
          taken={takenNames(dialog.book.id)}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            actions.rename(dialog.book.id, name)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'delete' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title={t('contacts.books.delete.title')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t('contacts.books.delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  actions.remove(dialog.book.id)
                  setDialog(null)
                }}
              >
                {t('contacts.books.delete.confirm')}
              </Button>
            </>
          }
        >
          {/* Said before the fact, because the destroy carries `onDestroyRemoveContents`: a book
              holding a single card cannot be destroyed without it, so "delete this list" would
              otherwise fail for the only reason anyone keeps one. */}
          <p>{t('contacts.books.delete.body', { name: dialog.book.name })}</p>
          <p>{t('contacts.books.delete.contents')}</p>
        </Dialog>
      )}

      {dialog?.kind === 'share' && sharingClient !== null && (
        <Suspense fallback={null}>
          <AddressBookShareDialog
            bookId={dialog.book.id}
            name={dialog.book.name}
            client={sharingClient}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
    </div>
  )
}

/**
 * The grouped rail (S-4): an "All Contacts" entry scoped to the ACTING account, then the own account's
 * books, then one labelled section per delegated account whose `contacts` area the server serves — the
 * Apple-Mail/iCloud pattern `AccountTrees` already applies to the folder rail. Selecting a delegated
 * book opens it in ITS account (the link carries `?account=`); the pane follows via the acting-account
 * scope in `ContactsScreen`.
 */
function GroupedBookList({
  ownAccountId,
  sharedAccounts,
  actingAccountId,
  canManageOwn,
  selectedBookId,
  onRename,
  onDelete,
  onShare,
  onSelectBook,
}: {
  readonly ownAccountId: Id
  readonly sharedAccounts: readonly DelegatedAccount[]
  readonly actingAccountId: Id | null
  readonly canManageOwn: boolean
  readonly selectedBookId: string | undefined
  readonly onRename: (book: AddressBookRow) => void
  readonly onDelete: (book: AddressBookRow) => void
  readonly onShare?: (book: AddressBookRow) => void
  readonly onSelectBook?: () => void
}) {
  const { t } = useTranslation()
  // "All Contacts" is the acting account's bookless scope, so its link names that account when the
  // screen is visiting a delegated one — an unqualified link would snap back to the reader's own.
  const allContactsAccountId =
    actingAccountId !== null && actingAccountId !== ownAccountId ? actingAccountId : undefined

  return (
    <>
      <ul className={styles.bookList}>
        <li>
          <Link
            to={contactsPath(undefined, undefined, allContactsAccountId)}
            className={styles.bookItem}
            {...(onSelectBook ? { onClick: onSelectBook } : {})}
            {...(selectedBookId === undefined ? { 'aria-current': 'page' as const } : {})}
          >
            <UsersRound aria-hidden="true" className={styles.bookIcon} />
            <span className={styles.bookName}>{t('contacts.books.all')}</span>
          </Link>
        </li>
        <AccountBookRows
          accountId={ownAccountId}
          selectedBookId={selectedBookId}
          actingAccountId={actingAccountId}
          actionable={canManageOwn}
          onRename={onRename}
          onDelete={onDelete}
          {...(canManageOwn && onShare !== undefined ? { onShare } : {})}
          {...(onSelectBook !== undefined ? { onSelectBook } : {})}
        />
      </ul>
      {sharedAccounts.map((account) => (
        <section key={account.id} className={styles.books} aria-label={account.name}>
          <h3 className={styles.railTitle}>{account.name}</h3>
          <ul className={styles.bookList}>
            <AccountBookRows
              accountId={account.id}
              selectedBookId={selectedBookId}
              actingAccountId={actingAccountId}
              actionable={false}
              linkAccountId={account.id}
              {...(onSelectBook !== undefined ? { onSelectBook } : {})}
            />
          </ul>
        </section>
      ))}
    </>
  )
}

/**
 * The rows for ONE account's books (S-4) — reads the replica for that account, never the acting
 * context's, because the rail lists every account beside the one being acted in. `actionable` is the
 * OWN section's management affordances, offered only while acting in the own account (see
 * `AddressBookList` on why visiting rows must stay plain links).
 */
function AccountBookRows({
  accountId,
  selectedBookId,
  actingAccountId,
  actionable,
  onRename,
  onDelete,
  onShare,
  onSelectBook,
  linkAccountId,
}: {
  readonly accountId: Id
  readonly selectedBookId: string | undefined
  readonly actingAccountId: Id | null
  readonly actionable: boolean
  readonly onRename?: (book: AddressBookRow) => void
  readonly onDelete?: (book: AddressBookRow) => void
  readonly onShare?: (book: AddressBookRow) => void
  readonly onSelectBook?: () => void
  readonly linkAccountId?: Id
}) {
  const { t } = useTranslation()
  const books = useAddressBooksFor(accountId)
  if (books === undefined) {
    return (
      <li className={styles.railLoading}>
        <Spinner size="sm" label={t('contacts.books.loading')} />
      </li>
    )
  }
  if (books.length === 0) {
    return <li className={styles.railEmpty}>{t('contacts.books.empty')}</li>
  }
  return books.map((book) => (
    <AddressBookItem
      key={book.id}
      book={book}
      {...(linkAccountId !== undefined ? { linkAccountId } : {})}
      selected={actingAccountId === accountId && book.id === selectedBookId}
      {...(onSelectBook !== undefined ? { onSelect: onSelectBook } : {})}
      {...(actionable && onRename !== undefined ? { onRename: () => onRename(book) } : {})}
      {...(actionable && onDelete !== undefined ? { onDelete: () => onDelete(book) } : {})}
      {...(actionable && onShare !== undefined ? { onShare: () => onShare(book) } : {})}
    />
  ))
}

function isShared(book: AddressBookRow): boolean {
  const shareWith = book.shareWith
  return shareWith != null && Object.keys(shareWith).length > 0
}

function AddressBookItem({
  book,
  selected,
  onSelect,
  onRename,
  onDelete,
  onShare,
  linkAccountId,
}: {
  book: AddressBookRow
  selected: boolean
  onSelect?: () => void
  /** Absent (or hidden while visiting a delegated account) ⇒ the row is a plain link. */
  onRename?: () => void
  onDelete?: () => void
  /** Absent when there is no session to share through. */
  onShare?: (() => void) | undefined
  /** Qualify the row's route with this account (S-4); `undefined` = the user's own account. */
  linkAccountId?: Id
}) {
  const { t } = useTranslation()
  const readOnly = book.myRights.mayWrite === false
  /*
   * `myRights.mayShare`, checked here rather than discovered from a refusal: a book shared WITH the
   * reader carries it `false`, and offering the control would open a dialog over something the
   * server will not let them change.
   */
  const canShare = onShare !== undefined && mayShareAddressBook(book.myRights)
  const items: MenuItemSpec[] = []
  if (!readOnly && onRename !== undefined) {
    items.push({ id: 'rename', label: t('contacts.books.rename.action'), onSelect: onRename })
  }
  // The default book is excluded on purpose: an account must keep one, the server will refuse to
  // destroy it, and an offer that can only fail is worse than no offer.
  if (onDelete !== undefined && book.myRights.mayDelete !== false && !book.isDefault) {
    items.push({
      id: 'delete',
      label: t('contacts.books.delete.action'),
      destructive: true,
      onSelect: onDelete,
    })
  }
  return (
    <li className={styles.bookRow}>
      <Link
        to={contactsPath(book.id, undefined, linkAccountId)}
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
          <span className={styles.bookName} title={book.name}>
            {book.name}
          </span>
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
      {(canShare || items.length > 0) && (
        <span className={styles.bookMenu}>
          {/* Beside the name, not inside the ⋯ — the same rule the calendar rail follows, and for
              the same reason: sharing is something people come to the rail to do. It shares the
              row's reveal chrome, so a rail nobody is pointing at stays as quiet as it was. */}
          {canShare && (
            <IconButton
              label={t('contacts.books.share', { name: book.name })}
              variant="ghost"
              size="sm"
              onClick={() => onShare?.()}
            >
              <UserPlus />
            </IconButton>
          )}
          {items.length > 0 && (
            <Menu
              align="end"
              triggerVariant="ghost"
              // Named after its ROW: a rail of four books otherwise exposes four buttons all called
              // "Address book actions", and a screen reader user cannot tell which one they are on.
              triggerLabel={t('contacts.books.actions', { name: book.name })}
              trigger={<Ellipsis aria-hidden="true" className={styles.bookIcon} />}
              items={items}
            />
          )}
        </span>
      )}
    </li>
  )
}

interface NameDialogProps {
  readonly title: string
  readonly submitLabel: string
  readonly initialName: string
  /** Existing names this one may not collide with (case-insensitive), so the clash is caught here. */
  readonly taken: readonly string[]
  readonly onClose: () => void
  readonly onSubmit: (name: string) => void
}

/**
 * The create/rename prompt — the same shape (and the same validation-before-dispatch discipline) as
 * the folder tree's, so a name that cannot work is refused in place rather than becoming a queued
 * intent that dead-letters minutes later.
 */
function NameDialog({
  title,
  submitLabel,
  initialName,
  taken,
  onClose,
  onSubmit,
}: NameDialogProps) {
  const { t } = useTranslation()
  const formId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(initialName)
    setError(null)
  }, [initialName])

  function validate(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) return t('contacts.books.error.nameRequired')
    if (trimmed.length > MAX_NAME_LENGTH) return t('contacts.books.error.nameTooLong')
    if (taken.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      return t('contacts.books.error.nameTaken')
    }
    return null
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    const message = validate(name)
    if (message !== null) {
      setError(message)
      return
    }
    onSubmit(name.trim())
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('contacts.books.delete.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.bookForm}>
        <label htmlFor={`${formId}-input`} className={styles.formLabel}>
          {t('contacts.books.nameLabel')}
        </label>
        <TextInput
          id={`${formId}-input`}
          ref={inputRef}
          value={name}
          maxLength={MAX_NAME_LENGTH}
          invalid={error !== null}
          {...(error !== null ? { 'aria-describedby': errorId } : {})}
          onChange={(event) => {
            setName(event.target.value)
            if (error !== null) setError(null)
          }}
        />
        {error !== null && (
          <p id={errorId} className={styles.formNotice}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

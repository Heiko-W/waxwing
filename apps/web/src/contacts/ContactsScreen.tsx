/**
 * Contacts area (M4.2): the responsive three-/two-/single-pane frame, built on the SAME layout
 * machinery as {@link ../app/shell/MailScreen} ({@link SplitPane} + {@link computePaneLayout} +
 * {@link useLayoutTier}) so contacts and mail feel like one app:
 *
 *  - desktop (>=64em): a persistent address-book rail + a resizable list|detail {@link SplitPane};
 *  - tablet (>=40em): a rail DRAWER + the list|detail split;
 *  - phone (<40em): a single pane, list XOR detail, where opening a card is a route change so the
 *    browser/OS Back gesture returns to the list.
 *
 * Selection is entirely the ROUTE (`/contacts/:bookId/:cardId`): the address book, the open card and
 * which pane the phone shows all derive from it, so there is no local selection state to fall out of
 * sync. Contacts always splits list beside detail on wide screens (Apple Contacts has no reading-pane
 * preference), so the mode is fixed to `right`.
 */

import type { Id } from '@waxwing/jmap'
import { ChevronLeft, Import, PanelLeft, Plus } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactsPath, useNavigate, useRoute } from '../app/route'
import { computePaneLayout, useLayoutTier } from '../app/shell/layout'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { type AddressBookRow, type ContactCardRow, useAddressBooks, useContactCard } from '../sync'
import { Button, IconButton, SplitPane } from '../ui'
import { AddressBookList } from './AddressBookList'
import { ContactDetail } from './ContactDetail'
import { ContactForm, type ContactFormSubmit } from './ContactForm'
import { ContactList } from './ContactList'
import { contactDisplayName } from './contact-fields'
import { groupMemberUids, isGroupCard } from './contact-group-mapping'
import styles from './contacts.module.css'
import { indexCardsByUid } from './expand-group'
import { GroupForm, type GroupFormSubmit } from './GroupForm'
import { GroupRail } from './GroupRail'
import { GroupView } from './GroupView'
import { useContactActions } from './use-contact-actions'
import {
  resolveMembers,
  selectGroups,
  selectMemberCandidates,
  useAccountContactCards,
} from './use-contact-groups'

// The import/export dialog (and, transitively, only via `contact-io`'s dynamic import, the jscontact
// conversion runtime in a chunk of its OWN) is loaded on demand — nobody opens it on the way to
// browsing contacts (NFR-PERF-03).
const ContactImportExportDialog = lazy(() => import('./ContactImportExportDialog'))

const BOOKS_REGION_ID = 'waxwing-books-region'
const BOOKS_TOGGLE_ID = 'waxwing-books-toggle'

/** True when `card` sits in at least one book the user may write to. */
function cardIsWritable(
  card: ContactCardRow | undefined,
  books: AddressBookRow[] | undefined,
): boolean {
  if (card === undefined || books === undefined) return false
  return Object.keys(card.addressBookIds).some(
    (id) => books.find((book) => book.id === id)?.myRights.mayWrite === true,
  )
}

/** The book a new contact should be created in: the selected one if writable, else the default/first. */
function pickTargetBook(
  bookId: string | undefined,
  books: AddressBookRow[] | undefined,
): AddressBookRow | undefined {
  if (books === undefined) return undefined
  if (bookId !== undefined) {
    const selected = books.find((book) => book.id === bookId)
    return selected?.myRights.mayWrite === true ? selected : undefined
  }
  return (
    books.find((book) => book.isDefault && book.myRights.mayWrite) ??
    books.find((book) => book.myRights.mayWrite)
  )
}

type EditorMode = 'create' | 'edit' | null

export function ContactsScreen() {
  const { t } = useTranslation()
  const tier = useLayoutTier()
  const route = useRoute()
  const navigate = useNavigate()

  const bookId = route.params.bookId
  const cardId = route.params.cardId

  const books = useAddressBooks()
  const selectedCard = useContactCard(cardId ?? '')
  const actions = useContactActions()

  const [editor, setEditor] = useState<EditorMode>(null)
  /*
   * A create the route is still following to its real id.
   *
   * `actions.create` resolves with the CREATION id — the client-minted key the optimistic row is
   * filed under and the one `ContactCard/set` uses as its `create` key. The server answers with an
   * id of its own, and `reconcileContactCardCreate` then deletes the optimistic row and re-files it
   * under that id. Navigating to the creation id therefore worked for a fraction of a second and
   * then pointed at nothing: every single save ended on "This contact is not available." over a
   * contact that had been created perfectly.
   *
   * The card is followed by its JSContact `uid` instead, which the reconciliation carries across
   * unchanged. That works offline too — before the ack there IS no server id, and the optimistic row
   * under the creation id is the right thing to show — so this corrects the route when the answer
   * arrives rather than making the save wait for one.
   */
  const [pendingCreate, setPendingCreate] = useState<{
    readonly uid: string
    readonly creationId: Id
  } | null>(null)
  // The group selected in the rail (LOCAL, not the route): filters the list pane to its members.
  const [selectedGroupId, setSelectedGroupId] = useState<Id | null>(null)
  const [groupEditor, setGroupEditor] = useState<EditorMode>(null)
  // The import/export dialog: 'full' = import + export of the visible list (toolbar); 'single' =
  // export the open card only (detail overflow); null = closed (and never mounted).
  const [ioMode, setIoMode] = useState<'full' | 'single' | null>(null)
  // Close any open editor (contact OR group) when the route's card changes (navigated away). The
  // group SELECTION is kept — opening a member from a group's list keeps the group in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on cardId change, not on mount only.
  useEffect(() => {
    setEditor(null)
    setGroupEditor(null)
  }, [cardId])

  const allCards = useAccountContactCards()
  const groups = useMemo(
    () => (allCards === undefined ? undefined : selectGroups(allCards, bookId)),
    [allCards, bookId],
  )
  const candidates = useMemo(() => selectMemberCandidates(allCards ?? []), [allCards])
  const cardsByUid = useMemo(() => indexCardsByUid(allCards ?? []), [allCards])
  const selectedGroup = useMemo(
    () =>
      selectedGroupId === null
        ? undefined
        : (allCards ?? []).find((card) => card.id === selectedGroupId && isGroupCard(card)),
    [allCards, selectedGroupId],
  )
  const groupMembers = useMemo(
    () =>
      selectedGroup === undefined ? [] : resolveMembers(groupMemberUids(selectedGroup), cardsByUid),
    [selectedGroup, cardsByUid],
  )

  const canEditSelected = cardIsWritable(selectedCard, books)
  const canEditGroup = cardIsWritable(selectedGroup, books)
  const targetBook = pickTargetBook(bookId, books)
  const editing = editor !== null || groupEditor !== null

  // The currently visible list — the export scope for the toolbar's Export (FR-CON-06): the selected
  // group's members when a group is open, otherwise every non-group card of the selected book (or all
  // books = "All Contacts"). A single-card export from the detail overflow uses `selectedCard`.
  const visibleCards = useMemo(
    () =>
      (allCards ?? []).filter(
        (card) =>
          !isGroupCard(card) && (bookId === undefined || card.addressBookIds[bookId] === true),
      ),
    [allCards, bookId],
  )
  const exportCards =
    ioMode === 'single'
      ? selectedCard === undefined
        ? []
        : [selectedCard]
      : selectedGroup !== undefined
        ? groupMembers
        : visibleCards
  const exportStem =
    ioMode === 'single' && selectedCard !== undefined
      ? contactDisplayName(selectedCard) || t('contacts.noName')
      : t('contacts.title')

  const onSubmit = useCallback(
    async (submit: ContactFormSubmit): Promise<void> => {
      setEditor(null)
      if (submit.kind === 'update') {
        actions.update(submit.cardId, submit.patch)
        return
      }
      const newCardId = await actions.create(submit.card)
      setPendingCreate({ uid: submit.card.uid, creationId: newCardId })
      // The book the reader is IN, not the book the card went into. They differ only in "All
      // Contacts", where the card is filed in the default book but the list the reader is looking at
      // shows it too — so there is no reason to move them out of it.
      navigate(contactsPath(bookId, newCardId))
    },
    [actions, navigate, bookId],
  )

  // Swap the creation id for the server id as soon as the acknowledged card appears in the replica.
  // `replace`, not push: the creation-id URL names nothing and must not be a Back destination.
  useEffect(() => {
    if (pendingCreate === null) return
    if (cardId !== pendingCreate.creationId) {
      // The reader went somewhere else in the meantime; stop following them around.
      setPendingCreate(null)
      return
    }
    const landed = (allCards ?? []).find(
      (card) => card.uid === pendingCreate.uid && card.id !== pendingCreate.creationId,
    )
    if (landed === undefined) return
    setPendingCreate(null)
    navigate(contactsPath(bookId, landed.id), { replace: true })
  }, [pendingCreate, allCards, cardId, bookId, navigate])

  const onGroupSubmit = useCallback(
    async (submit: GroupFormSubmit): Promise<void> => {
      setGroupEditor(null)
      if (submit.kind === 'update') {
        actions.update(submit.cardId, submit.patch)
        return
      }
      // The optimistic row carries the creation id; select it so the rail highlights the new group.
      const newGroupId = await actions.create(submit.card)
      setSelectedGroupId(newGroupId)
    },
    [actions],
  )

  // The pane must show the editor whenever one is open — even a create with no card selected (so it
  // takes over the single pane on a phone). Otherwise the reading pane follows the route as before.
  const layout = computePaneLayout(tier, 'right', cardId !== undefined || editing)

  const drawerCapable = tier !== 'desktop'
  /**
   * Which set of contacts is on screen — the same question mail's pane title answers.
   *
   * The BOOK, never the selected group: a group has its own heading inside the pane, exactly as an
   * opened message has its subject while the bar beside it still says "Inbox". Naming the group
   * here put the same text on screen twice, one line apart.
   */
  const listHeading =
    bookId === undefined
      ? t('contacts.books.all')
      : (books?.find((book) => book.id === bookId)?.name ?? t('contacts.title'))
  const [booksOpen, setBooksOpen] = useState(false)

  const closeBooks = useCallback(() => {
    setBooksOpen(false)
    document.getElementById(BOOKS_TOGGLE_ID)?.focus()
  }, [])

  // Selecting a group in the rail is a LOCAL selection (no route change); close any open editor and,
  // on a narrow screen, the drawer so the member list is visible.
  const onSelectGroup = useCallback(
    (groupId: Id): void => {
      setSelectedGroupId(groupId)
      setEditor(null)
      setGroupEditor(null)
      if (drawerCapable) closeBooks()
    },
    [drawerCapable, closeBooks],
  )

  // Choosing a book (or "All Contacts") leaves the group's member view — and, on a narrow screen,
  // closes the drawer, exactly as picking a group already did. Left open it lies over the list it
  // was opened to filter and swallows every tap meant for it, including Save in the contact form.
  const onSelectBook = useCallback(() => {
    setSelectedGroupId(null)
    if (drawerCapable) closeBooks()
  }, [drawerCapable, closeBooks])

  // Escape closes the address-book drawer (narrow screens only), restoring focus to its toggle.
  useEffect(() => {
    if (!booksOpen) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeBooks()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [booksOpen, closeBooks])

  // Move focus to the newly shown pane when the single-pane view swaps (Back from detail to list),
  // but never on the initial mount — a deep-loaded page must not steal focus from the skip link.
  const listRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const firstSwapRef = useRef(true)
  const singleDetail = !layout.split && layout.singlePane === 'reading'
  useEffect(() => {
    if (layout.split) return
    if (firstSwapRef.current) {
      firstSwapRef.current = false
      return
    }
    ;(singleDetail ? detailRef.current : listRef.current)?.focus()
  }, [layout.split, singleDetail])

  const booksRegionClass = booksOpen
    ? `${styles.booksRegion} ${styles.booksRegionOpen}`
    : styles.booksRegion

  const listPane = (
    <section
      className={styles.pane}
      aria-label={t('contacts.list.title')}
      ref={listRef}
      tabIndex={-1}
    >
      {/* Same bar, same place, as the mail screen: its own strip beside the panes, and inside the
          shell header on a phone. The title is new — this screen used to put a spacer where mail
          puts its heading, so on a phone NEITHER of the two rows said where you were. */}
      <ScreenBar>
        {drawerCapable && (
          <IconButton
            id={BOOKS_TOGGLE_ID}
            // A toggle says which way it goes. It kept saying "Show address books" while
            // `aria-expanded` said `true`, and pressing it again did nothing at all — the drawer had
            // only Escape and a backdrop tap to close it, neither of which is discoverable.
            label={t(booksOpen ? 'contacts.books.hide' : 'contacts.books.show')}
            variant="ghost"
            onClick={() => {
              if (booksOpen) closeBooks()
              else setBooksOpen(true)
            }}
            aria-expanded={booksOpen}
            aria-controls={BOOKS_REGION_ID}
          >
            <PanelLeft />
          </IconButton>
        )}
        <h1 className={shellStyles.paneTitle}>{listHeading}</h1>
        {/* `Import`, not `ArrowDownUp`: a vertical up/down arrow pair is the sort glyph everywhere
            else, and this area has no sort to offer — so the one control it did not name was read as
            the one thing it cannot do. */}
        <IconButton label={t('contacts.io.open')} variant="ghost" onClick={() => setIoMode('full')}>
          <Import />
        </IconButton>
        <IconButton
          label={t('contacts.new')}
          variant="ghost"
          disabled={targetBook === undefined}
          onClick={() => setEditor('create')}
        >
          <Plus />
        </IconButton>
      </ScreenBar>
      <div className={styles.paneBody}>
        {selectedGroup !== undefined ? (
          <GroupView
            group={selectedGroup}
            members={groupMembers}
            bookId={bookId}
            selectedCardId={cardId}
            canWrite={canEditGroup}
            onEdit={() => setGroupEditor('edit')}
            onDelete={() => {
              actions.remove(selectedGroup.id)
              setSelectedGroupId(null)
            }}
            onClose={() => setSelectedGroupId(null)}
          />
        ) : (
          <ContactList
            bookId={bookId}
            selectedCardId={cardId}
            {...(targetBook !== undefined ? { onCreate: () => setEditor('create') } : {})}
          />
        )}
      </div>
    </section>
  )

  const detailContent =
    groupEditor === 'create' && targetBook !== undefined ? (
      <GroupForm
        mode="create"
        bookId={targetBook.id}
        candidates={candidates}
        canWrite
        onSubmit={onGroupSubmit}
        onCancel={() => setGroupEditor(null)}
      />
    ) : groupEditor === 'edit' && selectedGroup !== undefined ? (
      <GroupForm
        mode="edit"
        card={selectedGroup}
        bookId={bookId ?? Object.keys(selectedGroup.addressBookIds)[0] ?? ''}
        candidates={candidates}
        canWrite={canEditGroup}
        onSubmit={onGroupSubmit}
        onCancel={() => setGroupEditor(null)}
      />
    ) : editor === 'create' && targetBook !== undefined ? (
      <ContactForm
        mode="create"
        bookId={targetBook.id}
        canWrite
        onSubmit={onSubmit}
        onCancel={() => setEditor(null)}
      />
    ) : editor === 'edit' && selectedCard !== undefined ? (
      <ContactForm
        mode="edit"
        card={selectedCard}
        bookId={bookId ?? Object.keys(selectedCard.addressBookIds)[0] ?? ''}
        canWrite={canEditSelected}
        onSubmit={onSubmit}
        onCancel={() => setEditor(null)}
      />
    ) : (
      <ContactDetail
        cardId={cardId}
        canWrite={canEditSelected}
        {...(canEditSelected ? { onEdit: () => setEditor('edit') } : {})}
        {...(cardId !== undefined ? { onExport: () => setIoMode('single') } : {})}
        {...(canEditSelected && cardId !== undefined
          ? {
              onDelete: () => {
                actions.remove(cardId)
                navigate(contactsPath(bookId))
              },
            }
          : {})}
      />
    )

  const detailPane = (
    <section
      className={styles.pane}
      aria-label={t('contacts.detail.title')}
      ref={detailRef}
      tabIndex={-1}
    >
      {singleDetail && !editing && (
        <div className={styles.paneToolbar}>
          <Button variant="ghost" onClick={() => navigate(contactsPath(bookId))}>
            <ChevronLeft aria-hidden="true" />
            {t('contacts.detail.back')}
          </Button>
        </div>
      )}
      <div className={styles.paneBody}>{detailContent}</div>
    </section>
  )

  return (
    <div className={styles.contactsScreen}>
      <nav id={BOOKS_REGION_ID} className={booksRegionClass} aria-label={t('contacts.books.title')}>
        <AddressBookList selectedBookId={bookId} onSelectBook={onSelectBook} />
        <GroupRail
          groups={groups}
          selectedGroupId={selectedGroupId}
          onSelect={onSelectGroup}
          {...(targetBook !== undefined ? { onNew: () => setGroupEditor('create') } : {})}
        />
      </nav>
      {drawerCapable && booksOpen && (
        // A click-catcher, not a second control: it does exactly what the toggle above does, and now
        // that the toggle says "Hide address books" while open, naming this the same thing would put
        // two identically-named buttons on one screen. It is already unfocusable (`tabIndex={-1}`),
        // and a reader who cannot see it closes the drawer with Escape or with the toggle.
        <button
          type="button"
          className={styles.backdrop}
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeBooks}
        />
      )}
      <div className={styles.paneArea}>
        {layout.split ? (
          <SplitPane
            orientation={layout.splitOrientation}
            label={t('contacts.list.resize')}
            defaultPrimarySize={340}
            minPrimarySize={260}
            maxPrimarySize={560}
          >
            {listPane}
            {detailPane}
          </SplitPane>
        ) : singleDetail ? (
          detailPane
        ) : (
          listPane
        )}
      </div>
      {ioMode !== null && (
        <Suspense fallback={null}>
          <ContactImportExportDialog
            open
            onClose={() => setIoMode(null)}
            books={books}
            existingCards={allCards}
            exportCards={exportCards}
            exportFilenameStem={exportStem}
            allowImport={ioMode === 'full'}
            defaultBookId={targetBook?.id}
            createCard={actions.create}
          />
        </Suspense>
      )}
    </div>
  )
}

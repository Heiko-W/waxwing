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

import { ChevronLeft, PanelLeft } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactsPath, useNavigate, useRoute } from '../app/route'
import { computePaneLayout, useLayoutTier } from '../app/shell/layout'
import { Button, IconButton, SplitPane } from '../ui'
import { AddressBookList } from './AddressBookList'
import { ContactDetail } from './ContactDetail'
import { ContactList } from './ContactList'
import styles from './contacts.module.css'

const BOOKS_REGION_ID = 'waxwing-books-region'
const BOOKS_TOGGLE_ID = 'waxwing-books-toggle'

export function ContactsScreen() {
  const { t } = useTranslation()
  const tier = useLayoutTier()
  const route = useRoute()
  const navigate = useNavigate()

  const bookId = route.params.bookId
  const cardId = route.params.cardId
  // Contacts has no reading-pane preference — always list beside detail on wide screens.
  const layout = computePaneLayout(tier, 'right', cardId !== undefined)

  const drawerCapable = tier !== 'desktop'
  const [booksOpen, setBooksOpen] = useState(false)

  const closeBooks = useCallback(() => {
    setBooksOpen(false)
    document.getElementById(BOOKS_TOGGLE_ID)?.focus()
  }, [])

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
      {drawerCapable && (
        <div className={styles.paneToolbar}>
          <IconButton
            id={BOOKS_TOGGLE_ID}
            label={t('contacts.books.show')}
            variant="ghost"
            onClick={() => setBooksOpen(true)}
            aria-expanded={booksOpen}
            aria-controls={BOOKS_REGION_ID}
          >
            <PanelLeft />
          </IconButton>
        </div>
      )}
      <div className={styles.paneBody}>
        <ContactList bookId={bookId} selectedCardId={cardId} />
      </div>
    </section>
  )

  const detailPane = (
    <section
      className={styles.pane}
      aria-label={t('contacts.detail.title')}
      ref={detailRef}
      tabIndex={-1}
    >
      {singleDetail && (
        <div className={styles.paneToolbar}>
          <Button variant="ghost" onClick={() => navigate(contactsPath(bookId))}>
            <ChevronLeft aria-hidden="true" />
            {t('contacts.detail.back')}
          </Button>
        </div>
      )}
      <div className={styles.paneBody}>
        <ContactDetail cardId={cardId} />
      </div>
    </section>
  )

  return (
    <div className={styles.contactsScreen}>
      <nav id={BOOKS_REGION_ID} className={booksRegionClass} aria-label={t('contacts.books.title')}>
        <AddressBookList selectedBookId={bookId} />
      </nav>
      {drawerCapable && booksOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label={t('contacts.books.hide')}
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
    </div>
  )
}

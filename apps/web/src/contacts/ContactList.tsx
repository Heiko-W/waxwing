/**
 * The virtualized contact list (M4.2) — the contacts analogue of {@link ../mail/MessageList}. Renders
 * the current book's window (from {@link useContactSearch}, which also owns the search-as-you-type box
 * above it) with TanStack Virtual so a large address book scrolls smoothly, hydrating only the visible
 * slice as DOM.
 *
 * A11y: an APG single-select `listbox`. The CONTAINER holds focus and moves an `aria-activedescendant`
 * across virtualized rows (so focus is never lost when a row unmounts on scroll), with
 * container-delegated Arrow/Home/End/Enter. Rows show an initials avatar + display name — the photo is
 * reserved for the detail pane (macOS Contacts shows names only in this column, and a blob fetch per
 * row would be needless work here).
 *
 * Selection is the ROUTE: opening a card navigates to `/contacts/:bookId/:cardId`, so the detail pane,
 * deep links and Back all stay in sync — no local selection state to drift.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type { Id } from '@waxwing/jmap'
import { Search, UsersRound, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { contactsPath, useNavigate } from '../app/route'
import type { Density } from '../mail/MessageRow'
import { type ContactCardRow, useLocalPref } from '../sync'
import { Avatar, Button, EmptyState, IconButton, Skeleton, VisuallyHidden } from '../ui'
import { contactDisplayName } from './contact-fields'
import styles from './contacts.module.css'
import { useContactSearch } from './use-contact-search'

/**
 * Row heights, per the SAME `list.density` preference the message list reads.
 *
 * The setting is called "List density" and was read in exactly one place, so choosing Compact
 * changed one of the app's list surfaces and left the rest alone. This is the other virtualized
 * list — the one where the choice has something to act on — so it follows too. The rails and the
 * file list keep `--waxwing-control-min`: their heights are a hit-target guarantee rather than a
 * density choice, and shrinking them is not this preference's to offer.
 */
const ROW_HEIGHT: Record<Density, number> = { comfortable: 56, compact: 44 }

/**
 * Enough to fill a pane without pretending to know how many contacts there are.
 *
 * Stable keys rather than the index, following `MessageList`'s `SKELETON_KEYS`: these are
 * positions in a fixed grid, not items with an identity.
 */
const SKELETON_KEYS = Array.from({ length: 8 }, (_, index) => `contact-skeleton-${index}`)
const OVERSCAN = 8

export interface ContactListProps {
  /** The address book whose cards are listed (`undefined` = all books). */
  readonly bookId: Id | undefined
  /** The card the route currently opens, if any (rendered as the selected option). */
  readonly selectedCardId: Id | undefined
  /**
   * Start creating a contact, offered inside the empty state.
   *
   * Optional on purpose: the screen passes it only where a writable address book exists, so the
   * empty state never offers an action that would be refused. The text used to instruct the reader
   * to "use + above" whether or not that button was enabled.
   */
  readonly onCreate?: (() => void) | undefined
}

export function ContactList({ bookId, selectedCardId, onCreate }: ContactListProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const listId = useId()
  const optionDomId = useCallback((index: number) => `${listId}-opt-${index}`, [listId])

  const density = useLocalPref<Density>('list.density') ?? 'comfortable'
  const { query, setQuery, cards, searching } = useContactSearch(bookId)
  const rows = cards ?? []
  const loading = cards === undefined
  const empty = !loading && rows.length === 0

  const [activeIndex, setActiveIndex] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: OVERSCAN,
  })
  const virtualItems = virtualizer.getVirtualItems()

  const open = useCallback(
    (card: ContactCardRow | undefined) => {
      if (card === undefined) return
      navigate(contactsPath(bookId, card.id))
    },
    [navigate, bookId],
  )

  const moveTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, rows.length - 1))
      setActiveIndex(clamped)
      virtualizer.scrollToIndex(clamped, { align: 'auto' })
    },
    [rows.length, virtualizer],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          moveTo(activeIndex + 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveTo(activeIndex - 1)
          break
        case 'Home':
          event.preventDefault()
          moveTo(0)
          break
        case 'End':
          event.preventDefault()
          moveTo(rows.length - 1)
          break
        case 'Enter':
          event.preventDefault()
          open(rows[activeIndex])
          break
      }
    },
    [activeIndex, moveTo, open, rows],
  )

  const activeDescendant = useMemo(() => {
    if (rows.length === 0) return undefined
    const clamped = Math.max(0, Math.min(activeIndex, rows.length - 1))
    return optionDomId(clamped)
  }, [activeIndex, rows.length, optionDomId])

  return (
    <div className={styles.contactListPane}>
      <search className={styles.searchBox}>
        <Search aria-hidden="true" className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          value={query}
          placeholder={t('contacts.search.placeholder')}
          aria-label={t('contacts.search.label')}
          // Only while the listbox EXISTS. The empty branch below renders a <p> instead, so a
          // constant `aria-controls` points at nothing — a dangling IDREF that axe reports as
          // `aria-valid-attr-value` (critical) and that a screen reader follows into nowhere.
          // This is the state a new account starts in and the one a no-match search lands in.
          aria-controls={empty ? undefined : listId}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== '' && (
          <IconButton
            label={t('contacts.search.clear')}
            variant="ghost"
            size="sm"
            onClick={() => setQuery('')}
          >
            <X />
          </IconButton>
        )}
      </search>

      <VisuallyHidden aria-live="polite">
        {loading ? '' : t('contacts.list.count', { count: rows.length })}
      </VisuallyHidden>

      {empty ? (
        // No instruction to go press something: where creating is possible the caller passes the
        // action, and where it is not (no writable address book) the message simply stands alone —
        // which is better than telling the reader to use a `+` that is disabled.
        <EmptyState
          icon={UsersRound}
          title={searching ? t('contacts.search.empty') : t('contacts.list.empty')}
          {...(!searching && onCreate !== undefined
            ? {
                // Its own wording, not the toolbar button's: two controls answering to one
                // accessible name on one screen is ambiguous to anything reading by name, and a
                // strict-mode locator resolves to both. "Add contact" also reads better as the way
                // OUT of an empty list than "New contact" does.
                action: (
                  <Button variant="secondary" size="sm" onClick={onCreate}>
                    {t('contacts.addFirst')}
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <div
          ref={scrollRef}
          id={listId}
          role="listbox"
          tabIndex={0}
          className={styles.listScroll}
          aria-label={t('contacts.list.title')}
          aria-activedescendant={activeDescendant}
          onKeyDown={onKeyDown}
        >
          {loading && (
            /*
             * Skeleton ROWS, not a spinner in an empty pane.
             *
             * `MessageList` writes the rule down and the message pane follows it — "text-shaped
             * placeholders rather than a spinner in a box: what is arriving is prose, and a spinner
             * says only 'wait' while these say what for". This list is the same two-column layout
             * one screen over and made the opposite choice, so the app changed its loading grammar
             * when the reader changed tab. `ContactOption` already renders a skeleton for a row it
             * has no card for; this just gives it some to render.
             */
            <div role="presentation" className={styles.listSpacer}>
              <VisuallyHidden>
                <span role="status">{t('contacts.list.loading')}</span>
              </VisuallyHidden>
              {SKELETON_KEYS.map((key, index) => (
                <ContactOption
                  key={key}
                  id={`${listId}-${key}`}
                  card={undefined}
                  selected={false}
                  focused={false}
                  offset={index * ROW_HEIGHT[density]}
                  height={ROW_HEIGHT[density]}
                  onOpen={() => {}}
                  onActivate={() => {}}
                />
              ))}
            </div>
          )}
          <div
            role="presentation"
            className={styles.listSpacer}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const card = rows[item.index]
              return (
                <ContactOption
                  key={card?.id ?? `skeleton-${item.index}`}
                  id={optionDomId(item.index)}
                  card={card}
                  selected={card !== undefined && card.id === selectedCardId}
                  focused={item.index === activeIndex}
                  offset={item.start}
                  height={item.size}
                  onOpen={() => open(card)}
                  onActivate={() => {
                    setActiveIndex(item.index)
                    scrollRef.current?.focus()
                  }}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

interface ContactOptionProps {
  readonly id: string
  readonly card: ContactCardRow | undefined
  readonly selected: boolean
  /** The roving option — where the keyboard is (M4.7, WCAG 2.4.7), distinct from the OPEN contact. */
  readonly focused: boolean
  readonly offset: number
  readonly height: number
  readonly onOpen: () => void
  readonly onActivate: () => void
}

function ContactOption({
  id,
  card,
  selected,
  focused,
  offset,
  height,
  onOpen,
  onActivate,
}: ContactOptionProps) {
  const { t } = useTranslation()
  const style = { transform: `translateY(${offset}px)`, height }

  if (card === undefined) {
    return (
      <div role="presentation" className={styles.contactRow} style={style}>
        <Skeleton circle width={36} height={36} />
        <Skeleton width="60%" height={12} />
      </div>
    )
  }

  const name = contactDisplayName(card) || t('contacts.noName')
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is delegated to the role="listbox" container (APG).
    // biome-ignore lint/a11y/useFocusableInteractive: an APG activedescendant listbox keeps focus on the container, not the options.
    <div
      id={id}
      role="option"
      aria-selected={selected}
      // Name the option explicitly so its accessible name is the display name once — the avatar's own
      // label plus the visible span would otherwise announce the name twice.
      aria-label={name}
      className={`${styles.contactRow}${selected ? ` ${styles.contactRowSelected}` : ''}${focused ? ` ${styles.contactRowFocused}` : ''}`}
      style={style}
      onClick={() => {
        onActivate()
        onOpen()
      }}
    >
      <span aria-hidden="true">
        <Avatar name={name} size="sm" />
      </span>
      <span className={styles.contactRowName}>{name}</span>
    </div>
  )
}

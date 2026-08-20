/**
 * Mail area (M1.4): the responsive three-/two-/single-pane frame. The folder tree (M1.5) and
 * the message list/reading panes (M1.6/M1.8) land later, so every pane here is a localized
 * placeholder — but the responsive structure is real:
 *
 *  - desktop (>=64em): a persistent folder rail + a resizable list|reading {@link SplitPane};
 *  - tablet (>=40em): a folder DRAWER + the list|reading split;
 *  - phone (<40em) OR reading-pane mode `off`: a single pane, list XOR reading, where opening a
 *    message is a history PUSH so the browser/OS back gesture returns to the list (FR-UI-03).
 *
 * The pane the shell shows is derived from the route (`/mail/:mailboxId/:emailId`) via
 * {@link computePaneLayout}; the folder drawer is a local disclosure with Escape/backdrop close
 * that restores focus to its toggle, and the single-pane swap moves focus to the new pane so
 * keyboard/SR users are not stranded (WCAG 2.4.3).
 */

import { ChevronLeft, MailOpen, PanelLeft, SlidersHorizontal, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { AccountTrees } from '../../mail/AccountTrees'
import { ActiveAccountScope } from '../../mail/ActiveAccountScope'
import { useActiveMailAccountId } from '../../mail/active-account'
import { Conversation } from '../../mail/Conversation'
import { folderDisplayName } from '../../mail/folder-tree'
import { Labels } from '../../mail/labels/Labels'
import { useLabelView } from '../../mail/labels/use-label-view'
import { MessageList } from '../../mail/MessageList'
import { SearchBox } from '../../mail/search/SearchBox'
import { useSearch } from '../../mail/search/use-search'
import { QuotaBar } from '../../quota'
import { useMailbox, useMailboxByRole, useReplica } from '../../sync'
import { Button, EmptyState, IconButton, SplitPane } from '../../ui'
import { useFocusTrap } from '../../ui/internal/useFocusTrap'
import {
  FULL_PARAM,
  isReadingHistoryEntry,
  mailHrefKeepingQuery,
  mailPath,
  useNavigate,
  useRoute,
  useRouter,
} from '../route'
import { useSession } from '../session/context'
import { computePaneLayout, useLayoutTier, useReadingPaneMode } from './layout'
import { useScreenBarSlot } from './ScreenBar'
import styles from './shell.module.css'

const FOLDER_REGION_ID = 'waxwing-folder-region'
const FOLDER_TOGGLE_ID = 'waxwing-folder-toggle'
const VIEW_OPTIONS_ID = 'waxwing-view-options'

export function MailScreen() {
  const { t } = useTranslation()
  const tier = useLayoutTier()
  const mode = useReadingPaneMode()
  const route = useRoute()
  const navigate = useNavigate()
  const routerBack = useRouter().back

  // The account picture (M4.4). `connected` is guaranteed here — the shell only mounts once ready —
  // and the ambient replica is the primary's. The acting account has ONE definition
  // (`useActiveMailAccountId`); the list/reading panes are re-scoped to it by `ActiveAccountScope`
  // below, which is a pass-through when nothing is shared.
  const { connected } = useSession()
  const { accountId: ambientAccountId } = useReplica()
  const activeAccountId = useActiveMailAccountId()

  const mailboxId = route.params.mailboxId
  const emailId = route.params.emailId
  // Handed the account explicitly: this hook runs in the BODY, above the scope it feeds, so it cannot
  // take the acting account from context the way the panes below it do.
  const search = useSearch(mailboxId, activeAccountId ?? ambientAccountId)
  /**
   * Full screen: this one message, without the list or the folder rail (`?full=1`).
   *
   * It is `mode: 'off'` for one navigation. That is not a shortcut — `off` and the phone tier
   * already describe exactly this shape, so full screen inherits a layout that is built, tested and
   * shipped rather than introducing a second single-pane path beside it. Back and Escape leave it
   * because leaving is just the previous URL.
   *
   * Only meaningful with a message open: `?full=1` on a folder would be a full-screen LIST, a state
   * with no exit and no name, so `mailHrefKeepingQuery` drops the flag on the way back (route.ts).
   */
  const fullScreen = emailId !== undefined && route.search.get(FULL_PARAM) === '1'
  const layout = computePaneLayout(tier, fullScreen ? 'off' : mode, emailId !== undefined)

  // A STABLE search-descriptor for the list — a fresh object each render would re-fire the list's
  // watch effect (and re-kick a sync) on every render (M3.1 review).
  const listSearch = useMemo(
    () =>
      search.active && search.spec !== null
        ? { spec: search.spec, scopeMailboxId: search.scopeMailboxId }
        : undefined,
    [search.active, search.spec, search.scopeMailboxId],
  )
  // A label browse (`/mail?label=…`) reuses the search seam and wins over `?q=` (M3.2).
  const labelView = useLabelView()
  const effectiveSearch = labelView?.listSearch ?? listSearch
  /**
   * `/mail` with no folder resolves to the Inbox.
   *
   * Without this the app's own landing screen contained no mail at all: `HOME_PATH` is `/mail`,
   * nothing resolved a default folder, and the pane rendered `list.noMailbox` ("choose a folder").
   * On a phone that is worse than it sounds, because the folders are behind a drawer — so the first
   * screen after signing in showed an instruction whose subject was not on screen. And it was not
   * only the first screen: the brand link, the bottom bar's Mail entry and the notification
   * fallback all point at `/mail`, so every return trip landed on the same dead end. The contacts
   * area, on the identical route shape, has always defaulted to "All contacts".
   *
   * Deliberately the INBOX ROLE rather than a remembered last folder. A remembered id is exactly the
   * shape B37 cost us once already: per-account JMAP ids are short, so a stale one very likely names
   * a real but different mailbox and the pane would show the wrong folder while looking entirely
   * right. The role is resolved from the live replica every time, so it cannot go stale.
   *
   * `replace`, so no history entry ever points at the empty state; and only when the route is not
   * already showing something (a search or a label browse both legitimately have no folder).
   */
  const inbox = useMailboxByRole('inbox')
  const browsingWithoutFolder = search.active || labelView !== null
  useEffect(() => {
    if (mailboxId !== undefined || browsingWithoutFolder) return
    if (inbox === undefined) return
    navigate(mailPath(inbox.id), { replace: true })
  }, [mailboxId, browsingWithoutFolder, inbox, navigate])

  /**
   * On a phone the screen's bar lives in the shell header, not in a strip of its own.
   *
   * This screen holds the slot rather than using `<ScreenBar>` because it has TWO bars and swaps
   * between them: the list's controls while the list is showing, the way back while a message is.
   */
  const screenBarSlot = useScreenBarSlot()

  const drawerCapable = tier !== 'desktop' && !fullScreen
  const [foldersOpen, setFoldersOpen] = useState(false)
  /**
   * The list's sort / threading / unread-first controls, collapsed by default.
   *
   * They used to be four permanently visible rows — measured at 156 px on a phone and 192 px on the
   * desktop, i.e. more than two message rows given up for settings a user touches perhaps monthly.
   * Behind a disclosure they keep their real labels and their real `<select>` semantics (a popover
   * of menu items would have cost both), and the strip above is a row this screen needed anyway.
   */
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false)

  // No manual focus restore here any more: `useFocusTrap` below records where focus was when the
  // drawer opened and puts it back on close, which covers the toggle and every other entry point.
  const closeFolders = useCallback(() => setFoldersOpen(false), [])

  const folderRegionRef = useRef<HTMLElement>(null)
  /** The drawer is modal only while it is a drawer — on desktop the same node is a persistent rail. */
  const drawerModal = drawerCapable && foldersOpen
  useFocusTrap(drawerModal, folderRegionRef)

  // Escape closes the folder drawer (narrow screens only), restoring focus to the toggle.
  useEffect(() => {
    if (!foldersOpen) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeFolders()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [foldersOpen, closeFolders])

  // Picking a folder or a label closes the drawer. That now happens through an explicit
  // `onNavigate` callback on the two navigators (see the render below), replacing an effect that
  // watched the SELECTED mailbox for a change.
  //
  // Watching for a change was the wrong question, and the hole sat exactly where a user is most
  // likely to look: tapping the folder that is already open produces no change, so the effect
  // returned early and the drawer stayed up — with no close button, Escape needing a keyboard, and
  // a 102 px strip of backdrop as the only target. Opening the drawer to confirm where you are and
  // then tapping the highlighted row was a dead end. The callback fires on the ACTION, so "same
  // folder" is covered by construction, while "New folder" and the per-row menus still leave the
  // drawer open because they are not selections.

  /**
   * Back, from the reading pane to the list.
   *
   * Two defects met here. The old implementation was `navigate(mailPath(mailboxId))`, which
   *
   *  - **pushed a third history entry.** Opening a message pushes (deliberately — FR-UI-03 wants the
   *    OS back gesture to return to the list), so after pressing Back the stack read
   *    `[list, message, list]` and the gesture re-opened the message the user had just left. The
   *    router has exposed `back()` since M1.4 and, until now, nothing called it.
   *  - **dropped the query string.** `?q=` / `?label=` are what the list is showing; without them it
   *    snaps back to the plain folder, changing the window key and resetting focus and selection
   *    mid-triage. The keyboard's `u` never had this bug — it used a helper that kept the query, and
   *    the comment above that helper describes exactly the damage the button was doing.
   *
   * Popping fixes both at once: the previous entry already carries the right URL, query and scroll
   * position. Only when our own entry is NOT on top (a deep link, a notification tap, a restored
   * PWA) is there nothing to pop — then replace, so we still do not grow the history.
   */
  const backToList = useCallback(() => {
    if (isReadingHistoryEntry(window.history.state)) {
      routerBack()
      return
    }
    navigate(mailHrefKeepingQuery(route.search, mailboxId), { replace: true })
  }, [routerBack, navigate, route.search, mailboxId])

  // Move focus to the newly shown pane when the single-pane view swaps (e.g. Back from reading
  // to list), but never on the initial mount — a deep-loaded page must not steal focus from the
  // skip link.
  const listRef = useRef<HTMLElement>(null)
  const readingRef = useRef<HTMLElement>(null)
  const firstSwapRef = useRef(true)
  const singleReading = !layout.split && layout.singlePane === 'reading'
  useEffect(() => {
    if (layout.split) return
    if (firstSwapRef.current) {
      firstSwapRef.current = false
      return
    }
    ;(singleReading ? readingRef.current : listRef.current)?.focus()
  }, [layout.split, singleReading])

  /**
   * What this list is showing, as a heading — the answer to "where am I".
   *
   * On a phone nothing said it at all: the only indication of the active folder was the highlight
   * inside the drawer, which is exactly the thing that is not on screen. The pane's landmark name
   * was the constant "Messages", so a screen reader was no better off. It now names the folder, the
   * label or the search, and the landmark takes the same string.
   */
  const openMailbox = useMailbox(mailboxId ?? '')
  const listTitle = search.active
    ? t('shell.list.searchTitle')
    : (labelView?.activeLabel ??
      (openMailbox === undefined ? t('shell.list.title') : folderDisplayName(openMailbox, t)))

  const folderRegionClass = foldersOpen
    ? `${styles.folderRegion} ${styles.folderRegionOpen}`
    : styles.folderRegion

  /**
   * The list's own controls, as content rather than as a strip.
   *
   * They render either in the pane's toolbar (tablet and desktop) or, on a phone, straight into the
   * shell header — one row instead of two. Same nodes, same handlers, same ids either way; only the
   * parent differs, so nothing about the drawer or the disclosure has to know which it is.
   */
  const listBar = (
    <>
      {drawerCapable && (
        <IconButton
          id={FOLDER_TOGGLE_ID}
          label={t('shell.folders.show')}
          variant="ghost"
          onClick={() => setFoldersOpen(true)}
          aria-expanded={foldersOpen}
          aria-controls={FOLDER_REGION_ID}
        >
          <PanelLeft />
        </IconButton>
      )}
      <h1 className={styles.paneTitle}>{listTitle}</h1>
      <IconButton
        label={viewOptionsOpen ? t('list.viewOptions.hide') : t('list.viewOptions.show')}
        variant="ghost"
        aria-expanded={viewOptionsOpen}
        aria-controls={VIEW_OPTIONS_ID}
        onClick={() => setViewOptionsOpen((open) => !open)}
      >
        <SlidersHorizontal />
      </IconButton>
    </>
  )

  /** The reading pane's way back, on the one tier where the list is not beside it. */
  const readingBar = (
    <Button variant="ghost" onClick={backToList}>
      <ChevronLeft aria-hidden="true" />
      {t('shell.reading.back')}
    </Button>
  )

  const listPane = (
    // The landmark keeps its stable name ("Messages"); the folder is stated by the heading inside
    // it. Naming the REGION after the folder was the first attempt and it was worse in two ways: a
    // landmark called "Inbox" is indistinguishable from the folder tree when cycling landmarks, and
    // it renamed the one handle fifteen suites use to address this pane. A heading answers "which
    // list is this" for a screen reader just as well — headings are navigable — and it is visible,
    // which the landmark name never was.
    <section className={styles.pane} aria-label={t('shell.list.title')} ref={listRef} tabIndex={-1}>
      {screenBarSlot === null && <div className={styles.paneToolbar}>{listBar}</div>}
      <SearchBox search={search} />
      <div className={styles.paneBody}>
        <MessageList
          mailboxId={mailboxId}
          search={effectiveSearch}
          activeLabel={labelView?.activeLabel}
          viewOptionsId={VIEW_OPTIONS_ID}
          viewOptionsOpen={viewOptionsOpen}
        />
      </div>
    </section>
  )

  const readingPane = (
    <section
      className={styles.pane}
      aria-label={t('shell.reading.title')}
      ref={readingRef}
      tabIndex={-1}
    >
      {singleReading && screenBarSlot === null && (
        <div className={`${styles.paneToolbar} ${styles.paneToolbarReading}`}>{readingBar}</div>
      )}
      <div className={styles.paneBody}>
        {emailId !== undefined ? (
          <Conversation emailId={emailId} mailboxId={mailboxId} />
        ) : (
          <EmptyState icon={MailOpen} title={t('shell.reading.empty')} />
        )}
      </div>
    </section>
  )

  const paneArea = layout.split ? (
    <SplitPane
      orientation={layout.splitOrientation}
      label={t('shell.list.resize')}
      // 420, not 360. The list column carries the search field, the folder title and the view
      // toggle; at 360 px those were competing for the width of a phone while ~930 px of header sat
      // empty beside them. Widening the column is the half of that imbalance worth fixing here —
      // moving search into the shell header would put a mail-only control on the Contacts and
      // Settings screens too.
      defaultPrimarySize={420}
      minPrimarySize={260}
      maxPrimarySize={640}
    >
      {listPane}
      {readingPane}
    </SplitPane>
  ) : singleReading ? (
    readingPane
  ) : (
    listPane
  )

  return (
    <div className={styles.mailScreen}>
      {/* The phone's single bar. Portalled rather than lifted, so the shell header stays ignorant of
          which screen is mounted and this component keeps its own state where it uses it. Whichever
          pane is on screen supplies the content: the list's controls, or the way back from a
          message. */}
      {screenBarSlot !== null && createPortal(singleReading ? readingBar : listBar, screenBarSlot)}
      {/*
        While it is a drawer this is a MODAL surface, and it now behaves like one.
        `useFocusTrap` moves focus inside on open, wraps Tab at the ends, and restores focus to the
        toggle on close. Without it, Tab from the open drawer walked into the search field UNDER the
        scrim — the DOM order is drawer → backdrop → panes, so the first tab stop after the drawer
        was a control the user could not see and was not supposed to reach.

        It stays a `<nav>`, deliberately. Switching it to `role="dialog"` with `aria-modal` while
        open was the first attempt: it announces modality, but an element has ONE role, so it
        destroyed the Folders landmark for exactly as long as the folders were on screen — the
        moment a screen-reader user cycling landmarks would go looking for it. Focus containment is
        what actually enforces modality here, and it costs no semantics; the backdrop and the close
        button carry the rest.

        On desktop none of this applies: the region is a persistent rail, not an overlay.
      */}
      {/* No rail in full screen: the whole point of the view is that nothing frames the message.
          Removed rather than hidden, so it takes no space and no tab stop. */}
      {!fullScreen && (
        <nav
          id={FOLDER_REGION_ID}
          ref={folderRegionRef}
          className={folderRegionClass}
          aria-label={t('shell.folders.title')}
          tabIndex={-1}
        >
          {drawerCapable && (
            // A visible way out. Escape needs a keyboard and the backdrop is a 102 px strip beside a
            // full-height panel — on touch that left the drawer with no affordance that says "close".
            <div className={styles.drawerHeader}>
              <IconButton label={t('shell.folders.hide')} variant="ghost" onClick={closeFolders}>
                <X />
              </IconButton>
            </div>
          )}
          {/* Accounts, their trees and the labels are ONE scrolling column (`.folderScroll`), not a
            stack of independently scrolling boxes. The storage bar stays outside it so it keeps its
            place at the bottom of the rail; the drawer's close button, above, keeps its place too. */}
          <div className={styles.folderScroll}>
            {connected && (
              <AccountTrees
                accounts={connected.accounts}
                primaryAccountId={connected.accountId}
                onNavigate={closeFolders}
              />
            )}
            <Labels onNavigate={closeFolders} />
          </div>
          <QuotaBar />
        </nav>
      )}
      {drawerCapable && (
        // A backdrop that closes the drawer on outside press. Mounted for as long as the drawer
        // COULD open, so it can fade with it — `.backdrop` keeps it hidden and untouchable until
        // `.backdropOpen` is added, the same visibility handshake the panel itself uses. tabIndex=-1
        // keeps it out of the tab order either way (Escape already covers keyboard close).
        <button
          type="button"
          className={`${styles.backdrop}${foldersOpen ? ` ${styles.backdropOpen}` : ''}`}
          aria-label={t('shell.folders.hide')}
          tabIndex={-1}
          onClick={closeFolders}
        />
      )}
      <div className={styles.paneArea}>
        {/* The list/reading panes operate on the ACTIVE account — and so does the engine every action
            in them dispatches to, because the scope is what `useAccountEngine`/`getEngineFor` resolve
            against. With nothing shared it is a pass-through: byte-for-byte the pre-M4.4 single tree. */}
        <ActiveAccountScope>{paneArea}</ActiveAccountScope>
      </div>
    </div>
  )
}

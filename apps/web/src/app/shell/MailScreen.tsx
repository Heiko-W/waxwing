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

import { ChevronLeft, PanelLeft, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AccountTrees } from '../../mail/AccountTrees'
import { ActiveAccountScope } from '../../mail/ActiveAccountScope'
import { useActiveMailAccountId } from '../../mail/active-account'
import { Conversation } from '../../mail/Conversation'
import { Labels } from '../../mail/labels/Labels'
import { useLabelView } from '../../mail/labels/use-label-view'
import { MessageList } from '../../mail/MessageList'
import { SearchBox } from '../../mail/search/SearchBox'
import { useSearch } from '../../mail/search/use-search'
import { QuotaBar } from '../../quota'
import { useMailboxByRole, useReplica } from '../../sync'
import { Button, IconButton, SplitPane } from '../../ui'
import { useFocusTrap } from '../../ui/internal/useFocusTrap'
import {
  isReadingHistoryEntry,
  mailHrefKeepingQuery,
  mailPath,
  useNavigate,
  useRoute,
  useRouter,
} from '../route'
import { useSession } from '../session/context'
import { computePaneLayout, useLayoutTier, useReadingPaneMode } from './layout'
import styles from './shell.module.css'

const FOLDER_REGION_ID = 'waxwing-folder-region'
const FOLDER_TOGGLE_ID = 'waxwing-folder-toggle'

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
  const layout = computePaneLayout(tier, mode, emailId !== undefined)

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

  const drawerCapable = tier !== 'desktop'
  const [foldersOpen, setFoldersOpen] = useState(false)

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

  const folderRegionClass = foldersOpen
    ? `${styles.folderRegion} ${styles.folderRegionOpen}`
    : styles.folderRegion

  const listPane = (
    <section className={styles.pane} aria-label={t('shell.list.title')} ref={listRef} tabIndex={-1}>
      {drawerCapable && (
        <div className={styles.paneToolbar}>
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
        </div>
      )}
      <SearchBox search={search} />
      <div className={styles.paneBody}>
        <MessageList
          mailboxId={mailboxId}
          search={effectiveSearch}
          activeLabel={labelView?.activeLabel}
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
      {singleReading && (
        <div className={styles.paneToolbar}>
          <Button variant="ghost" onClick={backToList}>
            <ChevronLeft aria-hidden="true" />
            {t('shell.reading.back')}
          </Button>
        </div>
      )}
      <div className={styles.paneBody}>
        {emailId !== undefined ? (
          <Conversation emailId={emailId} mailboxId={mailboxId} />
        ) : (
          <p className={styles.emptyPane}>{t('shell.reading.empty')}</p>
        )}
      </div>
    </section>
  )

  const paneArea = layout.split ? (
    <SplitPane
      orientation={layout.splitOrientation}
      label={t('shell.list.resize')}
      defaultPrimarySize={360}
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
      {/*
        While it is a drawer this is a MODAL surface, and it now behaves like one.
        `useFocusTrap` moves focus inside on open, wraps Tab at the ends, and restores focus to the
        toggle on close. Without it, Tab from the open drawer walked into the search field UNDER the
        scrim — the DOM order is drawer → backdrop → panes, so the first tab stop after the drawer
        was a control the user could not see and was not supposed to reach. `aria-modal` tells a
        screen reader the same thing the backdrop tells a sighted user.

        On desktop none of this applies: the region is a persistent rail, not an overlay.
      */}
      <nav
        id={FOLDER_REGION_ID}
        ref={folderRegionRef}
        className={folderRegionClass}
        aria-label={t('shell.folders.title')}
        tabIndex={-1}
        {...(drawerModal ? { 'aria-modal': true, role: 'dialog' as const } : {})}
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
        {connected && (
          <AccountTrees
            accounts={connected.accounts}
            primaryAccountId={connected.accountId}
            onNavigate={closeFolders}
          />
        )}
        <Labels onNavigate={closeFolders} />
        <QuotaBar />
      </nav>
      {drawerCapable && foldersOpen && (
        // A backdrop that closes the drawer on outside press. tabIndex=-1 keeps it out of the
        // tab order (Escape already covers keyboard close) so focus can't strand on it when it
        // unmounts.
        <button
          type="button"
          className={styles.backdrop}
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

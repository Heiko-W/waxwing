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

import { ChevronLeft, PanelLeft } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Conversation } from '../../mail/Conversation'
import { FolderTree } from '../../mail/FolderTree'
import { Labels } from '../../mail/labels/Labels'
import { useLabelView } from '../../mail/labels/use-label-view'
import { MessageList } from '../../mail/MessageList'
import { SearchBox } from '../../mail/search/SearchBox'
import { useSearch } from '../../mail/search/use-search'
import { QuotaBar } from '../../quota'
import { Button, IconButton, SplitPane } from '../../ui'
import { mailPath, useNavigate, useRoute } from '../route'
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

  const mailboxId = route.params.mailboxId
  const emailId = route.params.emailId
  const search = useSearch(mailboxId)
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
  const drawerCapable = tier !== 'desktop'
  const [foldersOpen, setFoldersOpen] = useState(false)

  const closeFolders = useCallback(() => {
    setFoldersOpen(false)
    // Return focus to the toggle so a keyboard/SR user is not dropped onto document.body.
    document.getElementById(FOLDER_TOGGLE_ID)?.focus()
  }, [])

  // Escape closes the folder drawer (narrow screens only), restoring focus to the toggle.
  useEffect(() => {
    if (!foldersOpen) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeFolders()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [foldersOpen, closeFolders])

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
          <Button variant="ghost" onClick={() => navigate(mailPath(mailboxId))}>
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

  return (
    <div className={styles.mailScreen}>
      <nav
        id={FOLDER_REGION_ID}
        className={folderRegionClass}
        aria-label={t('shell.folders.title')}
      >
        <FolderTree />
        <Labels />
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
        {layout.split ? (
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
        )}
      </div>
    </div>
  )
}

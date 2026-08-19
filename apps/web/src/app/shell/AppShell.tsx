/**
 * Authenticated app frame (M1.4). Renders the persistent chrome (skip link, header, primary
 * nav) and the active route's screen inside `<main>`: mail is the eager primary screen; contacts
 * and settings are lazy route chunks (NFR-PERF-03) behind a Suspense fallback. The re-auth
 * overlay (FR-AUTH-06) sits above everything and never unmounts the frame. Consumes the router
 * and the connected session from context; mounted by {@link App} only once `status === 'ready'`.
 */

import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useComposerStore, useDraftRestore, useSendErrorNotifier } from '../../compose'
import { ActiveAccountScope } from '../../mail/ActiveAccountScope'
import { useAppBadge, useNotificationClickNavigation } from '../../notify'
import { QueuedSends, useConflictNotifier } from '../../outbox'
import { ChunkErrorBoundary } from '../../pwa/ChunkErrorBoundary'
import { useQuotaNotifier } from '../../quota'
import { ShortcutProvider } from '../../shortcuts'
import { Spinner } from '../../ui'
import type { WaxwingConfig } from '../config'
import { HOME_PATH, useNavigate, useRoute } from '../route'
import { useSession } from '../session/context'
import { Header } from './Header'
import { MailScreen } from './MailScreen'
import { PrimaryNav } from './PrimaryNav'
import { ReauthDialog } from './ReauthDialog'
import styles from './shell.module.css'
import { useDocumentTitle } from './use-document-title'
import { useMailtoHandler } from './use-mailto-handler'
import { useStorageFullNotifier } from './use-storage-notifier'

const ContactsPage = lazy(() => import('../../contacts/ContactsPage'))
const SettingsPage = lazy(() => import('../../settings/SettingsPage'))
// The composer host (docked drafts + squire) loads only once a draft is open (keeps it out of the
// entry chunk). It lives here — outside the route-swapped <main> — so drafts survive navigation.
const ComposerHost = lazy(() => import('../../compose/ComposerHost'))

export interface AppShellProps {
  readonly config: WaxwingConfig
}

export function AppShell({ config }: AppShellProps) {
  const { t } = useTranslation()
  const route = useRoute()
  const navigate = useNavigate()
  const { connected, reauth } = useSession()
  const hasDrafts = useComposerStore((state) => state.drafts.size > 0)

  // Bring back any unsynced local drafts (crash/refresh) as minimized chips.
  useDraftRestore()
  // Surface a send that was rejected after its undo grace (toast + reopen the draft).
  useSendErrorNotifier()
  // Surface an offline action the server rejected on replay (gentle warning toast + one action).
  useConflictNotifier()
  // Surface a cache write the browser refused for lack of space (mail is no longer kept offline).
  useStorageFullNotifier()
  // Surface a server-side mailbox quota crossing 90 % / running out (M3.7, FR-QTA-01).
  useQuotaNotifier()
  // The service worker focused this tab after a notification click — go where it says (M3.6).
  useNotificationClickNavigation()
  // Unread inbox count on the installed app icon, where the platform has the Badging API.
  useAppBadge()
  // The OS handed us a `mailto:` link — open a composer for it (FR-CMP-13).
  useMailtoHandler()
  // Name the screen in the tab, the history menu and the OS task switcher.
  useDocumentTitle(config.branding.productName)

  // (The service worker is registered in <App>, above the auth gate, and the browser's install offer
  // is captured in main.tsx before the first await — see those files for why neither belongs here.)

  // Canonical redirect: the bare app root resolves to the mail area.
  useEffect(() => {
    if (route.path === '/') navigate(HOME_PATH, { replace: true })
  }, [route.path, navigate])

  // (`/` → focus search used to be an ad-hoc listener right here. It is now one row in the shortcut
  // registry, dispatched by the single <ShortcutProvider/> listener below — M3.8. Two listeners for
  // one key is exactly the conflict the plan forbids.)

  const username = connected?.username ?? ''

  let screen: ReactNode
  switch (route.id) {
    case 'contacts':
      screen = <ContactsPage />
      break
    case 'settings':
      screen = <SettingsPage />
      break
    case 'notFound':
      screen = (
        <div className={styles.screen}>
          <h1 className={styles.screenTitle}>{t('shell.notFound.title')}</h1>
          <p className={styles.screenLead}>{t('shell.notFound.body')}</p>
        </div>
      )
      break
    default:
      screen = <MailScreen />
  }

  return (
    // The OUTER boundary. It has to be out here, not just around the routes: `ComposerHost` below and
    // the header's dialogs are lazy chunks too, and after a deploy has deleted the old hashed chunks
    // the composer is the FIRST one most users touch. Uncaught, that unmounts the whole tree — the
    // white screen this boundary exists to prevent (M3.5).
    <ChunkErrorBoundary>
      <div className={styles.app}>
        {/* The skip link stays an ANCHOR — it is a jump to a section of this page, which is what an
            anchor is for, and what a screen reader announces it as. But it cannot rely on the browser
            to make the jump: `<base href>` (FR-DEP-02, and Stalwart rewrites it to the mount prefix)
            resolves a bare "#main" against the MOUNT ROOT rather than the current URL, so on
            /mail/inbox/42 the first tab stop would navigate to /#main and reload the whole app. We do
            the jump ourselves; the href stays for semantics and for a right-click. */}
        {/* biome-ignore lint/a11y/useValidAnchor: a skip link IS page navigation — see above; the handler only substitutes for the fragment jump that <base href> breaks. */}
        <a
          className={styles.skip}
          href="#main"
          onClick={(event) => {
            event.preventDefault()
            document.getElementById('main')?.focus()
          }}
        >
          {t('shell.skip')}
        </a>
        <Header config={config} username={username} />
        <div className={styles.body}>
          <PrimaryNav />
          <main id="main" className={styles.main} tabIndex={-1}>
            {/* The INNER boundary keeps a broken screen from taking the chrome with it, and resets on
                navigation — otherwise one failed route would leave the panel up forever and the nav
                would look dead. */}
            <ChunkErrorBoundary resetKey={route.id}>
              <Suspense
                fallback={
                  <div className={styles.emptyPane}>
                    <Spinner />
                  </div>
                }
              >
                {screen}
              </Suspense>
            </ChunkErrorBoundary>
          </main>
        </div>
        {reauth && <ReauthDialog />}
        {/* The keyboard layer (M3.8): one window listener + the lazy ⌘K palette / `?` cheat-sheet.
            It renders no chrome, and it sits INSIDE the router, the replica and the toast provider —
            exactly the contexts its action context is assembled from.

            And inside the ACTING ACCOUNT (M4.4 Etappe 4), because `useShortcutContext` pairs role
            mailbox ids resolved from `useMailboxes()` (`e` archive, `#` trash, `!` junk) with target
            ids taken from `useListStore` — which holds the ACTIVE account's list. Mounted under the
            primary provider, `e` on a shared selection would resolve the PRIMARY's Archive id, so
            routing the engine correctly would not save it: the ids themselves would be foreign. A
            keystroke fires with no per-row confirmation, which makes this the purest form of that
            path. Pass-through when nothing is shared.

            `useConflictNotifier()` (above), `<QueuedSends/>` and `<ComposerHost/>` stay OUTSIDE the
            scope deliberately — see `ActiveAccountScope`'s header for the split. */}
        <ActiveAccountScope>
          <ShortcutProvider />
        </ActiveAccountScope>
        <QueuedSends />
        {hasDrafts && (
          <Suspense fallback={null}>
            <ComposerHost />
          </Suspense>
        )}
      </div>
    </ChunkErrorBoundary>
  )
}

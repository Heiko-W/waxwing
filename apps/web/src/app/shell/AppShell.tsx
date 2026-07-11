/**
 * Authenticated app frame (M1.4). Renders the persistent chrome (skip link, header, primary
 * nav) and the active route's screen inside `<main>`: mail is the eager primary screen; contacts
 * and settings are lazy route chunks (NFR-PERF-03) behind a Suspense fallback. The re-auth
 * overlay (FR-AUTH-06) sits above everything and never unmounts the frame. Consumes the router
 * and the connected session from context; mounted by {@link App} only once `status === 'ready'`.
 */

import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useComposerStore, useDraftRestore } from '../../compose'
import { Spinner } from '../../ui'
import type { WaxwingConfig } from '../config'
import { HOME_PATH, useNavigate, useRoute } from '../route'
import { useSession } from '../session/context'
import { Header } from './Header'
import { MailScreen } from './MailScreen'
import { PrimaryNav } from './PrimaryNav'
import { ReauthDialog } from './ReauthDialog'
import styles from './shell.module.css'

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

  // Canonical redirect: the bare app root resolves to the mail area.
  useEffect(() => {
    if (route.path === '/') navigate(HOME_PATH, { replace: true })
  }, [route.path, navigate])

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
    <div className={styles.app}>
      <a className={styles.skip} href="#main">
        {t('shell.skip')}
      </a>
      <Header config={config} username={username} />
      <div className={styles.body}>
        <PrimaryNav />
        <main id="main" className={styles.main} tabIndex={-1}>
          <Suspense
            fallback={
              <div className={styles.emptyPane}>
                <Spinner />
              </div>
            }
          >
            {screen}
          </Suspense>
        </main>
      </div>
      {reauth && <ReauthDialog />}
      {hasDrafts && (
        <Suspense fallback={null}>
          <ComposerHost />
        </Suspense>
      )}
    </div>
  )
}

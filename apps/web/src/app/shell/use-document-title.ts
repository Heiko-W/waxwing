/**
 * Keep `document.title` describing the screen the user is on.
 *
 * Until this existed there was exactly ONE write to `document.title` in the whole source tree
 * (`theme.ts`, at startup, with the configured product name), so every screen was called the same
 * thing. That is not cosmetic here: this app pushes history entries deliberately and often — opening
 * a message, switching folder, submitting a search — and the browser's back MENU lists them all by
 * title. Twenty identical rows answer none of the questions that menu exists to answer. The same
 * string is what a bookmark records, what a second tab shows, and what the installed PWA hands the
 * OS task switcher.
 *
 * The product name always comes from `config.branding` (FR-THEME-02) and is never the literal
 * "Waxwing"; it stays the trailing half so the app is still identifiable at a glance, which is also
 * the convention every mail client follows.
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { folderDisplayName } from '../../mail/folder-tree'
import { useMailboxOptional } from '../../sync'
import { useRoute } from '../route'

export function useDocumentTitle(productName: string): void {
  const { t } = useTranslation()
  const route = useRoute()
  const mailboxId = route.params.mailboxId
  // The OPTIONAL form, and that is not a nicety: `SyncEngineHost` renders its children without a
  // `ReplicaProvider` while `connected` is null, which is every reload for as long as the session
  // takes to restore. The throwing hook crashed the shell in exactly that window — a reload landed
  // back on the sign-in screen reporting "Something went wrong", which is a plausible-looking way
  // for a title to break an app.
  const mailbox = useMailboxOptional(mailboxId)

  useEffect(() => {
    const section = ((): string | undefined => {
      switch (route.id) {
        case 'contacts':
          return t('shell.menu.contacts')
        // Calendar and Files fell into `default` below, where `mailbox` is undefined on a route
        // that has no mailbox — so both screens were titled with the bare product name. HIG
        // `toolbars`: "Don't title windows with your app name. Your app's name doesn't provide
        // useful information about your content hierarchy."
        case 'calendar':
          return t('shell.menu.calendar')
        case 'files':
          return t('shell.menu.files')
        case 'settings':
          return t('shell.menu.settings')
        case 'notFound':
          return t('shell.notFound.title')
        default:
          // A label browse or a search legitimately has no folder — the product name alone is then
          // the honest answer, rather than naming a folder the list is not showing.
          return mailbox === undefined ? undefined : folderDisplayName(mailbox, t)
      }
    })()
    document.title = section === undefined ? productName : `${section} — ${productName}`
  }, [route.id, mailbox, productName, t])
}

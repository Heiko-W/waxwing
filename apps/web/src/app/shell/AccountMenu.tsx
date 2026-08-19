/**
 * Account menu (FR-AUTH-05). A design-system {@link Menu} with two sign-out choices; the
 * destructive "sign out & remove data" routes through a confirmation {@link Dialog} before the
 * local wipe. Both actions delegate to the session provider.
 *
 * It also carries the ONLY install offer in the app (M3.5): one menu item, shown solely where an
 * install is actually possible, and never as a banner or a nag. The dialog behind it is a lazy
 * chunk — nothing about installing is in the entry bundle.
 */

import { Download, LogOut, Trash2, User, UserPlus, UserRound } from 'lucide-react'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { switchAccount, useAccountRegistry } from '../../auth/use-account-registry'
import { useInstallPrompt } from '../../pwa/install/use-install-prompt'
import { Button, Dialog, Menu, type MenuItemSpec, VisuallyHidden } from '../../ui'
import { useSession } from '../session/context'
import styles from './shell.module.css'

const InstallDialog = lazy(() => import('../../pwa/install/InstallDialog'))

export interface AccountMenuProps {
  readonly productName: string
  readonly username: string
}

export function AccountMenu({ productName, username }: AccountMenuProps) {
  const { t } = useTranslation()
  const { signOut, signOutAndWipe } = useSession()
  const registry = useAccountRegistry()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const closeConfirm = useCallback(() => setConfirmOpen(false), [])
  const [installOpen, setInstallOpen] = useState(false)
  const closeInstall = useCallback(() => setInstallOpen(false), [])
  const { canPrompt, isStandalone, platform, promptInstall } = useInstallPrompt()

  // Already installed → nothing to offer. Otherwise: Chromium gave us an event to replay, or this is
  // iOS, where the only route in is Share → "Add to Home Screen" and only instructions can help.
  const offerInstall = !isStandalone && (canPrompt || platform === 'ios')

  // The other signed-in accounts (M5.14, FR-AUTH-07). Absent while only one is registered, so a
  // single-account install sees exactly the menu it saw before.
  const others = registry.accounts.filter((account) => account.scope !== registry.activeScope)

  const items: MenuItemSpec[] = [
    ...others.map((account) => ({
      id: `switch-${account.scope}`,
      label: t('account.switchTo', { name: account.label }),
      icon: UserRound,
      onSelect: () => {
        switchAccount(account.scope)
        // The session provider holds ONE session, so switching means ending this one and signing
        // in as the other. `signOut` deliberately does not wipe: the other account's credentials
        // live in its own store (ADR-004), and this account's survive for switching back.
        signOut()
      },
    })),
    {
      id: 'add-account',
      label: t('account.add'),
      icon: UserPlus,
      // Same mechanism, and the label says what happens: this account stays in the switcher, but
      // the session ends so the next one can begin.
      onSelect: signOut,
    },
    ...(offerInstall
      ? [
          {
            id: 'install',
            label: t('pwa.install.menu'),
            icon: Download,
            onSelect: () => setInstallOpen(true),
          },
        ]
      : []),
    { id: 'sign-out', label: t('account.signOut'), icon: LogOut, onSelect: signOut },
    {
      id: 'sign-out-remove',
      label: t('account.signOutRemove'),
      icon: Trash2,
      destructive: true,
      onSelect: () => setConfirmOpen(true),
    },
  ]

  return (
    <>
      {username !== '' && (
        <>
          {/*
            The statement for assistive tech, on every viewport; the visible half is just the
            address. The header used to carry the whole sentence — "Signed in as
            alice@example.com", ~230 px of prose and the one thing in that band that is not a
            control, in a strip the design system asks to recede. Splitting them also retires a
            caveat: the phone rule below no longer has to keep the sentence in the accessibility
            tree while hiding it, because this sibling always does.
          */}
          <VisuallyHidden>{t('account.signedInAs', { name: username })}</VisuallyHidden>
          <span className={styles.accountName} aria-hidden="true">
            {username}
          </span>
        </>
      )}
      <Menu
        triggerLabel={t('account.menu')}
        trigger={<User aria-hidden="true" className={styles.statusIcon} />}
        items={items}
        align="end"
      />
      <Dialog
        open={confirmOpen}
        onClose={closeConfirm}
        title={t('account.confirmRemove.title')}
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm}>
              {t('account.confirmRemove.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                closeConfirm()
                signOutAndWipe()
              }}
            >
              {t('account.confirmRemove.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('account.confirmRemove.body', { product: productName })}</p>
      </Dialog>
      {installOpen && (
        <Suspense fallback={null}>
          <InstallDialog
            open
            onClose={closeInstall}
            productName={productName}
            platform={platform}
            canPrompt={canPrompt}
            onInstall={() => void promptInstall()}
          />
        </Suspense>
      )}
    </>
  )
}

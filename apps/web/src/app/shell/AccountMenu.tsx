/**
 * Account menu (FR-AUTH-05). A design-system {@link Menu} with two sign-out choices; the
 * destructive "sign out & remove data" routes through a confirmation {@link Dialog} before the
 * local wipe. Both actions delegate to the session provider.
 *
 * It also carries the ONLY install offer in the app (M3.5): one menu item, shown solely where an
 * install is actually possible, and never as a banner or a nag. The dialog behind it is a lazy
 * chunk — nothing about installing is in the entry bundle.
 */

import { Download, LogOut, Trash2, User } from 'lucide-react'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInstallPrompt } from '../../pwa/install/use-install-prompt'
import { Button, Dialog, Menu, type MenuItemSpec } from '../../ui'
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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const closeConfirm = useCallback(() => setConfirmOpen(false), [])
  const [installOpen, setInstallOpen] = useState(false)
  const closeInstall = useCallback(() => setInstallOpen(false), [])
  const { canPrompt, isStandalone, platform, promptInstall } = useInstallPrompt()

  // Already installed → nothing to offer. Otherwise: Chromium gave us an event to replay, or this is
  // iOS, where the only route in is Share → "Add to Home Screen" and only instructions can help.
  const offerInstall = !isStandalone && (canPrompt || platform === 'ios')

  const items: MenuItemSpec[] = [
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
        <span className={styles.accountName}>{t('account.signedInAs', { name: username })}</span>
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

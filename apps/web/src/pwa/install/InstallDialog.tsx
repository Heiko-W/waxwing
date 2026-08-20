/**
 * The install dialog (M3.5, NFR-COMPAT-01). Lazily imported by the account menu, so nothing about
 * installing is in the entry chunk.
 *
 * Two stories, because the platforms genuinely differ: Chromium hands us a `beforeinstallprompt`
 * event we can replay on a click, while Safari/iOS has NO install API — the only way in is
 * Share → "Add to Home Screen", and on iOS that is also the only way Web Push can ever work
 * (M3.6), which is why the note is here rather than buried in a settings page.
 */

import { useTranslation } from 'react-i18next'
import { Button, Dialog, SectionLabel } from '../../ui'
import styles from './install.module.css'
import type { InstallPlatform } from './use-install-prompt'

export interface InstallDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** From config branding — never a hardcoded product name (FR-THEME-02). */
  readonly productName: string
  readonly platform: InstallPlatform
  /** True when the browser gave us an install event to replay. */
  readonly canPrompt: boolean
  readonly onInstall: () => void
}

export default function InstallDialog({
  open,
  onClose,
  productName,
  platform,
  canPrompt,
  onInstall,
}: InstallDialogProps) {
  const { t } = useTranslation()

  const footer = canPrompt ? (
    <>
      <Button variant="secondary" onClick={onClose}>
        {t('pwa.install.cancel')}
      </Button>
      <Button
        onClick={() => {
          onInstall()
          onClose()
        }}
      >
        {t('pwa.install.action')}
      </Button>
    </>
  ) : (
    <Button variant="secondary" onClick={onClose}>
      {t('pwa.install.gotIt')}
    </Button>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pwa.install.title', { product: productName })}
      footer={footer}
    >
      <p>{t('pwa.install.body')}</p>
      {!canPrompt && platform === 'ios' && (
        <>
          <div className={styles.stepsHeading}>
            <SectionLabel>{t('pwa.install.ios.title')}</SectionLabel>
          </div>
          <ol className={styles.steps}>
            <li>{t('pwa.install.ios.steps.share')}</li>
            <li>{t('pwa.install.ios.steps.add')}</li>
            <li>{t('pwa.install.ios.steps.open', { product: productName })}</li>
          </ol>
          <p className={styles.note}>{t('pwa.install.ios.pushNote')}</p>
        </>
      )}
    </Dialog>
  )
}

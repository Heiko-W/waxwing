/**
 * Shell header (banner). Branding comes entirely from config (FR-THEME-02): the product name,
 * the logo (resolved against `document.baseURI` so it works under any mount prefix) and the
 * home link — the product name is never hardcoded. The right side carries the connectivity
 * status and the account menu; theme + language live in Settings.
 */

import { Command } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { NewMessageButton } from '../../compose'
import { OutboxProblemsButton } from '../../outbox'
import { formatChord, isApplePlatform, usePaletteUi } from '../../shortcuts'
import { IconButton } from '../../ui'
import type { WaxwingConfig } from '../config'
import { HOME_PATH, Link } from '../route'
import { AccountMenu } from './AccountMenu'
import { StatusRegion } from './StatusRegion'
import styles from './shell.module.css'

export interface HeaderProps {
  readonly config: WaxwingConfig
  readonly username: string
}

export function Header({ config, username }: HeaderProps) {
  const { t } = useTranslation()
  const { branding } = config
  const logoSrc = new URL(branding.logo, document.baseURI).href
  const openPalette = usePaletteUi((state) => state.openPalette)

  // The chord is rendered, never hardcoded: ⌘K on Apple, Ctrl+K everywhere else.
  const paletteKeys = useMemo(() => {
    const apple = isApplePlatform()
    return formatChord('Mod+k', apple).join(apple ? '' : '+')
  }, [])

  return (
    <header className={styles.header}>
      <Link
        to={HOME_PATH}
        className={styles.brand}
        aria-label={t('shell.brand', { product: branding.productName })}
      >
        <img className={styles.brandLogo} src={logoSrc} alt="" />
        <span className={styles.brandName}>{branding.productName}</span>
      </Link>
      <div className={styles.spacer} />
      <div className={styles.headerControls}>
        {/* Discoverability (and the only way to reach the palette on a touch device, where there is
            no ⌘K to press). */}
        <IconButton
          label={t('palette.open', { keys: paletteKeys })}
          variant="ghost"
          onClick={() => openPalette()}
        >
          <Command />
        </IconButton>
        <NewMessageButton />
        <OutboxProblemsButton />
        <StatusRegion />
        <AccountMenu productName={branding.productName} username={username} />
      </div>
    </header>
  )
}

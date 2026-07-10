/**
 * Hoster branding links (FR-THEME-02): imprint / privacy / support, each rendered only when
 * `config.branding.links.*` is set. External URLs, so plain `<a>` (never the internal router
 * Link). Renders nothing when no links are configured.
 */

import { useTranslation } from 'react-i18next'
import styles from './BrandLinks.module.css'
import { useConfig } from './config-context'

export interface BrandLinksProps {
  readonly className?: string | undefined
}

export function BrandLinks({ className }: BrandLinksProps) {
  const { t } = useTranslation()
  const { links } = useConfig().branding

  const entries: { key: 'imprint' | 'privacy' | 'support'; href: string }[] = []
  if (links.imprint) entries.push({ key: 'imprint', href: links.imprint })
  if (links.privacy) entries.push({ key: 'privacy', href: links.privacy })
  if (links.support) entries.push({ key: 'support', href: links.support })
  if (entries.length === 0) return null

  return (
    <nav aria-label={t('footer.label')} className={className}>
      <ul className={styles.list}>
        {entries.map(({ key, href }) => (
          <li key={key}>
            <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
              {t(`footer.${key}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

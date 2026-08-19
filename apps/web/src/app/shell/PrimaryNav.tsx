/**
 * Primary section navigation (Mail / Contacts / Settings). A left icon rail on tablet/desktop,
 * a bottom bar on the phone (FR-UI-03 bottom-reachable actions). The active section is marked
 * with `aria-current="page"`; the links are real {@link Link}s (base-path-safe, open-in-new-tab
 * friendly).
 */

import { CalendarDays, FolderOpen, type LucideIcon, Mail, Settings, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CALENDAR_PATH,
  CONTACTS_PATH,
  FILES_PATH,
  HOME_PATH,
  Link,
  type RouteId,
  settingsPath,
  useRoute,
} from '../route'
import styles from './shell.module.css'

interface NavItem {
  readonly id: RouteId
  readonly to: string
  readonly icon: LucideIcon
  readonly labelKey: string
}

const ITEMS: readonly NavItem[] = [
  { id: 'mail', to: HOME_PATH, icon: Mail, labelKey: 'shell.menu.mail' },
  { id: 'contacts', to: CONTACTS_PATH, icon: Users, labelKey: 'shell.menu.contacts' },
  { id: 'calendar', to: CALENDAR_PATH, icon: CalendarDays, labelKey: 'shell.menu.calendar' },
  { id: 'files', to: FILES_PATH, icon: FolderOpen, labelKey: 'shell.menu.files' },
  { id: 'settings', to: settingsPath(), icon: Settings, labelKey: 'shell.menu.settings' },
]

export function PrimaryNav() {
  const { t } = useTranslation()
  const route = useRoute()

  return (
    <nav className={styles.primaryNav} aria-label={t('shell.nav')}>
      {ITEMS.map(({ id, to, icon: Icon, labelKey }) => (
        <Link
          key={id}
          to={to}
          className={styles.primaryNavItem}
          {...(route.id === id ? { 'aria-current': 'page' as const } : {})}
        >
          <Icon aria-hidden="true" className={styles.primaryNavIcon} />
          <span>{t(labelKey)}</span>
        </Link>
      ))}
    </nav>
  )
}

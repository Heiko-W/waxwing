/** Public router surface (M1.4, ADR-007). */

export type { NavigateOptions, Router } from './context'
export { useNavigate, useRoute, useRouter } from './hooks'
export { Link, type LinkProps } from './Link'
export { RouterProvider, type RouterProviderProps } from './RouterProvider'
export {
  ACCOUNT_PARAM,
  CONTACTS_PATH,
  contactsPath,
  deriveBase,
  HOME_PATH,
  isReadingHistoryEntry,
  mailHrefKeepingQuery,
  mailPath,
  matchRoute,
  READING_HISTORY_MARK,
  type RouteId,
  type RouteMatch,
  settingsPath,
  toHref,
  toPath,
} from './route'

/** Public router surface (M1.4, ADR-007). */

export type { NavigateOptions, Router } from './context'
export { useNavigate, useRoute, useRouter, useRouterOptional } from './hooks'
export { Link, type LinkProps } from './Link'
export { RouterProvider, type RouterProviderProps } from './RouterProvider'
export {
  ACCOUNT_PARAM,
  atMailRoot,
  CALENDAR_PATH,
  CONTACTS_ALL_BOOKS,
  CONTACTS_PATH,
  calendarPath,
  contactsPath,
  deriveBase,
  FILES_PATH,
  FULL_PARAM,
  HOME_PATH,
  isReadingHistoryEntry,
  mailFullPath,
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

import { ContactsScreen } from './ContactsScreen'

/**
 * Contacts route screen (M4.2, lazy chunk). Default export so `React.lazy(() => import(...))` in
 * {@link ../app/shell/AppShell} can load it — the whole contacts area (and its jscontact field
 * rendering) stays out of the initial bundle. The frame lives in {@link ContactsScreen}.
 */
export default function ContactsPage() {
  return <ContactsScreen />
}

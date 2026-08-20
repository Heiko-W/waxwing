/**
 * Saved searches in the sidebar (M5.5, FR-SRCH-03).
 *
 * They sit below the folder tree and behave like folders in the one way that matters — click and
 * you are looking at those messages — while being visibly not folders: no counts, no drop target,
 * no rights. A saved search has no unread count because computing one would mean running every
 * saved query on every sync, which is a cost the user did not ask for by naming a search.
 */

import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useRoute } from '../../app/route'
import { setPref, useLocalPref, useReplica } from '../../sync'
import { IconButton } from '../../ui'
import {
  coerceSavedSearches,
  removeSavedSearch,
  SAVED_SEARCH_PREF_KEY,
  type SavedSearch,
} from './saved-searches'
import styles from './saved-searches.module.css'

export function SavedSearchList() {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const navigate = useNavigate()
  const route = useRoute()
  const searches = coerceSavedSearches(useLocalPref<unknown>(SAVED_SEARCH_PREF_KEY))

  if (searches.length === 0) return null

  const open = (saved: SavedSearch): void => {
    const params = new URLSearchParams({ q: saved.query, scope: saved.scope })
    navigate(`${route.path}?${params.toString()}`)
  }

  const forget = async (id: string): Promise<void> => {
    await setPref(db, accountId, SAVED_SEARCH_PREF_KEY, removeSavedSearch(searches, id))
  }

  const activeQuery = route.search.get('q')

  return (
    <nav className={styles.saved} aria-label={t('search.saved.title')}>
      <h3 className={styles.savedTitle}>{t('search.saved.title')}</h3>
      <ul className={styles.savedList}>
        {searches.map((saved) => (
          <li key={saved.id} className={styles.savedRow}>
            <button
              type="button"
              className={styles.savedButton}
              aria-current={activeQuery === saved.query ? 'true' : undefined}
              onClick={() => open(saved)}
            >
              <Search aria-hidden="true" className={styles.savedIcon} />
              <span className={styles.savedName} title={saved.name}>
                {saved.name}
              </span>
            </button>
            <IconButton
              label={t('search.saved.forget', { name: saved.name })}
              variant="ghost"
              size="sm"
              onClick={() => void forget(saved.id)}
            >
              <X />
            </IconButton>
          </li>
        ))}
      </ul>
    </nav>
  )
}

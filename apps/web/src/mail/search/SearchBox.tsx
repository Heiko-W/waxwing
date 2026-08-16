/**
 * The search entry (M3.1): a `role="search"` field bound to the URL `q` (debounced replace on type,
 * push on submit), a scope control (this folder / all mailboxes), a clear button, and a removable
 * chip strip derived from the parsed operators. All state lives in the URL via {@link useSearch}, so
 * the box and its chips can never drift.
 */

import { Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, Select, VisuallyHidden } from '../../ui'
import styles from './search.module.css'
import type { SearchScope, SearchState } from './use-search'

/** Stable id so the `/` shortcut (AppShell) can focus the box. */
export const SEARCH_INPUT_ID = 'waxwing-search-input'

const DEBOUNCE_MS = 200

export function SearchBox({ search }: { readonly search: SearchState }) {
  const { t } = useTranslation()
  const [input, setInput] = useState(search.q)
  const timerRef = useRef<number | undefined>(undefined)
  const chipsId = useId()
  const hintId = useId()
  // Always describe the box with the operator hint, plus a COUNT of the active filters when there
  // are any (B20.7). The chips list itself used to be the description, so focusing the field read
  // out every filter in full — and the list carried the field's own name on top of that, leaving
  // two different things answering to "Search". The list is navigable in its own right; a
  // description only needs to say that it is there.
  const countId = useId()
  const describedBy = [hintId, search.chips.length > 0 ? countId : undefined]
    .filter(Boolean)
    .join(' ')

  // Sync the local input when the URL q changes externally (chip removal / clear / navigation).
  useEffect(() => setInput(search.q), [search.q])
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const onInput = (value: string): void => {
    setInput(value)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    // Debounced REPLACE so keystrokes don't spam history; submit (Enter) pushes below.
    timerRef.current = window.setTimeout(
      () => search.setQuery(value, { replace: true }),
      DEBOUNCE_MS,
    )
  }

  const submit = (): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    search.setQuery(input)
  }

  return (
    <search className={styles.box}>
      <form
        className={styles.field}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Search aria-hidden="true" className={styles.icon} />
        <input
          id={SEARCH_INPUT_ID}
          type="search"
          className={styles.input}
          value={input}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          aria-describedby={describedBy}
          onChange={(event) => onInput(event.target.value)}
        />
        <VisuallyHidden id={hintId}>{t('search.hint')}</VisuallyHidden>
        {search.chips.length > 0 && (
          <VisuallyHidden id={countId}>
            {t('search.chipsCount', { count: search.chips.length })}
          </VisuallyHidden>
        )}
        <Select
          className={styles.scope}
          aria-label={t('search.scope.label')}
          value={search.scope}
          onChange={(event) => search.setScope(event.target.value as SearchScope)}
        >
          <option value="folder">{t('search.scope.folder')}</option>
          <option value="all">{t('search.scope.all')}</option>
        </Select>
        {search.active && (
          <IconButton
            label={t('search.clear')}
            variant="ghost"
            size="sm"
            onClick={() => {
              setInput('')
              search.clear()
            }}
          >
            <X />
          </IconButton>
        )}
      </form>
      {search.chips.length > 0 && (
        <ul id={chipsId} className={styles.chips} aria-label={t('search.chipsLabel')}>
          {search.chips.map((chip) => (
            <li key={chip.index} className={styles.chip}>
              <span className={styles.chipLabel}>{chip.label}</span>
              <IconButton
                label={t('search.chip.remove', { filter: chip.label })}
                variant="ghost"
                size="sm"
                onClick={() => search.removeChip(chip.index)}
              >
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </search>
  )
}

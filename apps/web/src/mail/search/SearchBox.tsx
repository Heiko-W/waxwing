/**
 * The search entry (M3.1): a `role="search"` field bound to the URL `q` (debounced replace on type,
 * push on submit), a scope control (this folder / all mailboxes), a clear button, and a removable
 * chip strip derived from the parsed operators. All state lives in the URL via {@link useSearch}, so
 * the box and its chips can never drift.
 */

import { Bookmark, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setPref, useLocalPrefOptional, useReplicaOptional } from '../../sync'
import { IconButton, Select, VisuallyHidden } from '../../ui'
import {
  addSavedSearch,
  coerceSavedSearches,
  defaultName,
  findByQuery,
  SAVED_SEARCH_PREF_KEY,
} from './saved-searches'
import styles from './search.module.css'
import type { SearchScope, SearchState } from './use-search'

/** Stable id so the `/` shortcut (AppShell) can focus the box. */
export const SEARCH_INPUT_ID = 'waxwing-search-input'

const DEBOUNCE_MS = 200

export function SearchBox({ search }: { readonly search: SearchState }) {
  const { t } = useTranslation()
  // The OPTIONAL forms: this box is unit-tested on its own, without a replica, and a settings-backed
  // convenience must never be a reason for the search bar to crash.
  const replica = useReplicaOptional()
  const savedSearches = coerceSavedSearches(useLocalPrefOptional<unknown>(SAVED_SEARCH_PREF_KEY))
  /** The entry matching what is on screen; its presence is what disables the save control. */
  const saved = findByQuery(savedSearches, search.q, search.scope)
  const saveCurrent = async (): Promise<void> => {
    if (replica === null || search.q.trim() === '' || saved !== undefined) return
    await setPref(
      replica.db,
      replica.accountId,
      SAVED_SEARCH_PREF_KEY,
      addSavedSearch(savedSearches, {
        id: crypto.randomUUID(),
        name: defaultName(search.q),
        query: search.q,
        scope: search.scope,
      }),
    )
  }
  const [input, setInput] = useState(search.q)
  const timerRef = useRef<number | undefined>(undefined)
  const scopeId = useId()
  const [focused, setFocused] = useState(false)
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

  /** The scope picker earns its row once a query exists, or while the user is composing one. */
  const scopeVisible = search.active || focused || input !== ''

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
          onFocus={() => setFocused(true)}
          // A blur INTO the scope picker must not collapse the row the user is reaching for.
          onBlur={(event) => {
            const next = event.relatedTarget
            if (next instanceof Node && event.currentTarget.closest('search')?.contains(next))
              return
            setFocused(false)
          }}
        />
        {search.chips.length > 0 && (
          <VisuallyHidden id={countId}>
            {t('search.chipsCount', { count: search.chips.length })}
          </VisuallyHidden>
        )}
        {/* Inside the field, not after it. As a sibling it was pushed onto a line of its own by the
            wrapping row — a full-width strip holding one unlabelled ✕, which reads as "close this
            bar" rather than "clear this query". `.clear` positions it over the input's trailing
            edge, where the native cancel button it replaces used to sit. */}
        {search.active && (
          <IconButton
            className={styles.clear}
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
      {/*
        The scope picker only exists once there is something to scope.
        It used to render unconditionally — a full-width "This folder" dropdown sitting above every
        folder, 52 px on a phone, filtering nothing while the field was empty. Only the clear button
        beside it was ever gated on `search.active`; this now follows the same rule, plus focus so
        the choice is reachable before submitting.
      */}
      {scopeVisible && (
        <div className={styles.scopeRow}>
          {/* Saving is offered only for a query that HAS results to save (FR-SRCH-03), and it names
              itself after the query — naming it is a rename away in the sidebar. */}
          {replica !== null && (
            <IconButton
              label={saved === undefined ? t('search.saved.save') : t('search.saved.saved')}
              variant="ghost"
              size="sm"
              disabled={saved !== undefined}
              onClick={() => void saveCurrent()}
            >
              <Bookmark />
            </IconButton>
          )}
          <label className={styles.scopeLabel} htmlFor={scopeId}>
            {t('search.scope.label')}
          </label>
          <Select
            id={scopeId}
            className={styles.scope}
            value={search.scope}
            onChange={(event) => search.setScope(event.target.value as SearchScope)}
          >
            <option value="folder">{t('search.scope.folder')}</option>
            {/* "All mailboxes" leaves Trash and Junk out (B-2) — the same default Apple Mail ships.
                The third entry is the way back in, and it names what it adds rather than hiding
                behind a preference: two words the reader can compare against the line above. */}
            <option value="all">{t('search.scope.all')}</option>
            <option value="everywhere">{t('search.scope.everywhere')}</option>
          </Select>
        </div>
      )}
      {/* The operator hint was `VisuallyHidden`, so the one group that could have discovered this
          syntax by reading it never saw it. Shown while the field has focus: no cost at rest, and
          it is on screen exactly when someone is deciding what to type. */}
      {/* One paragraph, two sentences. The second names the boolean syntax (M-3) — the only place
          in the app that mentions `-` and `OR`, and deliberately the quietest: it is set smaller and
          muted, it appears only while the field has focus, and someone who never reads it can use
          every other operator without ever meeting a language. Kept INSIDE the hint element rather
          than beside it so the field keeps exactly one description (B20.7). */}
      <p id={hintId} className={focused ? styles.hint : styles.hintHidden}>
        {t('search.hint')}
        <span className={styles.hintAdvanced}>{t('search.hintAdvanced')}</span>
      </p>
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

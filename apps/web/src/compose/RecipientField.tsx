/**
 * One recipient field (To/Cc/Bcc) — an APG editable combobox with a roving-tabindex pill strip
 * (M2.4, FR-CMP-05). Typed text commits to pills on Enter / comma / semicolon / Tab; Backspace on an
 * empty input removes the last pill; ArrowLeft from the empty input steps into the pills (each pill
 * is keyboard-removable and can be moved to another field via its menu). Suggestions come from an
 * injected {@link RecipientSuggestionSource} and render as a listbox with `aria-activedescendant`.
 * Keyboard-only operable is a hard requirement.
 */

import type { EmailAddress, Id } from '@waxwing/jmap'
import { Ellipsis, UsersRound, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useContactPhoto } from '../contacts/use-contact-photo'
import { Avatar, Menu, VisuallyHidden } from '../ui'
import { formatAddress, isPlausibleEmail, parseAddressList } from './address-validation'
import type { RecipientField as RecipientFieldName } from './composer-store'
import styles from './recipient-field.module.css'
import {
  type AddressSuggestion,
  type RecipientSuggestion,
  type RecipientSuggestionSource,
  suggestionAddresses,
  suggestionKey,
} from './recipient-suggestions'

const SUGGEST_DEBOUNCE_MS = 120
const SUGGEST_LIMIT = 6

const FIELD_LABEL_KEY: Record<RecipientFieldName, string> = {
  to: 'compose.toLabel',
  cc: 'compose.ccLabel',
  bcc: 'compose.bccLabel',
}

export interface RecipientFieldProps {
  readonly field: RecipientFieldName
  readonly label: string
  readonly value: EmailAddress[]
  readonly source: RecipientSuggestionSource
  /** Account for loading a suggestion's contact photo (M4.3); absent → initials-only (e.g. tests). */
  readonly accountId?: Id | undefined
  readonly onChange: (addrs: EmailAddress[]) => void
  readonly onMove: (index: number, to: RecipientFieldName) => void
  readonly otherFields: readonly RecipientFieldName[]
}

export function RecipientField({
  field: _field,
  label,
  value,
  source,
  accountId,
  onChange,
  onMove,
  otherFields,
}: RecipientFieldProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([])
  const [activePill, setActivePill] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const listboxId = useId()
  const optionId = (index: number): string => `${listboxId}-opt-${index}`

  /**
   * Keep the active suggestion in view (M4.7, WCAG 2.4.7) — the listbox is a clipped scroller and
   * focus stays on the input, so the highlight is the only cue for what Enter will commit. Same fix
   * and same reasoning as the command palette; by id, because the options already carry stable ones
   * for `aria-activedescendant`.
   */
  useEffect(() => {
    if (!open || activeIndex < 0) return
    // The id is built inline from the stable `listboxId` rather than through `optionId`, which is a
    // fresh closure on every render and would make this effect re-run for nothing.
    document.getElementById(`${listboxId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, listboxId])

  // Debounced suggestion query (guards against out-of-order resolves via `cancelled`).
  useEffect(() => {
    const needle = text.trim()
    if (needle === '') {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void source.query(needle, SUGGEST_LIMIT).then((results) => {
        if (cancelled) return
        setSuggestions(results)
        setOpen(results.length > 0)
        setActiveIndex(-1)
      })
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [text, source])

  // Outside press closes the listbox.
  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const clearInput = (): void => {
    setText('')
    setOpen(false)
    setActiveIndex(-1)
    setSuggestions([])
  }

  const commitAddresses = (additions: EmailAddress[]): void => {
    const seen = new Set(value.map((address) => address.email.toLowerCase()))
    const fresh: EmailAddress[] = []
    for (const address of additions) {
      const key = address.email.toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      fresh.push(address)
    }
    if (fresh.length > 0) onChange([...value, ...fresh])
  }

  const commitText = (raw: string): void => {
    commitAddresses(parseAddressList(raw))
    clearInput()
  }

  const commitSuggestion = (suggestion: RecipientSuggestion): void => {
    // One address, or a whole group's members (A-4). `suggestionAddresses` also strips the
    // display-only `photo` reference, which is never stored on a recipient.
    commitAddresses(suggestionAddresses(suggestion))
    clearInput()
    inputRef.current?.focus()
  }

  const removePill = (index: number): void => {
    onChange(value.filter((_, position) => position !== index))
  }

  const focusPill = (index: number): void => {
    setActivePill(index)
    pillRefs.current[index]?.focus()
  }

  const backToInput = (): void => {
    setActivePill(-1)
    inputRef.current?.focus()
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'Enter':
        event.preventDefault()
        if (open && activeIndex >= 0 && suggestions[activeIndex]) {
          commitSuggestion(suggestions[activeIndex])
        } else {
          commitText(text)
        }
        break
      case ',':
      case ';':
        event.preventDefault()
        commitText(text)
        break
      case 'ArrowDown':
        if (suggestions.length > 0) {
          event.preventDefault()
          setOpen(true)
          setActiveIndex((index) => (index + 1) % suggestions.length)
        }
        break
      case 'ArrowUp':
        if (suggestions.length > 0) {
          event.preventDefault()
          setOpen(true)
          setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
        }
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
          // The innermost dismissible layer CONSUMES Escape (APG). Without this the same event
          // bubbles to the composer window, which minimizes unconditionally — so one Escape both
          // dismissed the autocomplete and collapsed the window, in the middle of typing an address.
          // The portalled Menu/Dialog overlays are immune because `useDismiss` stops the event in
          // the capture phase; this listbox is a plain child and has to say so itself.
          event.stopPropagation()
          setOpen(false)
        }
        break
      case 'Backspace':
        if (text === '' && value.length > 0) {
          event.preventDefault()
          removePill(value.length - 1)
        }
        break
      case 'ArrowLeft':
        if (text === '' && value.length > 0 && inputRef.current?.selectionStart === 0) {
          event.preventDefault()
          focusPill(value.length - 1)
        }
        break
      case 'Tab':
        if (text.trim() !== '') commitText(text)
        break
      default:
        break
    }
  }

  function onPillKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case 'ArrowLeft':
        if (index > 0) {
          event.preventDefault()
          focusPill(index - 1)
        }
        break
      case 'ArrowRight':
        event.preventDefault()
        if (index < value.length - 1) focusPill(index + 1)
        else backToInput()
        break
      case 'Backspace':
      case 'Delete':
      case 'Enter':
      case ' ':
        event.preventDefault()
        removePill(index)
        backToInput()
        break
      default:
        break
    }
  }

  return (
    <div className={styles.field} ref={rootRef}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div className={styles.pills}>
        {value.map((address, index) => {
          const invalid = !isPlausibleEmail(address.email)
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: pills identify by email+position; order is stable within a field
              key={`${address.email}-${index}`}
              className={invalid ? `${styles.pill} ${styles.pillInvalid}` : styles.pill}
              title={invalid ? t('compose.recipientInvalid') : formatAddress(address)}
            >
              <span className={styles.pillText}>{address.name || address.email}</span>
              {invalid && <VisuallyHidden>{t('compose.recipientInvalid')}</VisuallyHidden>}
              {otherFields.length > 0 && (
                <Menu
                  triggerLabel={t('compose.recipientMoveMenu')}
                  trigger={<Ellipsis aria-hidden="true" className={styles.pillIcon} />}
                  // Roving with the remove button beside it, NOT fixed at -1 (M4.7, WCAG 2.1.1).
                  // Hard-wired to -1 the trigger sat in no tab order and nothing ever focused it —
                  // `focusPill` walks only `pillRefs`, which are the remove buttons — so "move this
                  // recipient to another field" was pointer-only, contradicting this file's own
                  // docstring. The active pill now offers both its actions to Tab; the arrow keys
                  // keep moving BETWEEN pills.
                  triggerTabIndex={activePill === index ? 0 : -1}
                  items={otherFields.map((other) => ({
                    id: other,
                    label: t('compose.recipientMoveTo', { field: t(FIELD_LABEL_KEY[other]) }),
                    onSelect: () => onMove(index, other),
                  }))}
                />
              )}
              <button
                type="button"
                ref={(element) => {
                  pillRefs.current[index] = element
                }}
                className={styles.pillRemove}
                tabIndex={activePill === index ? 0 : -1}
                aria-label={t('compose.recipientRemove', { address: address.email })}
                onKeyDown={(event) => onPillKeyDown(event, index)}
                onClick={() => removePill(index)}
              >
                <X aria-hidden="true" className={styles.pillIcon} />
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-labelledby={labelId}
          {...(open && activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
          value={text}
          tabIndex={activePill === -1 ? 0 : -1}
          onChange={(event) => {
            setText(event.target.value)
            setActivePill(-1)
          }}
          onKeyDown={onInputKeyDown}
        />
      </div>
      {/* APG combobox listbox: options aren't tab stops — focus stays on the input and moves via
          aria-activedescendant. Generic <div>s carry the roles so the list/option semantics are
          explicit without the interactive-focus rules that assume tabbable options. */}
      <div
        className={styles.listbox}
        id={listboxId}
        role="listbox"
        aria-label={label}
        hidden={!open}
      >
        {open &&
          suggestions.map((suggestion, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive: APG activedescendant options are not focusable by design
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: options are a transient ranked slice
              key={`${suggestionKey(suggestion)}-${index}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={
                index === activeIndex ? `${styles.option} ${styles.optionActive}` : styles.option
              }
              onMouseDown={(event) => {
                event.preventDefault()
                commitSuggestion(suggestion)
              }}
            >
              {suggestion.kind === 'group' ? (
                // A group is a set, not a face: the glyph says so, and the second line says how
                // many pills Enter is about to add — the one thing the reader cannot see otherwise.
                <>
                  <span className={styles.optionGroupIcon}>
                    <UsersRound aria-hidden="true" />
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{suggestion.name}</span>
                    <span className={styles.optionEmail}>
                      {t('compose.recipientGroupMembers', { count: suggestion.members.length })}
                    </span>
                  </span>
                </>
              ) : (
                <>
                  {accountId !== undefined && suggestion.photo !== undefined ? (
                    <OptionAvatar accountId={accountId} suggestion={suggestion} />
                  ) : (
                    <Avatar name={suggestion.name || suggestion.email} size="sm" />
                  )}
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{suggestion.name || suggestion.email}</span>
                    {suggestion.name !== null && suggestion.name !== '' && (
                      <span className={styles.optionEmail}>{suggestion.email}</span>
                    )}
                  </span>
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

/**
 * The avatar for a suggestion that carries a contact photo. A separate component because the photo
 * load is a HOOK ({@link useContactPhoto}) and hooks cannot run inside the options `.map`; it is
 * mounted only when there is a photo to load, so a plain recents suggestion never touches the blob
 * cache. Falls back to initials while the blob resolves (or if it fails).
 */
function OptionAvatar({ accountId, suggestion }: { accountId: Id; suggestion: AddressSuggestion }) {
  const photoSrc = useContactPhoto(accountId, suggestion.photo)
  const name = suggestion.name || suggestion.email
  return <Avatar name={name} size="sm" {...(photoSrc !== undefined ? { photoSrc } : {})} />
}

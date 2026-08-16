/**
 * The command palette (M3.8, FR-UI-04): ⌘K → type → Enter. It reaches every enabled registry action,
 * every folder, every label and the two secondary areas, ranked by a fuzzy score plus a recency boost
 * so the thing you did last is the thing you land on.
 *
 * It is an APG combobox (input + `aria-activedescendant` over a non-focusable `role="listbox"`) inside
 * the shared {@link Dialog}, which brings the focus trap, the focus restore, the scroll lock and the
 * Escape handling with it — the same pattern the recipient field already uses.
 *
 * LAZY: `default` export, mounted via `lazy(() => import('./CommandPalette'))`. This module and its
 * matcher must never enter the entry chunk.
 */

import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../ui'
import { fuzzyMatch } from './fuzzy'
import { formatChord, isApplePlatform, matchesChord } from './keys'
import { usePaletteRecents } from './recents'
import styles from './shortcuts.module.css'
import { GROUP_ORDER, type ShortcutContext, type ShortcutGroup } from './types'
import { type PaletteItem, usePaletteItems } from './use-palette-items'

/** How strongly a recent item outranks a fresh one; earlier entries in the list boost more. */
const RECENT_BOOST = 40

interface RankedItem {
  readonly item: PaletteItem
  /** Indices in `item.label` to wrap in `<mark>` (empty for an unfiltered list). */
  readonly positions: readonly number[]
}

interface PaletteSection {
  readonly key: string
  /** `null` = no header (the flat, score-ordered result list of a non-empty query). */
  readonly title: string | null
  readonly items: readonly RankedItem[]
}

function rank(
  items: readonly PaletteItem[],
  query: string,
  recents: readonly string[],
): readonly RankedItem[] {
  const scored: { readonly entry: RankedItem; readonly score: number; readonly order: number }[] =
    []
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, item.label)
    if (match === null) return
    const recentIndex = recents.indexOf(item.id)
    const boost = recentIndex >= 0 ? RECENT_BOOST - recentIndex : 0
    scored.push({
      entry: { item, positions: match.positions },
      score: match.score + boost,
      order,
    })
  })
  // Stable: equal scores keep registry/folder/label order.
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.order - b.order))
  return scored.map((row) => row.entry)
}

function sections(
  items: readonly PaletteItem[],
  query: string,
  recents: readonly string[],
  groupTitle: (group: ShortcutGroup) => string,
  recentTitle: string,
): readonly PaletteSection[] {
  if (query.trim() !== '') {
    const ranked = rank(items, query, recents)
    return ranked.length === 0 ? [] : [{ key: 'results', title: null, items: ranked }]
  }

  // Empty query: recents first (in stored order), then everything else in group order.
  const byId = new Map(items.map((item) => [item.id, item]))
  const recentItems: RankedItem[] = []
  for (const id of recents) {
    const item = byId.get(id)
    if (item !== undefined) recentItems.push({ item, positions: [] })
  }
  const recentIds = new Set(recentItems.map((entry) => entry.item.id))

  const out: PaletteSection[] = []
  if (recentItems.length > 0) out.push({ key: 'recent', title: recentTitle, items: recentItems })
  for (const group of GROUP_ORDER) {
    const groupItems = items
      .filter((item) => item.group === group && !recentIds.has(item.id))
      .map<RankedItem>((item) => ({ item, positions: [] }))
    if (groupItems.length > 0) {
      out.push({ key: group, title: groupTitle(group), items: groupItems })
    }
  }
  return out
}

/** Wrap the fuzzy-matched characters of `label` in `<mark>`. */
function highlight(label: string, positions: readonly number[]): ReactNode {
  if (positions.length === 0) return label
  const marked = new Set(positions)
  const nodes: ReactNode[] = []
  let run = ''
  let runMarked = false
  const flush = (index: number): void => {
    if (run === '') return
    nodes.push(runMarked ? <mark key={index}>{run}</mark> : <Fragment key={index}>{run}</Fragment>)
    run = ''
  }
  for (let index = 0; index < label.length; index += 1) {
    const isMarked = marked.has(index)
    if (isMarked !== runMarked) {
      flush(index)
      runMarked = isMarked
    }
    run += label[index] ?? ''
  }
  flush(label.length)
  return nodes
}

export interface CommandPaletteProps {
  readonly context: ShortcutContext
  readonly onClose: () => void
}

export default function CommandPalette({ context, onClose }: CommandPaletteProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const baseId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const items = usePaletteItems(context)
  const { recents, push } = usePaletteRecents()
  const apple = useMemo(() => isApplePlatform(), [])

  const grouped = useMemo(
    () =>
      sections(
        items,
        query,
        recents,
        (group) => t(`shortcuts.groups.${group}`),
        t('palette.recent'),
      ),
    [items, query, recents, t],
  )
  const flat = useMemo(() => grouped.flatMap((section) => section.items), [grouped])
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1)
  const optionId = (index: number): string => `${baseId}-o-${index}`

  function runItem(item: PaletteItem): void {
    push(item.id)
    item.run()
    onClose()
  }

  /**
   * Keep the active option in view (M4.7, WCAG 2.4.7).
   *
   * The listbox is a clipped scroller, and with an empty query it lists recents plus every registry
   * action, folder and label — far more than fits. Focus stays on the input, so the ONLY cue for
   * what Enter will run is the highlighted row; arrowing past the fold (or wrapping from the top to
   * the last item) left that highlight off-screen and the user looking at nothing.
   *
   * By id rather than a ref map: the options already carry stable ids for `aria-activedescendant`,
   * so there is no second bookkeeping to keep in step. `block: 'nearest'` scrolls only when it must,
   * and the default instant behaviour respects reduced motion by not animating at all.
   *
   * NOT unit-tested, deliberately: jsdom implements no layout, so nothing there can distinguish "in
   * view" from "off-screen" — a test could only assert that `scrollIntoView` was called, which
   * restates the line rather than checking it. Verifying this needs a real browser; it belongs with
   * the browser-level a11y sweep ADR-015 already defers.
   */
  useEffect(() => {
    if (activeIndex < 0) return
    // Built inline from the stable `baseId` rather than through `optionId`, which is a fresh closure
    // each render and would make this effect re-run for nothing.
    document.getElementById(`${baseId}-o-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, baseId])

  function move(delta: number): void {
    if (flat.length === 0) return
    setActive((current) => {
      const from = Math.min(current, flat.length - 1)
      return (from + delta + flat.length) % flat.length
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // ⌘K again closes the palette (Escape is the Dialog's, via the shared dismiss stack).
    if (matchesChord(event.nativeEvent, 'Mod+k')) {
      event.preventDefault()
      onClose()
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(Math.max(0, flat.length - 1))
        break
      case 'Enter': {
        event.preventDefault()
        const entry = flat[activeIndex]
        if (entry !== undefined) runItem(entry.item)
        break
      }
    }
  }

  let index = -1
  return (
    <Dialog open onClose={onClose} title={t('palette.title')} size="md" initialFocusRef={inputRef}>
      <div className={styles.palette}>
        <input
          ref={inputRef}
          type="text"
          className={styles.paletteInput}
          role="combobox"
          // NOT a constant (B20.4). `aria-expanded` describes whether the listbox is showing
          // options; a query that matches nothing leaves an empty listbox, and claiming it is still
          // expanded tells a screen reader there are results to arrow through when there are none —
          // right as `aria-activedescendant` also disappears, so the user hears nothing at all.
          aria-expanded={flat.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={t('palette.placeholder')}
          placeholder={t('palette.placeholder')}
          {...(activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        {/* APG combobox listbox: the options are not tab stops — focus stays on the input and moves
            via aria-activedescendant, so generic <div>s carry the roles (the RecipientField pattern). */}
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('palette.title')}
          className={styles.listbox}
        >
          {grouped.map((section) => (
            <Fragment key={section.key}>
              {section.title !== null && (
                <div role="presentation" className={styles.groupHeader}>
                  {section.title}
                </div>
              )}
              {section.items.map((entry) => {
                index += 1
                const position = index
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive: APG activedescendant options are not focusable by design
                  <div
                    key={entry.item.id}
                    id={optionId(position)}
                    role="option"
                    aria-selected={position === activeIndex}
                    className={
                      position === activeIndex
                        ? `${styles.option} ${styles.optionActive}`
                        : styles.option
                    }
                    onMouseDown={(event) => {
                      event.preventDefault()
                      runItem(entry.item)
                    }}
                  >
                    <span className={styles.optionLabel}>
                      {highlight(entry.item.label, entry.positions)}
                    </span>
                    {entry.item.keys[0] !== undefined && (
                      <span className={styles.optionKeys}>
                        {formatChord(entry.item.keys[0], apple).map((part) => (
                          <kbd key={part} className={styles.kbd}>
                            {part}
                          </kbd>
                        ))}
                      </span>
                    )}
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>
        {/* A live region, so "No matches." is SPOKEN. It used to be a plain <p>: sighted users saw
            it, everyone else typed into a silence indistinguishable from a broken palette. */}
        {flat.length === 0 && (
          <p role="status" className={styles.empty}>
            {t('palette.empty')}
          </p>
        )}
      </div>
    </Dialog>
  )
}

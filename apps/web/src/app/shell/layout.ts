/**
 * Responsive layout model for the app shell (M1.4, FR-UI-03, FR-LST-07 layout half).
 *
 * Presentation (3→2→1 pane collapse, folder rail vs. drawer, sizing) is owned by CSS media
 * queries in shell.module.css; exactly one structural decision is JS-driven — whether the
 * message list and reading pane coexist inside a resizable {@link SplitPane} or the shell
 * shows a single route-swapped pane. `computePaneLayout` is that pure decision. The two
 * breakpoints in {@link BP} are MIRRORED verbatim in the CSS; keep them in sync.
 */

import { useSyncExternalStore } from 'react'
import type { SplitOrientation } from '../../ui'

/** Breakpoints in `em`, mirrored in shell.module.css `@media (min-width: …)`. */
export const BP = { tabletEm: 40, desktopEm: 64 } as const

export type LayoutTier = 'phone' | 'tablet' | 'desktop'
export type ReadingPaneMode = 'right' | 'bottom' | 'off'
export const READING_PANE_MODES: readonly ReadingPaneMode[] = ['right', 'bottom', 'off']

export interface PaneLayout {
  readonly tier: LayoutTier
  readonly mode: ReadingPaneMode
  /** List & reading coexist inside a SplitPane (desktop/tablet with a non-`off` mode). */
  readonly split: boolean
  /** Which pane the shell shows when `!split` — driven by the presence of an open email. */
  readonly singlePane: 'list' | 'reading'
  /** `horizontal` = reading beside the list; `vertical` = reading below it. */
  readonly splitOrientation: SplitOrientation
}

/**
 * Pure layout decision. `off` mode and the phone tier collapse to the same single-pane,
 * route-swapped path: opening a message fills the whole pane and the list is reached via Back.
 */
export function computePaneLayout(
  tier: LayoutTier,
  mode: ReadingPaneMode,
  hasEmail: boolean,
): PaneLayout {
  const split = tier !== 'phone' && mode !== 'off'
  return {
    tier,
    mode,
    split,
    singlePane: hasEmail ? 'reading' : 'list',
    splitOrientation: mode === 'bottom' ? 'vertical' : 'horizontal',
  }
}

/** Classify a viewport width (px) into a tier using {@link BP} (assumes 16px root em). */
export function tierForWidth(widthPx: number): LayoutTier {
  const em = widthPx / 16
  if (em >= BP.desktopEm) return 'desktop'
  if (em >= BP.tabletEm) return 'tablet'
  return 'phone'
}

/**
 * The current layout tier, updated on viewport changes. Defensive by design: where
 * `matchMedia` is absent (jsdom, SSR) it returns a stable `desktop` so component tests need no
 * polyfill; a test wanting a narrower tier stubs `window.matchMedia`.
 */
export function useLayoutTier(): LayoutTier {
  return useSyncExternalStore(subscribeViewport, readTier, () => 'desktop')
}

function readTier(): LayoutTier {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop'
  if (window.matchMedia(`(min-width: ${BP.desktopEm}em)`).matches) return 'desktop'
  if (window.matchMedia(`(min-width: ${BP.tabletEm}em)`).matches) return 'tablet'
  return 'phone'
}

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const queries = [
    window.matchMedia(`(min-width: ${BP.desktopEm}em)`),
    window.matchMedia(`(min-width: ${BP.tabletEm}em)`),
  ]
  for (const query of queries) query.addEventListener('change', onChange)
  return () => {
    for (const query of queries) query.removeEventListener('change', onChange)
  }
}

// ---- Reading-pane mode: a lightweight local preference (localStorage), shared across the
// shell and the settings screen via a tiny external store. Real per-account/windowed prefs
// land with M1.2/M1.6; this is deliberately minimal (mirrors theme.ts's approach).

const READING_PANE_KEY = 'waxwing.readingPane'
const readingPaneListeners = new Set<() => void>()
let readingPaneMode: ReadingPaneMode = readStoredReadingPane()

function isReadingPaneMode(value: string | null): value is ReadingPaneMode {
  return value === 'right' || value === 'bottom' || value === 'off'
}

function readStoredReadingPane(): ReadingPaneMode {
  try {
    const stored = localStorage.getItem(READING_PANE_KEY)
    return isReadingPaneMode(stored) ? stored : 'right'
  } catch {
    return 'right'
  }
}

export function getReadingPaneMode(): ReadingPaneMode {
  return readingPaneMode
}

export function setReadingPaneMode(mode: ReadingPaneMode): void {
  readingPaneMode = mode
  try {
    localStorage.setItem(READING_PANE_KEY, mode)
  } catch {
    // Ignore persistence failures (private mode / storage disabled).
  }
  for (const listener of readingPaneListeners) listener()
}

function subscribeReadingPane(onChange: () => void): () => void {
  readingPaneListeners.add(onChange)
  return () => {
    readingPaneListeners.delete(onChange)
  }
}

/** The current reading-pane mode, re-rendering on change. Default `right`. */
export function useReadingPaneMode(): ReadingPaneMode {
  return useSyncExternalStore(subscribeReadingPane, getReadingPaneMode, () => 'right')
}

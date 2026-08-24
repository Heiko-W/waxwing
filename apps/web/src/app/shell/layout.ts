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
 * The height a split needs before it stops being two cramped strips, in px.
 *
 * An iPhone in landscape is 844 px WIDE, which is the tablet tier by width alone — so it was given
 * the two-pane layout, the side rail instead of the bottom bar, and a second 60 px pane toolbar
 * (`ScreenBar` only supplies the shell-header slot on the phone tier). Measured on 844 × 390:
 * roughly 180 px of bars against 210 px of list. HIG `split-views`, iOS: "A split view needs
 * horizontal space in which to display multiple panes … it's difficult to display multiple panes
 * without wrapping or truncating the content."
 *
 * 34rem = 544 px: below every tablet in either orientation (iPad landscape is 834) and above every
 * phone laid on its side. There was no height condition anywhere in the source tree before this.
 */
export const MIN_SPLIT_BLOCK_PX = 544

/**
 * Pure layout decision. `off` mode and the phone tier collapse to the same single-pane,
 * route-swapped path: opening a message fills the whole pane and the list is reached via Back.
 *
 * `hasBlockRoom` defaults to true so a caller that does not care — and every existing test — sees
 * the behaviour it always had; only the shell passes the measured answer.
 */
export function computePaneLayout(
  tier: LayoutTier,
  mode: ReadingPaneMode,
  hasEmail: boolean,
  hasBlockRoom = true,
): PaneLayout {
  const split = tier !== 'phone' && mode !== 'off' && hasBlockRoom
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
 * Whether the viewport is tall enough for a split to be worth having — see {@link MIN_SPLIT_BLOCK_PX}.
 *
 * Same defensive shape as `useLayoutTier`: where `matchMedia` is absent (jsdom, SSR) it answers
 * `true`, so component tests keep the layout they had and no test needs a polyfill to opt out of a
 * behaviour it never asked about.
 */
export function useSplitBlockRoom(): boolean {
  return useSyncExternalStore(subscribeSplitBlockRoom, readSplitBlockRoom, () => true)
}

function readSplitBlockRoom(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(`(min-height: ${MIN_SPLIT_BLOCK_PX}px)`).matches
}

function subscribeSplitBlockRoom(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(`(min-height: ${MIN_SPLIT_BLOCK_PX}px)`)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * The current layout tier, updated on viewport changes. Defensive by design: where
 * `matchMedia` is absent (jsdom, SSR) it returns a stable `desktop` so component tests need no
 * polyfill; a test wanting a narrower tier stubs `window.matchMedia`.
 */
export function useLayoutTier(): LayoutTier {
  return useSyncExternalStore(subscribeViewport, readTier, () => 'desktop')
}

/**
 * The current tier, read once rather than subscribed to.
 *
 * For the two callers that are not React: the shortcut registry (whose actions are pure data and
 * run outside a render) and anything else that needs the answer at the moment of an event rather
 * than across a render. Components use `useLayoutTier`.
 */
export function getLayoutTier(): LayoutTier {
  return readTier()
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

// ---- Folder rail visibility: the same lightweight local-preference shape as the reading pane
// above, for the same reason (a per-device view choice, not account data).

const FOLDER_RAIL_KEY = 'waxwing.folderRail'
const folderRailListeners = new Set<() => void>()
let folderRailVisible: boolean = readStoredFolderRail()

function readStoredFolderRail(): boolean {
  try {
    // Absent means visible. HIG `sidebars`: "Avoid hiding the sidebar by default to ensure that it
    // remains discoverable" — so only an explicit "false" hides it, and a cleared storage returns
    // to the discoverable state rather than to the last one.
    return localStorage.getItem(FOLDER_RAIL_KEY) !== 'false'
  } catch {
    return true
  }
}

export function getFolderRailVisible(): boolean {
  return folderRailVisible
}

export function setFolderRailVisible(visible: boolean): void {
  folderRailVisible = visible
  try {
    localStorage.setItem(FOLDER_RAIL_KEY, visible ? 'true' : 'false')
  } catch {
    // Ignore persistence failures (private mode / storage disabled).
  }
  for (const listener of folderRailListeners) listener()
}

/** Flip it. The shortcut and the toolbar button share this, so they cannot drift apart. */
export function toggleFolderRail(): void {
  setFolderRailVisible(!folderRailVisible)
}

function subscribeFolderRail(onChange: () => void): () => void {
  folderRailListeners.add(onChange)
  return () => {
    folderRailListeners.delete(onChange)
  }
}

/**
 * Whether the persistent folder rail is showing, re-rendering on change. Default `true`.
 *
 * Only consulted on the desktop tier: below 64em the rail is a drawer with its own open state, and
 * a reader who hid it on a wide window must not find their folders missing on a phone.
 */
export function useFolderRailVisible(): boolean {
  return useSyncExternalStore(subscribeFolderRail, getFolderRailVisible, () => true)
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

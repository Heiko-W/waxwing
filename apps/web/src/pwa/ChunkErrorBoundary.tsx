/**
 * The route error boundary (M3.5). The app had none — and the service worker makes its absence
 * dangerous: the routes are lazy `import()` chunks, and a deploy (Stalwart's Applications
 * auto-update replaces the whole bundle) DELETES the old hashed chunks from the server. A tab that
 * was open across that deploy therefore 404s on its next route navigation, and an unhandled rejection
 * inside `React.lazy` unmounts the tree — a white screen with no way back.
 *
 * So: a chunk-load error self-heals with exactly ONE reload (the new build's index.html points at
 * chunks that exist). A `sessionStorage` one-shot guard makes a reload LOOP impossible — if the
 * reload did not fix it, the second failure renders the panel instead, with the reload left to the
 * user. Any other error renders the panel straight away; we do not reload on errors we don't
 * understand.
 */

import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui'
import styles from './ChunkErrorBoundary.module.css'

/** Per-TAB, so a second tab is unaffected. Holds the timestamp of the last self-heal. */
const RELOAD_GUARD_KEY = 'waxwing.pwa.chunkReload'

/**
 * How long a self-heal suppresses the next one. A genuine reload LOOP (the reload did not fix it)
 * comes back within a second, so this blocks it and the panel takes over. A *second* deploy, hours
 * into the same long-lived tab, is past the cooldown and heals silently — which a plain one-shot flag
 * would not do: it would show the error panel to a user who did nothing wrong.
 */
const RELOAD_COOLDOWN_MS = 60_000

/**
 * A dynamic import that could not be fetched. The message differs per engine — Chromium "Failed to
 * fetch dynamically imported module", Firefox "error loading dynamically imported module", WebKit
 * "Importing a module script failed" — and bundlers additionally tag it `ChunkLoadError`.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ChunkLoadError') return true
  return /dynamically imported module|Importing a module script failed/i.test(error.message)
}

/** Fail CLOSED when storage is unavailable (Safari private mode throws): no guard ⇒ no auto-reload. */
function healedRecently(now: number): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_GUARD_KEY))
    return Number.isFinite(at) && at > 0 && now - at < RELOAD_COOLDOWN_MS
  } catch {
    return true
  }
}

function markHealed(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now))
  } catch {
    // Nothing to do: healedRecently() fails closed, so this tab simply never auto-reloads.
  }
}

export interface ChunkErrorBoundaryProps {
  readonly children: ReactNode
  /**
   * Clears a rendered failure whenever it changes. Without it a boundary that caught ONE error stays
   * failed forever: the route changes underneath it, `screen` becomes a different component, and the
   * panel still sits there — navigation looks dead. Pass the route id.
   */
  readonly resetKey?: string | undefined
  /** Injectable in tests; defaults to a full page reload. */
  readonly reload?: (() => void) | undefined
  /** Injectable in tests; defaults to the wall clock. */
  readonly now?: (() => number) | undefined
}

interface ChunkErrorBoundaryState {
  readonly failed: boolean
}

export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  override state: ChunkErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) return
    const now = (this.props.now ?? Date.now)()
    if (healedRecently(now)) return
    markHealed(now)
    this.reload()
  }

  override componentDidUpdate(previous: ChunkErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false })
    }
  }

  private readonly reload = (): void => {
    const reload = this.props.reload ?? (() => window.location.reload())
    reload()
  }

  override render(): ReactNode {
    if (this.state.failed) return <ChunkErrorFallback onReload={this.reload} />
    return this.props.children
  }
}

function ChunkErrorFallback({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation()
  return (
    <div className={styles.panel} role="alert">
      <h1 className={styles.title}>{t('pwa.error.chunk.title')}</h1>
      <p className={styles.body}>{t('pwa.error.chunk.body')}</p>
      <Button onClick={onReload}>{t('pwa.error.chunk.action')}</Button>
    </div>
  )
}

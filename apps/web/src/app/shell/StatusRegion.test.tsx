import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type EngineStatus, INITIAL_ENGINE_STATUS } from '../../sync/engine'
import { setEngineStatus } from '../../sync/engine/status'
import { expectNoA11yViolations } from '../../test/axe'
import { StatusRegion } from './StatusRegion'

function status(over: Partial<EngineStatus> = {}): void {
  setEngineStatus({ ...INITIAL_ENGINE_STATUS, ...over })
}

/** `StatusRegion` reads connectivity straight from `navigator.onLine`, not from the engine status. */
function setNavigatorOnline(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

afterEach(() => {
  setEngineStatus(INITIAL_ENGINE_STATUS)
  vi.restoreAllMocks()
})

describe('StatusRegion — stuck outbox (M3.3)', () => {
  it('announces a still-retrying queue politely, with a count', () => {
    status({ stuckActions: 2 })
    render(<StatusRegion />)

    const live = screen.getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('Still trying to reach the server (2)')
  })

  it('says nothing when nothing is stuck', () => {
    status({ stuckActions: 0 })
    render(<StatusRegion />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('offline outranks stuck (being offline already explains the stalled queue)', () => {
    setNavigatorOnline(false)
    status({ stuckActions: 3 })
    render(<StatusRegion />)

    expect(screen.getByRole('status')).toHaveTextContent('Offline')
    expect(screen.queryByText(/Still trying/)).not.toBeInTheDocument()
  })

  it('a sync error outranks stuck (it is the more actionable of the two)', () => {
    status({ phase: 'error', error: 'boom', stuckActions: 3 })
    render(<StatusRegion />)

    expect(screen.getByRole('status')).toHaveTextContent('Sync problem')
    expect(screen.queryByText(/Still trying/)).not.toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    status({ stuckActions: 1 })
    const { container } = render(<StatusRegion />)
    await expectNoA11yViolations(container)
  })
})

/**
 * "Is what I am looking at current?" — the question this region could not answer (D-15).
 *
 * `lastSyncedAt` has existed since M1.3: written on every completed pass, shared over the tab bus,
 * and read at exactly two places, both of them as a TRIGGER for something else. No surface showed
 * it. In the idle state this region rendered nothing at all, so the only evidence a reader ever had
 * that the app was still talking to the server was catching the spinner as it went by.
 *
 * HIG `feedback`: "Consider integrating status feedback into your interface. When status feedback is
 * available near the items it describes, people get important information without having to take
 * action or leave their current context. For example, Mail in iOS and iPadOS describes the most
 * recent update … making the information unobtrusive but easy for people to check."
 */
describe('StatusRegion — when the mail last arrived', () => {
  it('says how long ago at rest', () => {
    status({ phase: 'idle', lastSyncedAt: Date.now() - 3 * 60_000 })
    render(<StatusRegion />)
    expect(screen.getByText(/Updated 3 minutes ago/)).toBeInTheDocument()
  })

  it('says nothing before the first pass has finished', () => {
    // `null` is a real state — a cold start before the first sync completes — and "updated never"
    // is not a sentence.
    status({ phase: 'idle', lastSyncedAt: null })
    render(<StatusRegion />)
    expect(screen.queryByText(/Updated/)).toBeNull()
  })

  it('gives way while a sync is running', () => {
    // Two answers to the same question at once ("updated 5 minutes ago" beside "Syncing…") is
    // worse than either alone.
    status({ phase: 'syncing', lastSyncedAt: Date.now() - 5 * 60_000 })
    render(<StatusRegion />)
    expect(screen.getByText('Syncing…')).toBeInTheDocument()
    expect(screen.queryByText(/Updated/)).toBeNull()
  })

  it('gives way to anything that is actually wrong', () => {
    status({ phase: 'error', lastSyncedAt: Date.now() - 60_000 })
    render(<StatusRegion />)
    expect(screen.queryByText(/Updated/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Sync problem')
  })

  it('stays out of the live region', () => {
    // A screen reader repeating "updated 3 minutes ago" every minute would be exactly the noise
    // this file already refuses to make for sync itself.
    status({ phase: 'idle', lastSyncedAt: Date.now() - 3 * 60_000 })
    render(<StatusRegion />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('re-reads the clock as time passes', async () => {
    // Written once, the line lies for the rest of the session — and "just now" an hour later is
    // the same sentence the app would use if it HAD just synced.
    vi.useFakeTimers()
    try {
      status({ phase: 'idle', lastSyncedAt: Date.now() - 60_000 })
      render(<StatusRegion />)
      expect(screen.getByText(/1 minute ago/)).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000)
      })
      expect(screen.getByText(/6 minutes ago/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('StatusRegion — the clock never runs backwards', () => {
  it('reads the clock at render, not at mount', async () => {
    // The tablet defect, exactly: the shell mounts, nine seconds later a sync finishes, and a base
    // captured at mount makes the fresh stamp a FUTURE one — "Updated in 9 seconds", for a whole
    // minute, after every sync. Nothing about "3 minutes ago" can see this.
    vi.useFakeTimers()
    try {
      status({ phase: 'idle', lastSyncedAt: Date.now() - 60_000 })
      render(<StatusRegion />)
      expect(screen.getByText(/1 minute ago/)).toBeInTheDocument()
      // A sync completes nine seconds later, while the ticker has not fired.
      await act(async () => {
        vi.advanceTimersByTime(9_000)
        status({ phase: 'idle', lastSyncedAt: Date.now() })
      })
      expect(screen.queryByText(/\bin\b/), 'the label reported a future').toBeNull()
      expect(screen.getByText(/Updated now/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never says the mail arrived in the FUTURE', () => {
    // `lastSyncedAt` is stamped by the engine when a pass completes; this component reads its own
    // clock when it mounts. A sync finishing a moment after a render puts the stamp ahead of that
    // clock, and Intl.RelativeTimeFormat then says precisely what it was given — "Updated in 1
    // second", which is not a thing that can be true. Found in the visual sweep, not by a test:
    // every assertion about "3 minutes ago" passes while this is broken.
    status({ phase: 'idle', lastSyncedAt: Date.now() + 900 })
    render(<StatusRegion />)
    expect(screen.queryByText(/\bin\b/)).toBeNull()
    expect(screen.getByText(/Updated now/)).toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
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

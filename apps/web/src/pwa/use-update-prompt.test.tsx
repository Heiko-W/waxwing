import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../compose'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import {
  getActiveSwRegistration,
  type RegisterSwDeps,
  resetSwRegistrationState,
} from './register-sw'
import { useUpdatePrompt } from './use-update-prompt'

// The registration seam: the test drives the two callbacks by hand, exactly as a real worker would.
let deps: RegisterSwDeps | null = null
const register = vi.fn(async (received: RegisterSwDeps) => {
  deps = received
  return null
})

const reload = vi.fn()
const activate = vi.fn()

// The draft flush is gated so the test can prove the ordering: it must COMPLETE before `activate`.
let releaseFlush: () => void = () => {}
let flushGate: Promise<void>
const flush = vi.fn(() => flushGate)

function Harness() {
  useUpdatePrompt({ register, reload, draftSync: { flush } })
  return null
}

const renderShell = () =>
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  )

beforeEach(() => {
  deps = null
  vi.clearAllMocks()
  flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  flush.mockImplementation(() => flushGate) // a test may replace this with a rejecting flush
  // Two open drafts with unsaved keystrokes — autosave is a 3 s IDLE debounce, so they are only
  // safe once `flush` has run.
  useComposerStore.getState().openDraft({ id: 'd1', subject: 'half a thought' })
  useComposerStore.getState().openDraft({ id: 'd2', subject: 'and another' })
})

afterEach(() => {
  useComposerStore.getState().closeDraft('d1')
  useComposerStore.getState().closeDraft('d2')
  resetSwRegistrationState()
})

/** What a waiting worker triggers, from inside React's world. */
const updateReady = (): void => {
  act(() => deps?.onUpdateReady(activate))
}

describe('useUpdatePrompt', () => {
  it('offers one STICKY toast when a new build is waiting, and reloads nothing on its own', async () => {
    renderShell()
    updateReady()

    expect(await screen.findByText('An update is ready')).toBeInTheDocument()
    // Sticky (duration 0): nothing but the user dismisses it.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    await expectNoA11yViolations(document.body)
  })

  it('does not stack a second toast when a third build lands while the first offer is up', async () => {
    renderShell()
    updateReady()
    await screen.findByText('An update is ready')
    updateReady()

    expect(screen.getAllByText('An update is ready')).toHaveLength(1)
  })

  it('saves every open draft BEFORE handing over to the new worker', async () => {
    const user = userEvent.setup()
    renderShell()
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Reload' }))

    // Both drafts are being flushed; the hand-over is still waiting on them.
    expect(flush).toHaveBeenCalledWith('d1')
    expect(flush).toHaveBeenCalledWith('d2')
    expect(activate).not.toHaveBeenCalled()

    releaseFlush()
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
  })

  it('reloads the OTHER tabs on `controllerchange` — after saving their drafts', async () => {
    renderShell()
    act(() => deps?.onControllerChange())

    expect(flush).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()

    releaseFlush()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('hands over even when a draft CANNOT be saved — a full disk must not strand the user', async () => {
    // The disk is full (M3.4's storage notifier exists for exactly this state) or the database is
    // closed, so `flush` rejects. The save is best-effort; the update is not. If the rejection
    // swallowed `activate()`, the user would click "Reload", watch the toast vanish, and get nothing
    // — and the offer would never come back.
    flush.mockImplementation(() => Promise.reject(new Error('QuotaExceededError')))
    const user = userEvent.setup()
    renderShell()
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
  })

  it('…and still reloads on `controllerchange` when the flush rejects', async () => {
    // Here it is worse than an annoyance: the new worker already controls this page, so the code it
    // is running is stale and its lazy chunks are gone from the server. Not reloading strands it.
    flush.mockImplementation(() => Promise.reject(new Error('DatabaseClosedError')))
    renderShell()
    act(() => deps?.onControllerChange())

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('offers the NEXT deploy again after the user dismissed the last one', async () => {
    const user = userEvent.setup()
    renderShell()
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('An update is ready')).not.toBeInTheDocument()

    updateReady() // a new build lands later
    expect(await screen.findByText('An update is ready')).toBeInTheDocument()
  })
})

describe('useUpdatePrompt — publishing the registration (M3.6)', () => {
  it('publishes the registration for the notifier, and clears it on unmount', async () => {
    // M3.6 shows every notification through `registration.showNotification()`; `new Notification()`
    // throws on Android Chrome, so a stale or missing registration is not a degraded experience — it
    // is no notifications at all. And it must not outlive the flow that owns it: the browser hands
    // back the SAME registration object, and a stale one would survive a sign-out.
    const registration = { update: vi.fn(async () => {}) } as unknown as ServiceWorkerRegistration
    const dispose = vi.fn()
    const registerReal = vi.fn(async () => ({ registration, dispose }))

    function PublishHarness() {
      useUpdatePrompt({ register: registerReal, reload, draftSync: { flush } })
      return null
    }

    const view = render(
      <ToastProvider>
        <PublishHarness />
      </ToastProvider>,
    )
    await waitFor(() => expect(getActiveSwRegistration()).toBe(registration))

    view.unmount()
    expect(getActiveSwRegistration()).toBeNull()
    expect(dispose).toHaveBeenCalled()
  })
})

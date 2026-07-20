import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../compose'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { freshDb, mailbox } from '../sync/test-utils'
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

function Harness({ deadlineMs }: { deadlineMs?: number } = {}) {
  useUpdatePrompt({
    register,
    reload,
    draftSync: { flush },
    ...(deadlineMs === undefined ? {} : { flushDeadlineMs: deadlineMs }),
  })
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

  it('hands over even when a flush never SETTLES — a blocked database must not freeze the reload', async () => {
    // The third failure mode, and the one `allSettled` alone cannot survive: an IndexedDB request
    // blocked behind another tab's `versionchange` neither resolves nor rejects until that tab
    // closes, which may be never. Without the deadline the user would click "Reload" and sit on a
    // build whose lazy chunks are already gone from the server, with no way forward.
    flush.mockImplementation(() => new Promise<void>(() => {})) // never settles
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Harness deadlineMs={5} />
      </ToastProvider>,
    )
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
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

/**
 * ── THE WIRING, NOT THE SEAM (M3.10) ──────────────────────────────────────────────────────────
 *
 * Every test above injects `deps.draftSync`, which is exactly why the defect this file now guards
 * against shipped and survived five milestones: `useUpdatePrompt` is mounted ABOVE the
 * `ReplicaProvider` (app/App.tsx), so its real `useDraftSync()` read `null` from context and took
 * the no-replica branch, whose `flush` is `async () => {}`. The toast said "Open drafts are saved
 * first" and nothing was ever written — while every test here passed, because none of them used the
 * default. A suite that cannot fail on the production path is not coverage of that path.
 *
 * So these two inject NOTHING and assert against a real Dexie database, and they reproduce the
 * ancestry that caused the bug: the prompt is a SIBLING of the provider, never a descendant. If the
 * flush is ever wired back through React context, the first test here goes red rather than green.
 */
describe('useUpdatePrompt — the REAL draft flush, mounted outside the ReplicaProvider', () => {
  let db: ReplicaDb

  beforeEach(async () => {
    db = freshDb()
    await putMailboxes(db, 'acc-1', [mailbox('mb-d', { role: 'drafts' })])
  })
  afterEach(async () => {
    await db.delete()
  })

  /** The App.tsx shape: the prompt above the gate, the replica provided by a subtree beside it. */
  function RealShell({ withReplica }: { withReplica: boolean }) {
    return (
      <ToastProvider>
        <RealHarness />
        {withReplica ? (
          <ReplicaProvider accountId="acc-1" db={db}>
            <div />
          </ReplicaProvider>
        ) : null}
      </ToastProvider>
    )
  }

  function RealHarness() {
    useUpdatePrompt({ register, reload }) // no `draftSync` — the production default
    return null
  }

  it('writes the open drafts to the local store before handing over to the new worker', async () => {
    const user = userEvent.setup()
    render(<RealShell withReplica={true} />)
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1))

    // The durable local write — `flushDraft`'s AWAITED `putDraft`, the crash-safety guarantee, and
    // the same store the M3.10 deploy E2E reads out of IndexedDB after the reload.
    const rows = await db.drafts.where('accountId').equals('acc-1').toArray()
    expect(rows.map((row) => row.content.subject).sort()).toEqual(['and another', 'half a thought'])
  })

  it('still hands over when there is no replica yet — the sign-in screen has nothing to flush', async () => {
    // The pre-auth case the module-level accessor has to get right. `getActiveReplica()` is `null`
    // here, which is a normal answer and not a failure: no account, no database, and the composer
    // only exists inside the shell. What must NOT happen is the reload being blocked or thrown by it.
    const user = userEvent.setup()
    render(<RealShell withReplica={false} />)
    updateReady()

    await user.click(await screen.findByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
    expect(await db.drafts.count()).toBe(0)
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

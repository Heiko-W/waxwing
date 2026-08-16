import { render, screen, waitForElementToBeRemoved, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Button } from './Button'
import { ToastProvider, useToast } from './Toast'

function Trigger() {
  const { toast, runNewestAction } = useToast()
  const [ran, setRan] = useState<boolean | null>(null)
  return (
    <>
      <Button onClick={() => toast({ title: 'Saved', tone: 'success' })}>Notify</Button>
      <Button onClick={() => toast({ title: 'Send failed', tone: 'danger' })}>Fail</Button>
      <Button onClick={() => toast({ title: 'Ephemeral toast', duration: 40 })}>Quick</Button>
      <Button onClick={() => toast({ title: 'Hovered toast', duration: 120 })}>Pause</Button>
      <Button onClick={() => toast({ title: 'Persistent toast', duration: 0 })}>Sticky</Button>
      <Button
        onClick={() =>
          toast({ title: 'Sending…', duration: 0, action: { label: 'Undo', onAction: onUndo } })
        }
      >
        Undoable
      </Button>
      <Button
        onClick={() =>
          toast({
            title: 'Second undoable',
            duration: 0,
            action: { label: 'Redo', onAction: onRedo },
          })
        }
      >
        Undoable 2
      </Button>
      <Button onClick={() => setRan(runNewestAction())}>Run newest</Button>
      <output>{ran === null ? 'idle' : String(ran)}</output>
    </>
  )
}

const onUndo = vi.fn()
const onRedo = vi.fn()

function withProvider() {
  return render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  )
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Toast', () => {
  it('mounts persistent polite and assertive live regions even with no toasts', () => {
    render(
      <ToastProvider>
        <span />
      </ToastProvider>,
    )
    expect(document.querySelector('[aria-live="polite"]')).toBeInTheDocument()
    expect(document.querySelector('[aria-live="assertive"]')).toBeInTheDocument()
  })

  it('routes a status toast into the polite region and dismisses it manually', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Notify' }))
    const polite = document.querySelector('[aria-live="polite"]') as HTMLElement
    expect(within(polite).getByText('Saved')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('routes a danger toast into the assertive region', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Fail' }))
    const assertive = document.querySelector('[aria-live="assertive"]') as HTMLElement
    expect(within(assertive).getByText('Send failed')).toBeInTheDocument()
  })

  it('auto-dismisses after its duration', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Quick' }))
    expect(screen.getByText('Ephemeral toast')).toBeInTheDocument()
    await waitForElementToBeRemoved(() => screen.queryByText('Ephemeral toast'))
  })

  it('renders an inline action that fires onAction and dismisses the toast (M2.8)', async () => {
    onUndo.mockClear()
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Undoable' }))
    expect(screen.getByText('Sending…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Sending…')).toBeNull()
  })

  it('pauses the auto-dismiss countdown while hovered', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await user.hover(screen.getByText('Hovered toast'))
    await wait(200) // past the 120ms duration — still present because hovering pauses it
    expect(screen.getByText('Hovered toast')).toBeInTheDocument()
    await user.unhover(screen.getByText('Hovered toast'))
    await waitForElementToBeRemoved(() => screen.queryByText('Hovered toast'))
  })

  it('keeps a duration:0 toast until it is dismissed', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Sticky' }))
    await wait(80)
    expect(screen.getByText('Persistent toast')).toBeInTheDocument()
  })

  it('refuses to run useToast outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/)
  })

  it('has no accessibility violations', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Sticky' }))
    await expectNoA11yViolations(document.body)
  })

  // M4.7, WCAG 2.1.1: the toast region is portalled to the END of the document, so reaching Undo by
  // Tab means crossing the whole shell. `runNewestAction` is the keyboard's route to it — the `z`
  // chord in the registry calls exactly this.
  describe('runNewestAction (the keyboard route to Undo)', () => {
    it('runs the NEWEST action-bearing toast and dismisses only that one', async () => {
      onUndo.mockClear()
      onRedo.mockClear()
      const user = userEvent.setup()
      withProvider()
      await user.click(screen.getByRole('button', { name: 'Undoable' }))
      await user.click(screen.getByRole('button', { name: 'Undoable 2' }))

      await user.click(screen.getByRole('button', { name: 'Run newest' }))

      expect(onRedo).toHaveBeenCalledTimes(1)
      expect(onUndo).not.toHaveBeenCalled()
      expect(screen.queryByText('Second undoable')).toBeNull()
      expect(screen.getByText('Sending…')).toBeInTheDocument() // the older offer survives
      expect(screen.getByRole('status')).toHaveTextContent('true')
    })

    it('skips toasts that carry no action rather than reporting success', async () => {
      onUndo.mockClear()
      const user = userEvent.setup()
      withProvider()
      await user.click(screen.getByRole('button', { name: 'Undoable' }))
      await user.click(screen.getByRole('button', { name: 'Sticky' })) // newer, but no action

      await user.click(screen.getByRole('button', { name: 'Run newest' }))

      // Reaching PAST the plain toast is the point: a status message pushed on top of an undo offer
      // must not swallow the chord, or `z` silently does nothing exactly when it is needed.
      expect(onUndo).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Persistent toast')).toBeInTheDocument()
    })

    it('reports false when there is nothing to run, so the caller can say so', async () => {
      const user = userEvent.setup()
      withProvider()
      await user.click(screen.getByRole('button', { name: 'Run newest' }))
      expect(screen.getByRole('status')).toHaveTextContent('false')
    })
  })
})

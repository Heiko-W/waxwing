import { render, screen, waitForElementToBeRemoved, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Button } from './Button'
import { ToastProvider, useToast } from './Toast'

function Trigger() {
  const { toast } = useToast()
  return (
    <>
      <Button onClick={() => toast({ title: 'Saved', tone: 'success' })}>Notify</Button>
      <Button onClick={() => toast({ title: 'Send failed', tone: 'danger' })}>Fail</Button>
      <Button onClick={() => toast({ title: 'Ephemeral toast', duration: 40 })}>Quick</Button>
      <Button onClick={() => toast({ title: 'Hovered toast', duration: 120 })}>Pause</Button>
      <Button onClick={() => toast({ title: 'Persistent toast', duration: 0 })}>Sticky</Button>
    </>
  )
}

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
})

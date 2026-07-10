import { render, screen } from '@testing-library/react'
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

describe('Toast', () => {
  it('announces a status toast and dismisses it manually', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Notify' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('uses an assertive alert for the danger tone', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Fail' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Send failed')
  })

  it('refuses to run useToast outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/)
  })

  it('has no accessibility violations', async () => {
    const user = userEvent.setup()
    withProvider()
    await user.click(screen.getByRole('button', { name: 'Notify' }))
    await screen.findByRole('status')
    await expectNoA11yViolations(document.body)
  })
})

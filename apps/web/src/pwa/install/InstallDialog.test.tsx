import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import InstallDialog, { type InstallDialogProps } from './InstallDialog'

const onClose = vi.fn()
const onInstall = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
})

function renderDialog(over: Partial<InstallDialogProps> = {}) {
  const props: InstallDialogProps = {
    open: true,
    onClose,
    productName: 'Waxwing',
    platform: 'chromium',
    canPrompt: true,
    onInstall,
    ...over,
  }
  return render(<InstallDialog {...props} />)
}

describe('InstallDialog — Chromium', () => {
  it('installs through the browser and closes', async () => {
    const user = userEvent.setup()
    renderDialog()

    expect(screen.getByRole('dialog', { name: 'Install Waxwing' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Install' }))

    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps focus and closes on Escape', async () => {
    const user = userEvent.setup()
    renderDialog()

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    renderDialog()
    await expectNoA11yViolations(document.body)
  })
})

describe('InstallDialog — iOS', () => {
  it('gives Share → Add to Home Screen instructions, since Safari has no install API', () => {
    renderDialog({ platform: 'ios', canPrompt: false })

    expect(screen.getByText('Add to Home Screen')).toBeInTheDocument()
    expect(screen.getByText('Tap the Share button in Safari.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  })

  it('says out loud that iOS notifications need the home-screen install (NFR-COMPAT-01)', () => {
    renderDialog({ platform: 'ios', canPrompt: false })

    expect(
      screen.getByText(/notifications only work when the app runs from the Home Screen/),
    ).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    renderDialog({ platform: 'ios', canPrompt: false })
    await expectNoA11yViolations(document.body)
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { DEFAULT_CONFIG } from './config'

describe('App shell', () => {
  it('renders the branded product name and theme controls', () => {
    render(<App config={DEFAULT_CONFIG} />)

    expect(screen.getByText(DEFAULT_CONFIG.branding.productName)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /light theme/i })).toBeInTheDocument()
  })

  it('reflects the selected theme through aria-pressed', async () => {
    const user = userEvent.setup()
    render(<App config={DEFAULT_CONFIG} />)

    const darkButton = screen.getByRole('button', { name: /dark theme/i })
    expect(darkButton).toHaveAttribute('aria-pressed', 'false')

    await user.click(darkButton)

    expect(darkButton).toHaveAttribute('aria-pressed', 'true')
  })
})

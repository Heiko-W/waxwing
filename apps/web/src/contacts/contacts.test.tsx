import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import ContactsPage from './ContactsPage'

describe('ContactsPage', () => {
  it('renders the localized title and placeholder', () => {
    render(<ContactsPage />)
    expect(screen.getByRole('heading', { name: /contacts/i })).toBeInTheDocument()
    expect(screen.getByText(/arrive in a later milestone/i)).toBeInTheDocument()
  })

  it('has no WCAG 2.x A/AA axe violations', async () => {
    const { container } = render(<ContactsPage />)
    await expectNoA11yViolations(container)
  })
})

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Spinner } from './Spinner'

describe('Spinner', () => {
  it('announces a localized loading status', () => {
    render(<Spinner />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
  })

  it('can suppress its own label to avoid double announcements', () => {
    render(<Spinner label="" />)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Spinner size="lg" />)
    await expectNoA11yViolations(container)
  })
})

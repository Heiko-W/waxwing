import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Badge } from './Badge'

describe('Badge', () => {
  it('renders its content', () => {
    render(<Badge tone="accent">12</Badge>)
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Badge tone="danger">3</Badge>)
    await expectNoA11yViolations(container)
  })
})

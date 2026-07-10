import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VisuallyHidden } from './VisuallyHidden'

describe('VisuallyHidden', () => {
  it('keeps its content in the accessibility tree', () => {
    render(<VisuallyHidden>Loading</VisuallyHidden>)
    expect(screen.getByText('Loading')).toBeInTheDocument()
  })

  it('exposes an id for aria references', () => {
    render(<VisuallyHidden id="hint">Details</VisuallyHidden>)
    expect(screen.getByText('Details')).toHaveAttribute('id', 'hint')
  })
})

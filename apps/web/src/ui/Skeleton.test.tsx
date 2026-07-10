import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from assistive tech and takes explicit dimensions', () => {
    const { container } = render(<Skeleton width={120} height={16} />)
    const element = container.firstElementChild as HTMLElement
    expect(element).toHaveAttribute('aria-hidden', 'true')
    expect(element.style.inlineSize).toBe('120px')
    expect(element.style.blockSize).toBe('16px')
  })

  it('passes through string dimensions verbatim', () => {
    const { container } = render(<Skeleton width="50%" circle />)
    const element = container.firstElementChild as HTMLElement
    expect(element.style.inlineSize).toBe('50%')
  })
})

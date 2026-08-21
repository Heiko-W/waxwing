import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SectionLabel } from './SectionLabel'

describe('SectionLabel', () => {
  it('is a heading by default, at the rank a dialog section takes', () => {
    render(<SectionLabel>Members</SectionLabel>)
    expect(screen.getByRole('heading', { name: 'Members', level: 3 })).toBeInTheDocument()
  })

  it('can drop to a span where a wrapper already carries the name', () => {
    // A rail whose list is named with `aria-labelledby` does not want a second heading in the
    // outline — that is the reason `as` exists rather than a second component.
    render(<SectionLabel as="span">Folders</SectionLabel>)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('Folders')).toBeInTheDocument()
  })

  it('takes an id, so a region can point at it', () => {
    render(<SectionLabel id="labels-heading">Labels</SectionLabel>)
    expect(screen.getByRole('heading', { name: 'Labels' })).toHaveAttribute('id', 'labels-heading')
  })

  it('carries no margin of its own', () => {
    // The five rules this replaced disagreed about spacing as well as about type — two of them
    // baked a bottom margin into the heading. Spacing is the placing layout's question; a label
    // that brings its own cannot be put in a flex column with a gap without fighting it.
    render(<SectionLabel>Sharing</SectionLabel>)
    // jsdom does not resolve CSS modules, so this asserts the DECLARATION rather than the
    // computed box: the browser gives `h3` a UA margin, and the point is that the rule overrides
    // it rather than that jsdom agrees.
    expect(getComputedStyle(screen.getByRole('heading')).margin).toMatch(/^0(px)?$/)
  })
})

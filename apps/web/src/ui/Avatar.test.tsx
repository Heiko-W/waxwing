import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Avatar, initialsFromName } from './Avatar'

describe('initialsFromName', () => {
  it.each([
    ['Bob Baker', 'BB'],
    ['alice', 'AL'],
    ['bob@waxwing.test', 'BO'],
    ['Alice <alice@waxwing.test>', 'AA'],
    ['   ', '?'],
    ['', '?'],
  ])('maps %o to %o', (input, expected) => {
    expect(initialsFromName(input)).toBe(expected)
  })

  /**
   * R-99 — `charAt`/`slice` count UTF-16 units, so an emoji (or any astral character) was cut in
   * half and the avatar showed the replacement glyph: "🏠 Zuhause" came out as "\uD83CZ". The
   * initials are `aria-hidden`, so nothing is announced wrongly — it is simply visibly broken.
   */
  it.each([
    ['🏠 Zuhause', '🏠Z'],
    ['😀 Bob', '😀B'],
    // A single token takes TWO code points, and the emoji is one of them.
    ['🏠Haus', '🏠H'],
    ['🏠', '🏠'],
    // Chinese and Japanese names are BMP, but they are the other case where "two characters" and
    // "two units" have to agree.
    ['王 小明', '王小'],
  ])('keeps an astral character whole: %o → %o', (input, expected) => {
    const initials = initialsFromName(input)
    expect(initials).toBe(expected)
    // The real assertion behind the expected values: not one lone surrogate survived — a high one
    // without its low, or a low one without its high.
    expect(initials).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
  })
})

describe('Avatar', () => {
  it('labels itself with the name and hides the initials from AT', () => {
    render(<Avatar name="Bob Baker" />)
    const avatar = screen.getByRole('img', { name: 'Bob Baker' })
    expect(avatar).toHaveTextContent('BB')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Avatar name="Bob Baker" size="lg" />)
    await expectNoA11yViolations(container)
  })

  it('renders the photo as an <img> when a local photoSrc is given', () => {
    const { container } = render(<Avatar name="Bob Baker" photoSrc="blob:local-photo" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'blob:local-photo')
    // The wrapper carries the accessible name; the image itself is decorative.
    expect(img).toHaveAttribute('alt', '')
    expect(screen.getByRole('img', { name: 'Bob Baker' })).toBeInTheDocument()
    expect(screen.queryByText('BB')).not.toBeInTheDocument()
  })

  it('shows initials when there is no photoSrc', () => {
    const { container } = render(<Avatar name="Bob Baker" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('BB')).toBeInTheDocument()
  })

  it('falls back to initials when the photo fails to load', () => {
    const { container } = render(<Avatar name="Bob Baker" photoSrc="blob:broken" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    if (img !== null) fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('BB')).toBeInTheDocument()
  })
})

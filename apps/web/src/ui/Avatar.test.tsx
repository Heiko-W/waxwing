import { render, screen } from '@testing-library/react'
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
})

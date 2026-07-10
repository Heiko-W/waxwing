import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { TextInput } from './TextInput'

describe('TextInput', () => {
  it('reflects the invalid state via aria-invalid', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <TextInput id="email" invalid />
      </>,
    )
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
  })

  it('accepts typed input', async () => {
    const user = userEvent.setup()
    render(
      <>
        <label htmlFor="email">Email</label>
        <TextInput id="email" />
      </>,
    )
    await user.type(screen.getByLabelText('Email'), 'a@b.co')
    expect(screen.getByLabelText('Email')).toHaveValue('a@b.co')
  })

  it('has no accessibility violations when labelled', async () => {
    const { container } = render(
      <>
        <label htmlFor="email">Email</label>
        <TextInput id="email" />
      </>,
    )
    await expectNoA11yViolations(container)
  })
})

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

/**
 * The software keyboard, which is the only place these three attributes do anything.
 *
 * Measured before this change: `autoCapitalize` and `autoCorrect` appeared ZERO times in the whole
 * source tree, while the app asks people to type an address into a recipient field, a username into
 * a sign-in form and a hostname into the connect screen. iOS capitalises the first letter of a
 * field by default and runs its dictionary over the rest — so a phone offered `Heiko@` and a
 * corrected domain name on the fields where neither can be right. `spellCheck={false}`, which two
 * of those fields did carry, turns off neither of them on iOS.
 *
 * Derived from what the caller already declares rather than demanded at each call site: a rule that
 * has to be repeated is a rule that gets missed, and these fields are exactly the ones where the
 * miss is invisible on a desktop.
 */
describe('TextInput — keyboard semantics for identifier fields', () => {
  it.each([
    { name: 'type=email', props: { type: 'email' } },
    { name: 'type=url', props: { type: 'url' } },
    { name: 'type=password', props: { type: 'password' } },
    { name: 'inputMode=email', props: { inputMode: 'email' as const } },
    { name: 'inputMode=url', props: { inputMode: 'url' as const } },
    { name: 'autoComplete=username', props: { autoComplete: 'username' } },
    { name: 'autoComplete=current-password', props: { autoComplete: 'current-password' } },
    { name: 'autoComplete=one-time-code', props: { autoComplete: 'one-time-code' } },
  ])('turns capitalisation and correction off for $name', ({ props }) => {
    render(<TextInput aria-label="Field" {...props} />)
    const input = screen.getByLabelText('Field')
    expect(input).toHaveAttribute('autocapitalize', 'none')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
  })

  it('leaves a prose field alone', () => {
    // The other half of the rule, and the reason this is not simply applied everywhere: a subject
    // line or a contact's name WANTS the capital letter and the dictionary.
    render(<TextInput aria-label="Subject" />)
    const input = screen.getByLabelText('Subject')
    expect(input).not.toHaveAttribute('autocapitalize')
    expect(input).not.toHaveAttribute('autocorrect')
  })

  it('lets the caller override the derived value', () => {
    // `rest` is spread last on purpose: a caller who knows better than the heuristic wins.
    render(<TextInput aria-label="Field" type="email" autoCapitalize="sentences" />)
    expect(screen.getByLabelText('Field')).toHaveAttribute('autocapitalize', 'sentences')
  })
})

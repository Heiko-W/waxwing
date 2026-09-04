import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Button } from './Button'

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'button')
  })

  it('activates on click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is busy and non-interactive while loading', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Go
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Button variant="primary">Save</Button>)
    await expectNoA11yViolations(container)
  })

  /**
   * The refusal is a DESCRIPTION, not part of the name.
   *
   * It used to be rendered as a visually-hidden span INSIDE the button, so name-from-content
   * swallowed it: the control announced itself as "Move You are offline. Files can only be changed
   * while connected." and `aria-describedby` then said the same sentence again. An icon-only button
   * hid that behind its `aria-label`, which is why it went unnoticed — and why two file actions were
   * left un-gated offline rather than have their names wrecked (the note that stood at those call
   * sites named this primitive as the blocker).
   */
  it('explains a refusal without putting the sentence in the button name', () => {
    render(<Button unavailableReason="You are offline.">Move</Button>)
    // `getByRole` matches on the accessible NAME — "Move" and nothing else.
    const button = screen.getByRole('button', { name: 'Move' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription('You are offline.')
    // The sentence lives outside the control, so it is announced exactly once.
    expect(button.textContent).toBe('Move')
  })

  it('stays focusable and swallows activation while unavailable', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button unavailableReason="You are offline." onClick={onClick}>
        Move
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Move' })
    // FR-A11Y-01: the reader who most needs the explanation must be able to reach it.
    button.focus()
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('says nothing extra when the reason does not apply', () => {
    render(<Button>Move</Button>)
    const button = screen.getByRole('button', { name: 'Move' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).not.toHaveAttribute('aria-describedby')
  })

  /**
   * A CONTROL HAS TO LOOK THE WAY IT BEHAVES, and this half is the one that went missing.
   *
   * The onboarding buttons were given a bare `aria-disabled` through `...rest`. The attribute
   * arrived, the CLASS that dims the button did not, and the result was the worst version of this
   * control: unavailable to a screen reader, full primary blue and `cursor: pointer` to everybody
   * else. Every assertion in this file passed. It took looking at the screen.
   *
   * The class name is compared rather than quoted: it is a CSS-module hash, and what the tests
   * below actually claim is a RELATION — "`unavailable` renders exactly the treatment
   * `unavailableReason` has always rendered" — which is what stops a second appearance being
   * invented for the same state.
   */
  const classesOf = (name: string) => screen.getByRole('button', { name }).className.split(' ')

  it('`unavailable` renders the same treatment as `unavailableReason`, and not the plain one', () => {
    render(
      <>
        <Button unavailable>Alpha</Button>
        <Button unavailableReason="You are offline.">Beta</Button>
        <Button>Gamma</Button>
      </>,
    )
    expect(classesOf('Alpha')).toEqual(classesOf('Beta'))
    // …and the comparison is not vacuous: the plain button carries one class fewer.
    expect(classesOf('Gamma').length).toBe(classesOf('Alpha').length - 1)
    expect(classesOf('Alpha')).toEqual(
      expect.arrayContaining([expect.stringMatching(/unavailable/)]),
    )
  })

  it('`unavailable` alone behaves like a refusal: aria-disabled, focusable, no activation', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button unavailable onClick={onClick}>
        Continue
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    button.focus()
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('`unavailable` adds NO hidden sentence — the visible one is the statement', () => {
    // The prop exists for the case where the explanation is already on screen. A second,
    // invisible copy would be the same sentence twice for a screen reader and once for everyone
    // else, which is the bug this primitive already fixed once for `unavailableReason`.
    const { container } = render(<Button unavailable>Continue</Button>)
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).not.toHaveAttribute('aria-describedby')
    expect(container.textContent).toBe('Continue')
  })

  it('a hard `disabled` still wins over `unavailable`', () => {
    render(
      <Button unavailable disabled>
        Continue
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled')
  })
})

/**
 * The APG toolbar keyboard model (B20.2).
 *
 * The finding was not "the arrow keys are wrong" — it was that `role="toolbar"` was declared with
 * NO model behind it, so a screen reader announced a navigation that did not exist and eleven
 * controls each took a tab stop. These are the four properties that make the role honest.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useToolbarRoving } from './use-toolbar-roving'

function Bar({ extra = false }: { readonly extra?: boolean }) {
  const { ref, containerProps } = useToolbarRoving<HTMLDivElement>()
  return (
    <div ref={ref} role="toolbar" aria-label="Actions" {...containerProps}>
      <button type="button">One</button>
      <button type="button" disabled>
        Two
      </button>
      {extra && <button type="button">Extra</button>}
      <button type="button">Three</button>
    </div>
  )
}

/** A toolbar whose control count changes at runtime, the way the action bar's does. */
function GrowingBar() {
  const [extra, setExtra] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setExtra((value) => !value)}>
        toggle
      </button>
      <Bar extra={extra} />
    </>
  )
}

/**
 * The controls a Tab press would actually land on, inside the toolbar. Both filters matter: a button
 * elsewhere on the page is not the toolbar's business, and a `disabled` button reports `tabIndex: 0`
 * (the default for buttons) while the platform skips it — counting it would measure an attribute
 * rather than the tab order.
 */
const tabbable = () =>
  [...screen.getByRole('toolbar').querySelectorAll('button')]
    .filter((button) => !button.disabled && button.tabIndex === 0)
    .map((button) => button.textContent)

describe('useToolbarRoving', () => {
  it('leaves exactly ONE tab stop, whatever the toolbar renders', () => {
    render(<Bar />)
    expect(tabbable()).toEqual(['One'])
  })

  it('walks the controls with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup()
    render(<Bar />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    // Straight past "Two". A natively disabled control cannot take focus — `focus()` on it is a
    // no-op — so an index that stopped there would make the arrow key appear to do nothing.
    // (`aria-disabled` controls, which `IconButton`'s `unavailableReason` produces, DO stay in the
    // ring: they are focusable, and hearing why an action is refused is the point of B34.)
    expect(screen.getByRole('button', { name: 'Three' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus() // wrapped past the end

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('button', { name: 'Three' })).toHaveFocus() // and past the start
  })

  it('Home and End jump to the ends', async () => {
    const user = userEvent.setup()
    render(<Bar />)
    await user.tab()

    await user.keyboard('{End}')
    expect(screen.getByRole('button', { name: 'Three' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()
  })

  it('follows a pointer click, so the arrows resume from where the user is', async () => {
    const user = userEvent.setup()
    render(<Bar />)

    await user.click(screen.getByRole('button', { name: 'Three' }))
    expect(tabbable()).toEqual(['Three'])

    // Without this, the index and the actual focus disagree the moment a pointer is involved, and
    // the next arrow press jumps back to wherever the index had been left.
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()
  })

  it('keeps a single tab stop when the control set changes', async () => {
    const user = userEvent.setup()
    render(<GrowingBar />)
    expect(tabbable()).toEqual(['One'])

    await user.click(screen.getByRole('button', { name: 'toggle' }))

    // A freshly rendered control carries NO tabIndex, so it is tabbable by default — which would
    // quietly give the toolbar two tab stops. The action bar adds and removes controls with the
    // user's rights, so this is the everyday case, not an edge one.
    expect(tabbable()).toEqual(['One'])
  })

  it('ignores modified arrows, which belong to the app and the browser', async () => {
    const user = userEvent.setup()
    render(<Bar />)
    await user.tab()

    await user.keyboard('{Meta>}{ArrowRight}{/Meta}')

    // ⌘→ / ⌥→ are word and line motion, and browser history — a toolbar that swallowed them would
    // take keys it has no business taking.
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()
  })
})

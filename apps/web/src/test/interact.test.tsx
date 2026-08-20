import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { clickButton } from './interact'

/*
 * The B46 race, reduced to the two lines that cause it.
 *
 * `Gate` is what a control backed by a Dexie `liveQuery` looks like from the test's side: rendered
 * immediately, `disabled` until data arrives. The real one is the New-group button in
 * `ContactsScreen`, whose `useAddressBooks()` starts `undefined` on every first render — seeded
 * database or not — so it is disabled EVERY time, not occasionally.
 *
 * ## Why the gate is a promise the test holds, and not a timeout
 *
 * The first version of this file used `setTimeout(80)` and asserted that a naive click loses the
 * race. That is the SAME defect it exists to demonstrate: it assumes `user.click` finishes within
 * 80 ms, which is exactly the assumption load breaks — and it duly failed in a full `pnpm verify`
 * run within the hour, while passing on its own. A test about a race must not contain one.
 *
 * So the arrival is explicit. Nothing here depends on how long anything takes, on either machine or
 * either direction, which is what makes the counter-test below evidence rather than another race.
 */
function Gate({ ready }: { ready: Promise<void> }) {
  const [enabled, setEnabled] = useState(false)
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    let live = true
    void ready.then(() => {
      if (live) setEnabled(true)
    })
    return () => {
      live = false
    }
  }, [ready])
  return (
    <>
      <button type="button" disabled={!enabled} onClick={() => setOpened(true)}>
        New group
      </button>
      {opened && <h1>New group</h1>}
    </>
  )
}

/** A promise the test resolves by hand — the data arriving, at a moment the test decides. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('clicking a control that is disabled while its data loads (B46)', () => {
  /*
   * The counter-test, and the reason this file exists rather than a one-line change in the contacts
   * suite: it shows the ORIGINAL formulation losing, with no timing assumption — the data simply
   * never arrives. Without it, the fix is a guess that happens to be green, which is exactly what
   * B46's three green re-runs were. Note that nothing throws: a click on a disabled button is a
   * silent no-op, so the failure surfaces as a missing dialog somewhere later.
   */
  it('is silently dropped when the control is not enabled yet — the original failure', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    render(<Gate ready={gate.promise} />)

    await user.click(await screen.findByRole('button', { name: 'New group' }))

    expect(screen.queryByRole('heading', { name: 'New group' })).not.toBeInTheDocument()
    gate.resolve()
  })

  it('waits for the enable, then lands', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    render(<Gate ready={gate.promise} />)

    // Start the click while the button is still disabled, THEN let the data arrive: this is the
    // ordering the real test hits, and the one a plain `click` cannot survive.
    const clicked = clickButton(user, 'New group')
    gate.resolve()
    await clicked

    expect(screen.getByRole('heading', { name: 'New group' })).toBeInTheDocument()
  })

  // The fast path still has to be fast: an already-enabled control must not wait for anything.
  it('does not stall on a control that is enabled from the start', async () => {
    const user = userEvent.setup()
    render(<Gate ready={Promise.resolve()} />)
    await clickButton(user, 'New group')
    expect(screen.getByRole('heading', { name: 'New group' })).toBeInTheDocument()
  })
})

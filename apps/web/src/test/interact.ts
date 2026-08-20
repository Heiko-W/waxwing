/**
 * Test-only interaction helpers for controls that are disabled while their data loads (B46).
 *
 * ## The failure this exists to stop
 *
 * `ContactsScreen.groups.test.tsx` "creates a group through the New-group form" failed once in a
 * full run, passed on its own and in three re-runs, and was recorded rather than diagnosed. It
 * failed a second time two days later, in a full run under load, on a different Node major. The
 * cause is not load, and not the lazy chunk the first report guessed at — `GroupForm` is a static
 * import:
 *
 *   renderScreen('/contacts/personal')
 *   await user.click(await screen.findByRole('button', { name: 'New group' }))
 *
 * The New-group button is `disabled` until `useAddressBooks()` resolves, and a Dexie `liveQuery`
 * always starts `undefined` — so on the first render that button is disabled EVERY time, seeded
 * database or not. `findByRole` does not filter by disabled state, so it returns it immediately.
 *
 * What made the test usually pass is that `user.click` is a SEQUENCE of awaited events — pointerover,
 * pointerdown, focus, pointerup, click — and the query normally resolves somewhere inside it, so the
 * final `click` lands on a button that has just become enabled. Measured directly: `disabled` is
 * `true` when `findByRole` returns the element and `false` immediately after the click. Under load
 * the resolution falls past the end of that sequence, `click` lands on a disabled button, and the
 * browser drops it silently — no error, no dialog, and an assertion that reads as if the component
 * were broken.
 *
 * So the flake was never intermittent behaviour. It was a race the test won most of the time.
 */

import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { expect } from 'vitest'

/**
 * Click a control once it is actually clickable.
 *
 * Use wherever `disabled` is driven by loaded data rather than by user input — the distinction that
 * matters is not "might it be slow" but "does anything in this test guarantee the data arrived".
 * A click on a disabled element is not an error in the DOM; it is a no-op, which is why getting this
 * wrong produces a confusing failure somewhere later instead of here.
 */
export async function clickWhenEnabled(user: UserEvent, element: HTMLElement): Promise<void> {
  await waitFor(() => expect(element).toBeEnabled())
  await user.click(element)
}

/** Find a button by accessible name, wait for it to be enabled, then click it. */
export async function clickButton(
  user: UserEvent,
  name: string | RegExp,
  container?: HTMLElement,
): Promise<HTMLElement> {
  const scope = container === undefined ? screen : within(container)
  const button = await scope.findByRole('button', { name })
  await clickWhenEnabled(user, button)
  return button
}

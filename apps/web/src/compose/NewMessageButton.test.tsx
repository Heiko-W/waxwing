import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RouterProvider } from '../app/route'
import { useComposerStore } from './composer-store'
import { NewMessageButton } from './NewMessageButton'

const store = () => useComposerStore.getState()

/** Render the button with the router pointed at `path` — the shell header's position, minus the shell. */
function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(
    <RouterProvider baseUri="/">
      <NewMessageButton />
    </RouterProvider>,
  )
}

const button = () => screen.queryByRole('button', { name: 'New message' })

beforeEach(() => {
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
})
afterEach(() => {
  window.history.pushState({}, '', '/')
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
})

describe('NewMessageButton', () => {
  it('opens a draft on the mail route', async () => {
    const user = userEvent.setup()
    renderAt('/mail/inbox')
    const trigger = button()
    expect(trigger).not.toBeNull()
    await user.click(trigger as HTMLElement)
    expect(store().drafts.size).toBe(1)
  })

  // `/` matches as `mail` (matchRoute), so a cold start on the bare origin is not the "elsewhere"
  // case — it is the mail screen before the first navigation, and losing the button there would be
  // the same defect in the other direction.
  it('renders on the bare home path, which is the mail route', () => {
    renderAt('/')
    expect(button()).not.toBeNull()
  })

  /*
   * B50. The header is global; the button is not. On a phone this node is a fixed floating action
   * button, so on every one of these screens it did not merely offer the wrong action — it covered
   * the content it floated over (the Settings list's last row, in the shot that found this).
   */
  it.each([
    ['settings', '/settings'],
    ['a settings section', '/settings/identities'],
    ['contacts', '/contacts'],
    ['the calendar', '/calendar'],
    ['files', '/files'],
    ['an unknown path', '/nowhere'],
  ])('does not render on %s', (_name, path) => {
    renderAt(path)
    expect(button()).toBeNull()
  })
})

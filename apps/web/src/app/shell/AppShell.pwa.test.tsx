/**
 * The PWA surface WHERE IT IS WIRED (M3.5). The units are covered in `src/pwa`; what these assert is
 * the wiring itself — the two things a unit test structurally cannot see:
 *
 *  - **What the chunk error boundary actually wraps.** The route chunks were never the dangerous ones:
 *    `ComposerHost` is lazy too, it hangs off its own Suspense outside `<main>`, and it is the first
 *    chunk most people load after a deploy has replaced the bundle. Wrapping only the routes left a
 *    white screen exactly where a user starts writing.
 *  - **That the skip link still skips.** `<base href="/">` (FR-DEP-02) resolves a bare `#main` against
 *    the mount root, not the current URL, so on a deep link the browser would treat the first tab stop
 *    as a navigation to `/` and reload the app.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../../compose'
import { initInstallCapture, resetInstallState } from '../../pwa/install/use-install-prompt'
import { App } from '../App'
import { DEFAULT_CONFIG } from '../config'
import { fakeAuthSession, makeFakeServices } from '../session/test-fakes'

// The composer chunk, as it behaves once a deploy has deleted it from the server.
vi.mock('../../compose/ComposerHost', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/ComposerHost-a1b2.js')
})

function renderShell() {
  const fake = makeFakeServices({ restore: fakeAuthSession('basic') })
  render(<App config={DEFAULT_CONFIG} services={fake.services} />)
  return fake
}

/** Stalwart rewrites this tag to the mount prefix; at the root it is `/` — and that is the trap. */
function withBaseHref(): HTMLBaseElement {
  const base = document.createElement('base')
  base.setAttribute('href', '/')
  document.head.appendChild(base)
  return base
}

beforeEach(() => {
  resetInstallState()
  initInstallCapture(async () => true)
  vi.spyOn(console, 'error').mockImplementation(() => {}) // React logs every caught error
})

afterEach(() => {
  resetInstallState()
  sessionStorage.clear()
  document.querySelector('base')?.remove()
  window.history.pushState(null, '', '/')
})

describe('the skip link survives <base href>', () => {
  it('jumps to the content instead of navigating to the mount root', async () => {
    withBaseHref()
    window.history.pushState(null, '', '/mail/inbox/42')
    const user = userEvent.setup()
    renderShell()

    const skip = await screen.findByRole('link', { name: 'Skip to content' })
    // The href STILL resolves to the mount root — that is the browser's rule, not a bug we can undo…
    expect(skip.getAttribute('href')).toBe('#main')
    expect((skip as HTMLAnchorElement).href).toBe(`${window.location.origin}/#main`)

    await user.click(skip)

    // …so the click must do the jump itself, and must not leave the route.
    expect(document.activeElement).toBe(document.getElementById('main'))
    expect(window.location.pathname).toBe('/mail/inbox/42')
  })
})

describe('the chunk error boundary covers the COMPOSER, not just the routes', () => {
  it('shows the recovery panel instead of unmounting the app into a white screen', async () => {
    renderShell()
    await screen.findByRole('link', { name: 'Mail' })

    // The user clicks "Compose" after a deploy replaced the bundle: the lazy chunk is gone.
    act(() => {
      useComposerStore.getState().openDraft({ id: 'd1', subject: 'a reply' })
    })

    // Caught: the shell is replaced by the panel — not by nothing.
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()

    useComposerStore.getState().closeDraft('d1')
  })
})

describe('the install offer in the account menu', () => {
  it('is absent until the browser says the app is installable', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(await screen.findByRole('button', { name: 'Account' }))
    expect(screen.queryByRole('menuitem', { name: 'Install app' })).not.toBeInTheDocument()
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('appears once Chromium offers one, and opens the install dialog', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByRole('link', { name: 'Mail' })

    act(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true })
      Object.assign(event, { prompt: vi.fn(async () => {}) })
      window.dispatchEvent(event)
    })

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Install app' }))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })
})

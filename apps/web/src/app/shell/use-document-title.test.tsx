import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RouterProvider } from '../route'
import { useDocumentTitle } from './use-document-title'

/**
 * `document.title` names the screen, on every screen (HIG `toolbars`: "Provide a useful title for
 * each window … Don't title windows with your app name").
 *
 * Two of the five sections fell through the hook's `default` branch, where the title is derived
 * from a mailbox — and a calendar route has no mailbox, so Calendar and Files were both called
 * nothing but the product name. That matters more here than in most apps: this one pushes history
 * entries deliberately (opening a message, switching folder, submitting a search) and the browser's
 * back MENU lists them by title, as does a bookmark, a second tab, and the task switcher of the
 * installed app.
 *
 * Written after the fact, because there was no test for this file at all — `document.title` did not
 * appear in a single assertion anywhere in the repo, which is how two routes could be added without
 * anyone noticing they had no name.
 */

function Probe({ productName = 'Waxwing' }: { productName?: string }) {
  useDocumentTitle(productName)
  return null
}

function renderAt(path: string, productName?: string): void {
  window.history.pushState({}, '', path)
  render(
    <RouterProvider baseUri="/">
      <Probe {...(productName === undefined ? {} : { productName })} />
    </RouterProvider>,
  )
}

afterEach(() => {
  window.history.pushState({}, '', '/')
  document.title = ''
})

describe('useDocumentTitle', () => {
  it.each([
    { path: '/calendar', expected: 'Calendar — Waxwing' },
    { path: '/files', expected: 'Files — Waxwing' },
    { path: '/contacts', expected: 'Contacts — Waxwing' },
    { path: '/settings', expected: 'Settings — Waxwing' },
  ])('names the $path screen', ({ path, expected }) => {
    renderAt(path)
    expect(document.title).toBe(expected)
  })

  it('falls back to the product name where the route legitimately has no subject', () => {
    // A label browse or a search has no folder, and naming a folder the list is not showing would
    // be worse than naming nothing. This is the branch the two routes above were wrongly taking.
    renderAt('/mail')
    expect(document.title).toBe('Waxwing')
  })

  it('uses the CONFIGURED product name, never the literal "Waxwing"', () => {
    // FR-THEME-02: a white-label deployment must not leak the upstream name into the task switcher.
    renderAt('/calendar', 'Post')
    expect(document.title).toBe('Calendar — Post')
  })
})

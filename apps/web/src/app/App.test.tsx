import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App'
import { DEFAULT_CONFIG, type WaxwingConfig } from './config'
import { type FakeServicesOptions, fakeAuthSession, makeFakeServices } from './session/test-fakes'

/** A config with hoster branding, to prove nothing hardcodes "Waxwing" (FR-THEME-02). */
const BRANDED: WaxwingConfig = {
  ...DEFAULT_CONFIG,
  branding: { ...DEFAULT_CONFIG.branding, productName: 'Postbote' },
}

function renderApp(options: FakeServicesOptions = {}, config: WaxwingConfig = BRANDED) {
  const fake = makeFakeServices(options)
  render(<App config={config} services={fake.services} />)
  return fake
}

/** Force the responsive tier to phone (jsdom has no matchMedia). */
function stubPhoneViewport(): void {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  window.history.pushState(null, '', '/')
  // @ts-expect-error — remove the phone stub so the next test defaults to desktop.
  window.matchMedia = undefined
})

describe('App onboarding', () => {
  it('shows the branded connect screen and hardcodes no product name', async () => {
    renderApp({ probePresent: false })
    expect(await screen.findByText('Welcome to Postbote')).toBeInTheDocument()
    expect(screen.queryByText(/Waxwing/)).not.toBeInTheDocument()
  })

  it('disables OAuth on an insecure origin and explains why (Basic still works)', async () => {
    renderApp({ probePresent: true, oauthAvailable: false })
    await screen.findByText(/HTTPS/i)
    const oauthButton = screen.getByRole('button', { name: /^sign in$/i })
    expect(oauthButton).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
  })

  it('renders the configured hoster branding links, and none when unset (FR-THEME-02)', async () => {
    const withLinks: WaxwingConfig = {
      ...BRANDED,
      branding: {
        ...BRANDED.branding,
        links: { imprint: 'https://host.example/imprint', support: null, privacy: null },
      },
    }
    renderApp({ probePresent: false }, withLinks)
    const imprint = await screen.findByRole('link', { name: 'Imprint' })
    expect(imprint).toHaveAttribute('href', 'https://host.example/imprint')
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument()
  })
})

describe('App shell', () => {
  it('renders the branded three-pane shell once connected', async () => {
    renderApp({ restore: fakeAuthSession('basic') })

    // Branding in the header (FR-THEME-02) and no leaked default name.
    expect(await screen.findByText('Postbote')).toBeInTheDocument()
    expect(screen.queryByText(/Waxwing/)).not.toBeInTheDocument()

    // Three empty panes + primary nav. The folder pane is now the live FolderTree, which shows
    // this empty-state text once its (empty) replica liveQuery resolves.
    expect(await screen.findByText('Your folders will appear here.')).toBeInTheDocument()
    // No mailbox is selected on `/mail`, so the message list shows its no-folder prompt.
    expect(screen.getByText('Select a folder')).toBeInTheDocument()
    expect(screen.getByText('Select a message to read it.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Mail' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('signs out from the account menu (FR-AUTH-05)', async () => {
    const user = userEvent.setup()
    const fake = renderApp({ restore: fakeAuthSession('basic') })
    await screen.findByText('Postbote')

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }))

    await waitFor(() => expect(fake.spies.logout).toHaveBeenCalledTimes(1))
  })

  it('opens the re-auth overlay without unmounting the shell (FR-AUTH-06)', async () => {
    const fake = renderApp({ restore: fakeAuthSession('basic') })
    const brand = await screen.findByText('Postbote')

    // Simulate a JMAP request whose auth has permanently expired.
    fake.expire()
    await act(async () => {
      try {
        await fake.capturedProvider()?.authorization()
      } catch {
        // The provider rethrows after firing the re-auth funnel.
      }
    })

    expect(await screen.findByRole('dialog', { name: 'Session expired' })).toBeInTheDocument()
    // The shell frame is still the SAME element — nothing remounted (state preserved).
    expect(screen.getByText('Postbote')).toBe(brand)
  })

  it('shows a single reading pane with a Back affordance on a phone deep link', async () => {
    stubPhoneViewport()
    window.history.pushState(null, '', '/mail/inbox/42')
    const user = userEvent.setup()
    renderApp({ restore: fakeAuthSession('basic') })

    const back = await screen.findByRole('button', { name: /back to messages/i })
    // The list pane (its message grid) is swapped out for the reading pane in single-pane mode.
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()

    await user.click(back)

    // Back returns to the list AND moves focus to it (WCAG 2.4.3 — not stranded on body).
    const listPane = await screen.findByRole('region', { name: 'Messages' })
    expect(listPane).toHaveFocus()
  })
})

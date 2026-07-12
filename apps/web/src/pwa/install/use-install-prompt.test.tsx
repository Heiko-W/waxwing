import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type InstallPrompt,
  initInstallCapture,
  resetInstallState,
  useInstallPrompt,
} from './use-install-prompt'

const persist = vi.fn(async () => true)

let latest: InstallPrompt

function Harness() {
  latest = useInstallPrompt()
  return null
}

/** Chromium's install offer. `prompt()` is what the account menu replays on a click. */
function fireBeforeInstallPrompt(): Event {
  const event = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(event, { prompt: vi.fn(async () => {}) })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

// jsdom is neither iOS nor standalone by default; each test opts in explicitly. These are own-property
// overrides (not vi.spyOn) because both live on the prototype chain in jsdom.
const realUserAgent = navigator.userAgent
const realMatchMedia = window.matchMedia

function fakeUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
}

function fakeStandalone(): void {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true }) as MediaQueryList,
    configurable: true,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInstallState()
  // What main.tsx does at boot, before its first await.
  initInstallCapture(persist)
})

afterEach(() => {
  resetInstallState()
  Object.defineProperty(navigator, 'userAgent', { value: realUserAgent, configurable: true })
  Object.defineProperty(window, 'matchMedia', { value: realMatchMedia, configurable: true })
})

describe('initInstallCapture', () => {
  it('catches an offer that arrives BEFORE React renders — the event is never replayed', () => {
    // The real sequence on a repeat visit: the worker is already registered, so Chromium decides the
    // app is installable and fires while main.tsx is still awaiting config.json. A listener attached
    // from a component effect would miss this entirely and the menu item would never appear.
    const event = fireBeforeInstallPrompt()
    render(<Harness />)

    expect(event.defaultPrevented).toBe(true)
    expect(latest.canPrompt).toBe(true)
  })

  it('is idempotent — a second call does not double up the listeners', () => {
    initInstallCapture(persist)
    render(<Harness />)
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })

    expect(persist).toHaveBeenCalledTimes(1)
  })
})

describe('useInstallPrompt', () => {
  it('offers nothing until the browser says the app is installable', () => {
    render(<Harness />)
    expect(latest.canPrompt).toBe(false)
    expect(latest.isStandalone).toBe(false)
  })

  it('NEVER asks for persistent storage on boot — in Firefox that is a permission prompt', () => {
    render(<Harness />)
    expect(persist).not.toHaveBeenCalled()
  })

  it('captures `beforeinstallprompt`, suppressing the browser mini-infobar', () => {
    render(<Harness />)
    const event = fireBeforeInstallPrompt()

    expect(event.defaultPrevented).toBe(true)
    expect(latest.canPrompt).toBe(true)
  })

  it('replays the captured event once, then has nothing left to offer', async () => {
    render(<Harness />)
    const event = fireBeforeInstallPrompt()

    await act(async () => {
      await latest.promptInstall()
    })

    expect((event as unknown as { prompt: () => void }).prompt).toHaveBeenCalledTimes(1)
    expect(latest.canPrompt).toBe(false)
  })

  it('requests persistent storage on `appinstalled` — exactly once, however often it fires', () => {
    render(<Harness />)
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
      window.dispatchEvent(new Event('appinstalled'))
    })

    expect(persist).toHaveBeenCalledTimes(1)
    // The offer is spent: the menu item disappears.
    expect(latest.canPrompt).toBe(false)
  })

  it('iOS has no install API at all — instructions are the only path (NFR-COMPAT-01)', () => {
    fakeUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    )
    render(<Harness />)

    expect(latest.platform).toBe('ios')
    expect(latest.canPrompt).toBe(false)
  })

  it('reports standalone, so the account menu can hide the offer once the app is installed', () => {
    fakeStandalone()
    render(<Harness />)

    expect(latest.isStandalone).toBe(true)
  })
})

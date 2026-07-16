import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLinkOpener } from './use-link-opener'

/**
 * The hook's own contract, with `classifyLink` NOT mocked: what matters here is the seam between the
 * two — that the hook hands the classifier the base it needs, and routes the verdict to a dialog or
 * to `window.open`. Mocking the classifier would test the wiring and miss the bug this file exists
 * for (D1: the href the browser resolves is not the href the classifier saw).
 */
const openSpy = vi.fn()

beforeEach(() => {
  vi.stubGlobal('open', openSpy)
  openSpy.mockClear()
})

/** Drive the hook the way `MailBodyFrame`'s click interception does. */
function click(href: string, text: string) {
  const { result } = renderHook(() => useLinkOpener())
  act(() => {
    result.current.onOpenLink(href, { href, text })
  })
  return result
}

describe('useLinkOpener — the base the frame cannot supply', () => {
  it('jsdom serves a real document URL, which is what the base resolution needs', () => {
    // Precondition, pinned: every assertion below is meaningless if the test document has no origin.
    expect(window.location.href).toMatch(/^https?:\/\//)
  })

  it('RAISES the dialog for a protocol-relative href whose text names another host (D1)', () => {
    // The bug: `new URL('//evil.tld/x')` throws with no base, so the verdict was `unparsable` and
    // this href went straight to `window.open` — which resolves it against THIS document and lands
    // on evil.tld. No dialog, for the exact destination that `https://evil.tld/x` warns about.
    const result = click('//evil.tld/x', 'bank.test')
    expect(result.current.pending).toEqual({
      href: '//evil.tld/x',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('agrees with the spelt-out form, which is the whole point', () => {
    const relative = click('//evil.tld/x', 'bank.test').current.pending
    const absolute = click('https://evil.tld/x', 'bank.test').current.pending
    expect(relative?.targetHost).toBe(absolute?.targetHost)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('opens a protocol-relative href whose claim IS honoured', () => {
    const result = click('//bank.test/login', 'bank.test')
    expect(result.current.pending).toBeNull()
    expect(openSpy).toHaveBeenCalledWith('//bank.test/login', '_blank', 'noopener,noreferrer')
  })

  it('resolves a single-slash `https:/` href against THIS document, scheme included', () => {
    // The single-slash form is relative only when its scheme matches the base's. This document is
    // http, so `https:/evil.tld/x` parses as absolute and honestly names evil.tld. Served over https
    // — the app — the same string is a path on the app's OWN origin and the dialog must name that
    // instead; `@waxwing/mail-html`'s link-host.test.ts pins that branch, where the base is https.
    // Two answers, both correct for their document: that is what passing a base buys.
    expect(window.location.protocol).toBe('http:')
    const result = click('https:/evil.tld/x', 'bank.test')
    expect(result.current.pending?.targetHost).toBe('evil.tld')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('still opens a mailto: without a dialog — a base does not make it a web link', () => {
    const result = click('mailto:security@bank.test', 'bank.test')
    expect(result.current.pending).toBeNull()
    expect(openSpy).toHaveBeenCalledWith(
      'mailto:security@bank.test',
      '_blank',
      'noopener,noreferrer',
    )
  })
})

describe('useLinkOpener — the verdicts it routes', () => {
  it('opens a link whose text claims no host at all', () => {
    const result = click('https://cdn.example.test/invoice.pdf', 'invoice.pdf')
    expect(result.current.pending).toBeNull()
    expect(openSpy).toHaveBeenCalledOnce()
  })

  it('raises the dialog for a host named inside prose', () => {
    expect(click('https://evil.ru/x', 'Login at bank.test').current.pending).toEqual({
      href: 'https://evil.ru/x',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
    })
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('opens on confirm and clears the pending link', () => {
    const result = click('https://evil.ru/x', 'bank.test')
    act(() => {
      result.current.confirm()
    })
    expect(openSpy).toHaveBeenCalledWith('https://evil.ru/x', '_blank', 'noopener,noreferrer')
    expect(result.current.pending).toBeNull()
  })

  it('cancel discards the link WITHOUT opening it', () => {
    const result = click('https://evil.ru/x', 'bank.test')
    act(() => {
      result.current.cancel()
    })
    expect(openSpy).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })
})

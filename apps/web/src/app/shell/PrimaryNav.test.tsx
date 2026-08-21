/**
 * The primary nav offers only what the server can serve (JMAP gap analysis, I-3).
 *
 * `serverSupportsCalendars` and `serverSupportsFiles` shipped with their pages and were then never
 * called by anything. Against a JMAP server without the two DRAFT capabilities — Calendar is
 * `draft-ietf-jmap-calendars`, FileNode has no RFC number at all, so that is the ordinary server,
 * not the odd one — the rail and the phone tab bar still offered both sections, and choosing one
 * opened a screen whose first request comes back `unknownCapability`.
 *
 * Two things are asserted, and the second is the one a nav-only fix misses: a typed-in or bookmarked
 * `/calendar` never passes through the nav at all, so the guard has to sit at the route as well.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../App'
import { DEFAULT_CONFIG } from '../config'
import { fakeAuthSession, fakeJmapSession, makeFakeServices } from '../session/test-fakes'
import { isSectionAvailable } from './use-available-sections'

const CALENDARS = 'urn:ietf:params:jmap:calendars'
const FILENODE = 'urn:ietf:params:jmap:filenode'

function renderShell(accountCapabilities: Record<string, unknown>) {
  const fake = makeFakeServices({
    restore: fakeAuthSession('basic'),
    session: fakeJmapSession('acc-1', 'alice@waxwing.test', { accountCapabilities }),
  })
  render(<App config={DEFAULT_CONFIG} services={fake.services} />)
}

async function navLinks(): Promise<string[]> {
  const nav = await screen.findByRole('navigation', { name: /Primary navigation|Hauptnavigation/i })
  return Array.from(nav.querySelectorAll('a')).map((link) => link.textContent ?? '')
}

describe('sections a server does not offer', () => {
  it('leaves Calendar and Files out of the nav entirely', async () => {
    renderShell({})

    await waitFor(async () => {
      expect(await navLinks()).not.toHaveLength(0)
    })
    const labels = (await navLinks()).join('|')
    expect(labels).not.toMatch(/Calendar|Kalender/)
    expect(labels).not.toMatch(/Files|Dateien/)
    // The ungated sections are untouched — this is a filter, not a blanket.
    expect(labels).toMatch(/Mail|E-Mail/)
    expect(labels).toMatch(/Settings|Einstellungen/)
  })

  it('offers them once the account advertises the capability', async () => {
    renderShell({ [CALENDARS]: {}, [FILENODE]: {} })

    await waitFor(async () => {
      expect((await navLinks()).join('|')).toMatch(/Calendar|Kalender/)
    })
    expect((await navLinks()).join('|')).toMatch(/Files|Dateien/)
  })

  it('sends a deep link to a missing section to "not found", not to a capability error', async () => {
    window.history.pushState(null, '', '/calendar')
    try {
      renderShell({})
      await waitFor(() => {
        expect(document.body.textContent ?? '').toMatch(/Page not found|Seite nicht gefunden/i)
      })
    } finally {
      window.history.pushState(null, '', '/')
    }
  })
})

describe('isSectionAvailable', () => {
  const session = fakeJmapSession('acc-1', 'alice@waxwing.test', {
    accountCapabilities: { [CALENDARS]: {} },
  })

  it('reads the ACCOUNT capability level, which is the only one Stalwart fills for these', () => {
    expect(isSectionAvailable('calendar', session, 'acc-1')).toBe(true)
    expect(isSectionAvailable('files', session, 'acc-1')).toBe(false)
  })

  it('never gates the sections that are always there', () => {
    for (const id of ['mail', 'contacts', 'settings', 'notFound'] as const) {
      expect(isSectionAvailable(id, session, 'acc-1')).toBe(true)
      expect(isSectionAvailable(id, null, null)).toBe(true)
    }
  })

  it('hides a gated section while there is no session to ask', () => {
    // Boot and re-auth both pass through here. Offering a section that may not exist and then
    // taking it away reads as a glitch; withholding it until the session is known does not.
    expect(isSectionAvailable('calendar', null, null)).toBe(false)
    expect(isSectionAvailable('files', session, null)).toBe(false)
  })
})

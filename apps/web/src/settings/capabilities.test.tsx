/**
 * Settings → Server (M3.7, FR-SRV-04).
 *
 * The load-bearing test here is the STALWART-SHAPED session: top-level `mail` is `{}` and every real
 * limit lives in `accountCapabilities`. A panel built on `session.capabilities` alone renders an empty
 * mail table against the very server we develop against — while passing any test written with a
 * tidy, hand-made session. So the fixture below is deliberately untidy.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JmapSession } from '../app/session/types'
import { expectNoA11yViolations } from '../test/axe'
import { buildCapabilitiesView } from './capabilities-model'
import { ServerSection } from './ServerSection'

const ACC = 'b'

const CORE = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: ['i;ascii-numeric'],
}

const WEBPUSH_VAPID = 'urn:ietf:params:jmap:webpush-vapid'

/**
 * The real shape Stalwart v0.16 sends: an EMPTY top-level `mail`, the limits on the account.
 *
 * **This fixture must keep mirroring the PINNED fixture server, and that is load-bearing.** Its E2E
 * sibling (`e2e/tests/settings.spec.ts`, "the capabilities panel matches the session document")
 * derives each Offered / Not-offered from the LIVE session document. The moment this hand-made
 * session disagrees with what the pinned Stalwart advertises, the two tests assert opposite worlds
 * and neither one can notice — which is exactly what happened to `webPushVapid` below when the pin
 * moved to v0.16.14.
 */
function stalwartSession(over: Partial<JmapSession> = {}): JmapSession {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': CORE,
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:vacationresponse': {},
      'urn:ietf:params:jmap:quota': {},
      'urn:ietf:params:jmap:principals:availability': {},
      // RFC 9749. Stalwart v0.16.14 (2026-07-20) implements it and auto-generates the keypair on a
      // virgin registry, so a stock install advertises this with a real key.
      [WEBPUSH_VAPID]: { applicationServerKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkTVfzcJhBk' },
    },
    accounts: {
      [ACC]: {
        name: 'alice@waxwing.test',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {
            maxMailboxesPerEmail: null,
            maxMailboxDepth: 10,
            maxSizeMailboxName: 255,
            maxSizeAttachmentsPerEmail: 50_000_000,
            emailQuerySortOptions: ['receivedAt', 'subject'],
            mayCreateTopLevelMailbox: true,
          },
          'urn:ietf:params:jmap:quota': {},
        },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': ACC },
    username: 'alice@waxwing.test',
    apiUrl: 'http://localhost:18080/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    state: 's',
    ...over,
  } as JmapSession
}

describe('buildCapabilitiesView', () => {
  it('reads the mail limits from the ACCOUNT, not the empty top-level capability', () => {
    // The regression guard. Stalwart's `session.capabilities['…:mail']` is `{}`; reading limits from
    // there yields nothing, and the panel silently renders an empty table against our own fixture.
    const view = buildCapabilitiesView(stalwartSession(), ACC)
    expect(view.mail).not.toBeNull()
    expect(view.mail).toContainEqual({
      key: 'maxMailboxDepth',
      value: { kind: 'count', value: 10 },
    })
    expect(view.mail).toContainEqual({
      key: 'maxSizeAttachmentsPerEmail',
      value: { kind: 'bytes', value: 50_000_000 },
    })
  })

  it('renders an RFC null limit as "no limit", not as a missing row', () => {
    const view = buildCapabilitiesView(stalwartSession(), ACC)
    expect(view.mail).toContainEqual({ key: 'maxMailboxesPerEmail', value: { kind: 'unlimited' } })
  })

  it('reports presence from EITHER level', () => {
    const view = buildCapabilitiesView(stalwartSession(), ACC)
    const present = (key: string) => view.known.find((row) => row.key === key)?.present
    expect(present('vacationResponse')).toBe(true) // session level only
    expect(present('quota')).toBe(true) // both levels
    expect(present('sieve')).toBe(false) // neither
  })

  /**
   * The RFC 9749 row, which until 2026-07-21 was pinned to `false` with the comment "no server has
   * it (ADR-010)". A server that has it now exists — Stalwart v0.16.14, released 2026-07-20 — so
   * the comment was false and the assertion was pinning a fact about the world, not about the code.
   *
   * Flipping it to `true` would repeat the mistake in the other direction, so the property asserted
   * is the one that survives the world changing again: the row **tracks the session document**.
   * A v0.16.14-shaped session reports Offered; the same session with the capability taken away (any
   * pre-v0.16.14 server, or any other JMAP server today) reports Not offered. Hardcoding either
   * answer fails one of the two.
   *
   * Note what this row does NOT claim. It is a PRESENCE row: "the server offers RFC 9749". Waxwing
   * still delivers no background push — the client half (subscribe, `PushSubscription/set`, a `push`
   * listener) was never built and reversing ADR-010 is an open owner decision. The Notifications
   * section says so in words, and it branches on a stricter predicate than this one
   * (`serverSupportsBackgroundPush`, which also requires a usable `applicationServerKey`).
   */
  it('tracks the session document for RFC 9749, rather than pinning an answer', () => {
    const offered = (session: JmapSession): boolean | undefined =>
      buildCapabilitiesView(session, ACC).known.find((row) => row.key === 'webPushVapid')?.present

    expect(offered(stalwartSession())).toBe(true)

    const older = stalwartSession()
    delete older.capabilities[WEBPUSH_VAPID]
    expect(offered(older)).toBe(false)
  })

  it('surfaces URNs it does not have a name for, rather than swallowing them', () => {
    const view = buildCapabilitiesView(stalwartSession(), ACC)
    expect(view.extra).toContain('urn:ietf:params:jmap:principals:availability')
  })

  it('is null — not an empty table — when the account advertises no mail capability', () => {
    const session = stalwartSession()
    session.accounts[ACC] = {
      ...session.accounts[ACC],
      accountCapabilities: {},
    } as (typeof session.accounts)[string]
    const view = buildCapabilitiesView(session, ACC)
    expect(view.mail).toBeNull()
  })

  it('is null for core too, on a non-conformant server', () => {
    const session = stalwartSession({ capabilities: {} })
    expect(buildCapabilitiesView(session, ACC).core).toBeNull()
  })

  it('shows the API ORIGIN, not the full endpoint path', () => {
    expect(buildCapabilitiesView(stalwartSession(), ACC).apiOrigin).toBe('http://localhost:18080')
  })
})

describe('<ServerSection>', () => {
  // B20.6. Four groups in a row rendered their heading as a plain <span> and their body as a <dl>,
  // with nothing joining the two — so a screen reader announced four unnamed description lists and
  // the headings floated free of the data they introduced.
  it('names every breakdown list after the heading above it', () => {
    const { container } = render(<ServerSection session={stalwartSession()} accountId={ACC} />)

    // Queried through the DOM rather than by role: `<dl>` has no `list` role in the HTML-AAM
    // mapping, which is precisely why its accessible NAME is the only handle a screen reader gets.
    const lists = [...container.querySelectorAll('dl, ul')]
    expect(lists.length, 'no breakdown lists rendered — the assertion would be vacuous').toBe(5)

    for (const list of lists) {
      const labelledBy = list.getAttribute('aria-labelledby')
      expect(labelledBy, `an unnamed ${list.tagName.toLowerCase()}`).not.toBeNull()
      const heading = container.querySelector(`#${CSS.escape(labelledBy ?? '')}`)
      expect(heading?.textContent ?? '', 'points at a heading that is empty or missing').not.toBe(
        '',
      )
    }
  })

  it('states availability in WORDS — a colour is not an answer for everyone', async () => {
    const { container } = render(<ServerSection session={stalwartSession()} accountId={ACC} />)

    expect(screen.getByText('Vacation responder').nextSibling).toHaveTextContent('Offered')
    expect(screen.getByText('Filter rules (Sieve)').nextSibling).toHaveTextContent('Not offered')
    // …and the account-only mail limits actually reach the screen.
    expect(screen.getByText('Folder nesting depth').nextSibling).toHaveTextContent('10')
    expect(screen.getByText('Folders per message').nextSibling).toHaveTextContent('No limit')

    await expectNoA11yViolations(container)
  })

  it('says so in a sentence when the account has no mail capability', () => {
    const session = stalwartSession()
    session.accounts[ACC] = {
      ...session.accounts[ACC],
      accountCapabilities: {},
    } as (typeof session.accounts)[string]

    render(<ServerSection session={session} accountId={ACC} />)
    expect(screen.getByText(/no mail capability/i)).toBeInTheDocument()
    expect(screen.queryByText('Folder nesting depth')).not.toBeInTheDocument()
  })
})

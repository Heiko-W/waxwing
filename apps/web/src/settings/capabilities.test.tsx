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

/** The real shape Stalwart v0.16 sends: an EMPTY top-level `mail`, the limits on the account. */
function stalwartSession(over: Partial<JmapSession> = {}): JmapSession {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': CORE,
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:vacationresponse': {},
      'urn:ietf:params:jmap:quota': {},
      'urn:ietf:params:jmap:principals:availability': {},
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
    expect(present('webPushVapid')).toBe(false) // no server has it (ADR-010)
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

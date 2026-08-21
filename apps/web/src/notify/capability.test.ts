/**
 * The RFC 9749 probe (M3.6). It is what lets the Notifications settings say, truthfully and without a
 * hardcoded claim, whether this server COULD notify while the app is CLOSED — see ADR-010 and its
 * amendment. `true` means the server could, not that Waxwing delivers it: the client half is
 * unimplemented, and the settings copy says so.
 */

import type { Session } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { serverSupportsBackgroundPush, serverSupportsEmailPush } from './capability'

const session = (
  capabilities: Record<string, unknown>,
  accounts: Record<string, unknown> = {},
): Session => ({ capabilities, accounts }) as unknown as Session

describe('serverSupportsBackgroundPush', () => {
  // Stalwart v0.16.14 (2026-07-20) auto-generates a VAPID keypair on a virgin registry, so this is
  // now the case a stock fixture hits — not a hypothetical.
  it('is true when the server advertises a usable application server key', () => {
    expect(
      serverSupportsBackgroundPush(
        session({
          'urn:ietf:params:jmap:core': {},
          'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: 'BEd3…key' },
        }),
      ),
    ).toBe(true)
  })

  it('is false against a server that does not advertise the capability', () => {
    // What Stalwart advertised up to v0.16.13, and what any JMAP server without RFC 9749 still
    // advertises. It is why the settings screen explains itself instead of offering a switch that
    // could not work.
    expect(
      serverSupportsBackgroundPush(
        session({
          'urn:ietf:params:jmap:core': {},
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:submission': {},
          'urn:ietf:params:jmap:websocket': {},
        }),
      ),
    ).toBe(false)
  })

  it('is false for a malformed capability — an advertised key we cannot use is not a key', () => {
    expect(
      serverSupportsBackgroundPush(session({ 'urn:ietf:params:jmap:webpush-vapid': {} })),
    ).toBe(false)
    expect(
      serverSupportsBackgroundPush(
        session({ 'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: '' } }),
      ),
    ).toBe(false)
    expect(
      serverSupportsBackgroundPush(
        session({ 'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: 42 } }),
      ),
    ).toBe(false)
    expect(
      serverSupportsBackgroundPush(session({ 'urn:ietf:params:jmap:webpush-vapid': null })),
    ).toBe(false)
  })

  it('is false when disconnected — we cannot promise what we cannot check', () => {
    expect(serverSupportsBackgroundPush(null)).toBe(false)
  })
})

/**
 * `draft-ietf-jmap-emailpush-03` (ADR-017 amendment, 2026-08-21) — a SECOND, independent probe.
 *
 * Independent because the two capabilities are: RFC 9749 makes a background push possible at all,
 * this draft only changes what it contains. Conflating them would either offer content against a
 * server that cannot deliver it or withhold it from one that can — and the interesting case, the one
 * every non-Stalwart JMAP server is in, is "the first without the second".
 */
describe('serverSupportsEmailPush', () => {
  it('is true when the server advertises the URN', () => {
    expect(
      serverSupportsEmailPush(
        session({
          'urn:ietf:params:jmap:core': {},
          'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: 'BEd3…key' },
          'urn:ietf:params:jmap:emailpush': {},
        }),
      ),
    ).toBe(true)
  })

  /**
   * Stalwart up to v0.16.15, and every other JMAP server today. Waxwing must keep working against
   * it exactly as before — this `false` is what makes every request identical to the previous build.
   */
  it('is false for a server that can sign a push but cannot fill one', () => {
    const capable = session({
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: 'BEd3…key' },
    })
    expect(serverSupportsBackgroundPush(capable)).toBe(true)
    expect(serverSupportsEmailPush(capable)).toBe(false)
  })

  it('is false when disconnected', () => {
    expect(serverSupportsEmailPush(null)).toBe(false)
  })
})

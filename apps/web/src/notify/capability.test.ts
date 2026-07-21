/**
 * The RFC 9749 probe (M3.6). It is what lets the Notifications settings say, truthfully and without a
 * hardcoded claim, whether this server COULD notify while the app is CLOSED — see ADR-010 and its
 * amendment. `true` means the server could, not that Waxwing delivers it: the client half is
 * unimplemented, and the settings copy says so.
 */

import type { Session } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { serverSupportsBackgroundPush } from './capability'

const session = (capabilities: Record<string, unknown>): Session =>
  ({ capabilities }) as unknown as Session

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

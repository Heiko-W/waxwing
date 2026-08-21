/**
 * The subscribe decision (M4.0). Every case here is a way notifications can stop without anyone
 * being told, which is what makes this file worth more than its length suggests: a subscription that
 * has quietly lapsed looks exactly like a mailbox with no new mail.
 */

import { describe, expect, it } from 'vitest'
import { planPushSubscription, RENEW_BEFORE_MS } from './push-plan'
import type { PushRegistrationRecord } from './push-store'

const NOW = Date.parse('2026-07-23T12:00:00Z')
const KEY =
  'BLjc7wAlpyEjBJLAhjRWZ5O_g4HspzJGSgk8iUmmqzCFZ8fcHRA0AghHk3KaVU9EJuC-y2yYTBt25bnLw3rylew'
const ENDPOINT = 'https://push.example/endpoint/abc'

const stored = (over: Partial<PushRegistrationRecord> = {}): PushRegistrationRecord => ({
  subscriptionId: 'sub-1',
  endpoint: ENDPOINT,
  applicationServerKey: KEY,
  expires: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  emailPush: false,
  ...over,
})

const plan = (over: Partial<Parameters<typeof planPushSubscription>[0]> = {}) =>
  planPushSubscription({
    stored: stored(),
    endpoint: ENDPOINT,
    applicationServerKey: KEY,
    serverHasSubscription: true,
    expires: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    now: NOW,
    // The default is a server without `urn:ietf:params:jmap:emailpush`, which is what makes every
    // existing case below a regression guard for "unchanged against a stock server".
    wantEmailPush: false,
    ...over,
  })

describe('planPushSubscription', () => {
  it('keeps a healthy subscription', () => {
    expect(plan()).toEqual({ kind: 'keep', subscriptionId: 'sub-1' })
  })

  it('creates when nothing was ever registered', () => {
    expect(plan({ stored: null })).toEqual({ kind: 'create', destroyId: null })
  })

  /**
   * A push service rotated the endpoint, or the user cleared site data. The server's row now points
   * at an endpoint that receives nothing — so it is named for destruction rather than left to expire
   * on its own, which would leave the server pushing into the void for another week.
   */
  it('recreates AND destroys the old row when the browser endpoint changed', () => {
    expect(plan({ endpoint: 'https://push.example/endpoint/xyz' })).toEqual({
      kind: 'create',
      destroyId: 'sub-1',
    })
  })

  /**
   * An endpoint is bound to the VAPID key it was minted against (RFC 8292 §4.2). After a server
   * rotates its key the old endpoint still exists and still answers `getSubscription()`, while every
   * push to it is rejected — silently, from the app's point of view.
   */
  it('recreates when the server rotated its application server key', () => {
    expect(plan({ applicationServerKey: 'B-different-key' })).toEqual({
      kind: 'create',
      destroyId: 'sub-1',
    })
  })

  it('creates with nothing to destroy when the server no longer has our subscription', () => {
    expect(plan({ serverHasSubscription: false })).toEqual({ kind: 'create', destroyId: null })
  })

  /**
   * Order matters: identity before lifetime. A `renew` against a subscription the server has dropped
   * is an update to nothing — it succeeds as a no-op with `notUpdated`, and the app goes on believing
   * it is subscribed. This is the case that would have made the bug invisible.
   */
  it('prefers create over renew when the server has dropped a near-expiry subscription', () => {
    expect(
      plan({ serverHasSubscription: false, expires: new Date(NOW + 60_000).toISOString() }),
    ).toEqual({ kind: 'create', destroyId: null })
  })

  describe('the renewal margin', () => {
    it('renews inside the margin', () => {
      const expires = new Date(NOW + RENEW_BEFORE_MS - 60_000).toISOString()
      expect(plan({ expires })).toEqual({ kind: 'renew', subscriptionId: 'sub-1' })
    })

    it('keeps just outside it', () => {
      const expires = new Date(NOW + RENEW_BEFORE_MS + 60_000).toISOString()
      expect(plan({ expires })).toEqual({ kind: 'keep', subscriptionId: 'sub-1' })
    })

    it('renews exactly at the boundary — the margin is inclusive', () => {
      const expires = new Date(NOW + RENEW_BEFORE_MS).toISOString()
      expect(plan({ expires })).toEqual({ kind: 'renew', subscriptionId: 'sub-1' })
    })

    it('renews an already-expired subscription rather than treating it as healthy', () => {
      expect(plan({ expires: new Date(NOW - 1000).toISOString() })).toEqual({
        kind: 'renew',
        subscriptionId: 'sub-1',
      })
    })

    /**
     * The margin has to survive a weekend. Stalwart grants seven days; a user who opens the app on
     * Friday and next on Monday must still be covered, and two days is what buys that.
     */
    it('is wide enough that a Friday visit covers a Monday return', () => {
      const friday = Date.parse('2026-07-24T18:00:00Z')
      const granted = new Date(friday + 7 * 24 * 60 * 60 * 1000).toISOString()
      const monday = Date.parse('2026-07-27T09:00:00Z')
      // On Friday: nothing to do. By Monday the app is open again, well before the grant lapses.
      expect(plan({ now: friday, expires: granted })).toEqual({
        kind: 'keep',
        subscriptionId: 'sub-1',
      })
      expect(granted > new Date(monday).toISOString()).toBe(true)
    })
  })

  it('keeps a subscription the server says never expires', () => {
    expect(plan({ expires: null })).toEqual({ kind: 'keep', subscriptionId: 'sub-1' })
  })

  /**
   * An unparsable date is a value we cannot act on. Renewing costs one redundant call; trusting it
   * costs the feature, silently, at a moment nobody is watching.
   */
  it('renews rather than trusting an expiry it cannot parse', () => {
    expect(plan({ expires: 'next Tuesday' })).toEqual({ kind: 'renew', subscriptionId: 'sub-1' })
  })
})

/**
 * `draft-ietf-jmap-emailpush-03` (ADR-017 amendment, 2026-08-21). The subscription can be perfectly
 * healthy and still be configured to push a different amount of CONTENT than the user now wants —
 * a state no other input in this file can express, and one that no error would ever report.
 */
describe('planPushSubscription — the emailPush configuration', () => {
  it('reconfigures a healthy subscription when the user turned the preview ON', () => {
    expect(plan({ stored: stored({ emailPush: false }), wantEmailPush: true })).toEqual({
      kind: 'reconfigure',
      subscriptionId: 'sub-1',
    })
  })

  /**
   * The direction that matters. Left alone, the server keeps putting subjects in a push that reaches
   * the device of someone who has just said they do not want them — and the subscription looks
   * healthy from every other angle, so nothing else in this file would ever act on it.
   */
  it('reconfigures when the user turned the preview OFF', () => {
    expect(plan({ stored: stored({ emailPush: true }), wantEmailPush: false })).toEqual({
      kind: 'reconfigure',
      subscriptionId: 'sub-1',
    })
  })

  it('keeps when the server already holds what the user wants', () => {
    expect(plan({ stored: stored({ emailPush: true }), wantEmailPush: true })).toEqual({
      kind: 'keep',
      subscriptionId: 'sub-1',
    })
    expect(plan({ stored: stored({ emailPush: false }), wantEmailPush: false })).toEqual({
      kind: 'keep',
      subscriptionId: 'sub-1',
    })
  })

  /**
   * A renewal is already an `update`, so the content patch rides along with it (see
   * `push-subscribe.ts#applyPlan`). Reporting `reconfigure` here instead would drop the renewal, and
   * the subscription would lapse in seven days — trading the failure this file exists to prevent
   * for the one it just learned about.
   */
  it('still renews when both are due — the lifetime question is not lost to the content one', () => {
    const expiring = new Date(NOW + RENEW_BEFORE_MS - 1000).toISOString()
    expect(
      plan({
        stored: stored({ emailPush: false, expires: expiring }),
        expires: expiring,
        wantEmailPush: true,
      }),
    ).toEqual({ kind: 'renew', subscriptionId: 'sub-1' })
  })

  /** A create sends the wanted configuration from the start; there is nothing to reconcile. */
  it('creates rather than reconfigures when the endpoint moved', () => {
    expect(
      plan({
        stored: stored({ emailPush: false }),
        endpoint: 'https://push.example/endpoint/new',
        wantEmailPush: true,
      }),
    ).toEqual({ kind: 'create', destroyId: 'sub-1' })
  })

  /**
   * A server that never grants an expiry (the RFC permits `null`) would otherwise never take a
   * reconfiguration: the branch above it returns `keep` unconditionally, and only a create could
   * ever change the configuration again.
   */
  it('reconfigures even when the server grants no expiry at all', () => {
    expect(
      plan({ stored: stored({ emailPush: false }), expires: null, wantEmailPush: true }),
    ).toEqual({ kind: 'reconfigure', subscriptionId: 'sub-1' })
  })
})

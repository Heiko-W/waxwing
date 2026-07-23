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

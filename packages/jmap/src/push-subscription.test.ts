/**
 * `PushSubscription/get|set` (M4.0, RFC 8620 §7.2) — the one `get`/`set` pair in JMAP that neither
 * takes nor returns an `accountId`, because a subscription belongs to the CREDENTIALS.
 *
 * The shapes asserted here are not read off the RFC. They are what Stalwart v0.16.14 actually sent
 * when the decision was being taken, and the two disagree in a way that matters: the RFC says no
 * `accountId` is returned, Stalwart returns one and omits `state`. Typing either as required would
 * break against a real server; this file is where that stays pinned.
 */

import { describe, expect, it } from 'vitest'
import { capabilityForMethod, usingForMethods } from './capabilities'
import { Methods } from './methods'
import { RequestBuilder } from './request'
import type {
  PushSubscription,
  PushSubscriptionGetResponse,
  PushSubscriptionSetResponse,
} from './types/push'
import { EMAIL_DELIVERY_TYPE } from './types/push'

describe('the method registry', () => {
  it('registers both methods under their wire names', () => {
    expect(Methods.pushSubscriptionGet.name).toBe('PushSubscription/get')
    expect(Methods.pushSubscriptionSet.name).toBe('PushSubscription/set')
  })

  /**
   * **`using` must be core, never the VAPID URN.** RFC 9749's capability is a session-level
   * ANNOUNCEMENT of a key, not a method capability. Naming it in `using` would make the whole
   * request fail on any server that pushes without VAPID — a request-level error, so it would take
   * every other call in the batch down with it (the `Quota/get` lesson, M3.7).
   */
  it('requires only jmap:core', () => {
    expect(capabilityForMethod('PushSubscription/get')).toBe('urn:ietf:params:jmap:core')
    expect(capabilityForMethod('PushSubscription/set')).toBe('urn:ietf:params:jmap:core')
    expect(usingForMethods(['PushSubscription/set'])).toEqual(['urn:ietf:params:jmap:core'])
    expect(usingForMethods(['PushSubscription/set'])).not.toContain(
      'urn:ietf:params:jmap:webpush-vapid',
    )
  })
})

describe('the request shape', () => {
  it('carries no accountId — a subscription belongs to the credentials, not an account', () => {
    const builder = new RequestBuilder(async () => {
      throw new Error('not sent')
    })
    builder.invoke(Methods.pushSubscriptionGet, { ids: null })
    const [invocation] = builder.invocations
    expect(invocation?.[0]).toBe('PushSubscription/get')
    expect(invocation?.[1]).not.toHaveProperty('accountId')
  })

  it('accepts the create body M4.0 sends, types filter included', () => {
    const create: Partial<PushSubscription> = {
      deviceClientId: 'waxwing-device-1',
      url: 'https://push.example/endpoint/abc',
      keys: { p256dh: 'BLjc', auth: 'aBcD' },
      types: [EMAIL_DELIVERY_TYPE],
    }
    expect(create.types).toEqual(['EmailDelivery'])
  })
})

describe('the response shape, as Stalwart v0.16.14 really sends it', () => {
  /**
   * Verbatim from the live probe of 2026-07-23. `accountId` present, `state` absent — the opposite
   * of what RFC 8620 §7.2.1 describes. Both are typed optional, which is the only reading that
   * survives this server AND a standard-shaped one.
   */
  it('reads a get response that carries accountId and no state', () => {
    const response: PushSubscriptionGetResponse = JSON.parse(
      '{"accountId":"b","list":[{"id":"b","deviceClientId":"waxwing-d6a-probe",' +
        '"verificationCode":null,"expires":"2026-07-30T04:55:11Z","types":["EmailDelivery"]}],' +
        '"notFound":[]}',
    ) as PushSubscriptionGetResponse

    expect(response.state).toBeUndefined()
    expect(response.accountId).toBe('b')
    const row = response.list[0]
    expect(row?.types).toEqual(['EmailDelivery'])
    // Not yet verified: until the client writes the code back, the server pushes nothing else.
    expect(row?.verificationCode).toBeNull()
    // Seven days from the create — the server's ceiling, not our request (ADR-017).
    expect(row?.expires).toBe('2026-07-30T04:55:11Z')
  })

  /**
   * `keys` comes back NULL right after a successful create, and that is correct, not a bug to work
   * around: a subscription's encryption material leaving the server would defeat RFC 8291. Anything
   * that tries to reconcile local and server keys by comparing them will compare against null.
   */
  it('reads a set response whose created row hides the keys', () => {
    const response: PushSubscriptionSetResponse = JSON.parse(
      '{"accountId":"b","created":{"p":{"id":"b","keys":null,"expires":"2026-07-30T04:55:11Z"}}}',
    ) as PushSubscriptionSetResponse

    expect(response.newState).toBeUndefined()
    expect(response.created?.p?.keys).toBeNull()
    expect(response.created?.p?.id).toBe('b')
  })

  it('reads the refusal a bad key earns', () => {
    // Also verbatim: what the live probe got back for a made-up P-256 point.
    const response: PushSubscriptionSetResponse = JSON.parse(
      '{"accountId":"b","notCreated":{"p":{"type":"invalidProperties",' +
        '"description":"Invalid P-256 ECDH public key.","properties":["keys"]}}}',
    ) as PushSubscriptionSetResponse

    expect(response.created ?? null).toBeNull()
    expect(response.notCreated?.p?.type).toBe('invalidProperties')
  })
})

describe('EMAIL_DELIVERY_TYPE', () => {
  it('is the wire name, exported as a value so callers need no string literal', () => {
    expect(EMAIL_DELIVERY_TYPE).toBe('EmailDelivery')
  })
})

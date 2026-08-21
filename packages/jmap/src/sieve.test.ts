/**
 * RFC 9661 — JMAP for Sieve Scripts (M5.2, FR-SIEVE-01/02).
 *
 * The interesting assertions here are not the method names — they are the three places where
 * following the RFC literally produces a client that misbehaves against a real server:
 *
 * 1. **Error spellings.** Draft -17 renamed `invalidScript` → `invalidSieve` and
 *    `scriptIsActive` → `sieveIsActive`. Stalwart still emits the old pair, so matching only the
 *    RFC spelling turns "your script does not compile" into an unrecognised failure.
 * 2. **`onSuccessActivateScript: null` does not deactivate.** The RFC requires an invalid or
 *    absent id to be ignored, leaving the active script active. Deactivating needs
 *    `onSuccessDeactivateScript: true`.
 * 3. **Content is never inline.** A `/set` and a `/validate` both address the script by blob.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Invocation } from './types/core'
import { isInvalidSieveError, isSieveIsActiveError, SIEVE_CONTENT_TYPE } from './types/sieve'

const ACC = 'a'

/** Echoes a plausible `/set` response so the builder resolves. */
function setResponder() {
  return jmapPostMock((body) => {
    const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
      name,
      { accountId: ACC, oldState: 'n', newState: 'o', created: null, updated: null },
      id,
    ])
    return { methodResponses, sessionState: 's0' }
  })
}

describe('SieveScript (RFC 9661)', () => {
  it('binds the three method names it calls — and only those', () => {
    expect(Methods.sieveScriptGet.name).toBe('SieveScript/get')
    expect(Methods.sieveScriptSet.name).toBe('SieveScript/set')
    expect(Methods.sieveScriptValidate.name).toBe('SieveScript/validate')

    // RFC 9661 defines no `/changes` and no `/queryChanges`, so a caller cannot reach for one and
    // discover at runtime that the server answers `unknownMethod`.
    expect(Methods).not.toHaveProperty('sieveScriptChanges')
    expect(Methods).not.toHaveProperty('sieveScriptQueryChanges')

    /*
     * `SieveScript/query` is the RFC's fourth method and DOES work on Stalwart v0.16.18 (measured:
     * it answers `canCalculateChanges: true` on an empty account). It is absent anyway, because the
     * registry states what this client calls: the script list is read whole by
     * `SieveScript/get {ids:null}` (`settings/sieve/sieve-client.ts`), so a typed binding for a
     * paged, filtered script query only ever told a reader that a paging path existed.
     */
    expect(Methods).not.toHaveProperty('sieveScriptQuery')
  })

  it('auto-adds the sieve capability to `using`', () => {
    const using = usingForMethods(['SieveScript/get', 'SieveScript/set'])
    expect(using).toContain('urn:ietf:params:jmap:sieve')
    expect(using).toContain('urn:ietf:params:jmap:core')
  })

  it('uploads script content as application/sieve', () => {
    expect(SIEVE_CONTENT_TYPE).toBe('application/sieve')
  })

  describe('SetError spellings', () => {
    // Stalwart ships the pre-RFC names. Matching one spelling only is the bug this pins.
    it('recognises "does not compile" under BOTH the RFC and the draft spelling', () => {
      expect(isInvalidSieveError('invalidSieve')).toBe(true)
      expect(isInvalidSieveError('invalidScript')).toBe(true)
    })

    it('recognises "cannot destroy the active script" under BOTH spellings', () => {
      expect(isSieveIsActiveError('sieveIsActive')).toBe(true)
      expect(isSieveIsActiveError('scriptIsActive')).toBe(true)
    })

    it('does not swallow unrelated error types', () => {
      for (const type of ['alreadyExists', 'tooLarge', 'overQuota', 'forbidden', 'invalid']) {
        expect(isInvalidSieveError(type)).toBe(false)
        expect(isSieveIsActiveError(type)).toBe(false)
      }
    })
  })

  it('carries `onSuccessActivateScript` — including a creation reference — on a create', async () => {
    const { fetch, calls } = setResponder()
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.sieveScriptSet, {
      accountId: ACC,
      create: { new: { name: 'waxwing', blobId: 'B1' } },
      onSuccessActivateScript: '#new',
    })
    await builder.send()

    const [name, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(name).toBe('SieveScript/set')
    expect(args).toEqual({
      accountId: ACC,
      create: { new: { name: 'waxwing', blobId: 'B1' } },
      onSuccessActivateScript: '#new',
    })
    // The octets went to the blob endpoint; the object only points at them.
    expect(JSON.stringify(args)).not.toContain('content')
  })

  it('deactivates with `onSuccessDeactivateScript`, never with a null activate id', async () => {
    const { fetch, calls } = setResponder()
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.sieveScriptSet, {
      accountId: ACC,
      update: { s1: { name: 'renamed' } },
      onSuccessDeactivateScript: true,
    })
    await builder.send()

    const [, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(args).toHaveProperty('onSuccessDeactivateScript', true)
    // `onSuccessActivateScript: null` is a no-op per RFC 9661 §2.4 — sending it instead would
    // leave the previous script filtering mail while the UI claims filtering is off.
    expect(args).not.toHaveProperty('onSuccessActivateScript')
  })

  it('validates by blob id, not by content', async () => {
    const { fetch, calls } = jmapPostMock((body) => {
      const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
        name,
        { accountId: ACC, error: null },
        id,
      ])
      return { methodResponses, sessionState: 's0' }
    })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    const call = builder.invoke(Methods.sieveScriptValidate, { accountId: ACC, blobId: 'B7' })
    const responses = await builder.send()

    const [, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(args).toEqual({ accountId: ACC, blobId: 'B7' })
    // "Valid" is the ABSENCE of an error object; there is no `isValid` field to read.
    expect(responses.get(call).error).toBeNull()
  })
})

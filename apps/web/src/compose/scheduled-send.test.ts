/**
 * Scheduled send (M5.4, FR-CMP-11).
 *
 * The two assertions that matter are both about NOT trusting a number: the server's advertised
 * maximum delay is larger than what it enforces, and a time in the past must be refused rather than
 * silently sent now.
 */

import type { Session } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  CONSERVATIVE_MAX_MS,
  checkScheduleTime,
  HOLD_UNTIL_PARAM,
  holdUntilParameters,
  maxScheduleMs,
  supportsScheduledSend,
} from './scheduled-send'

const ACC = 'a'
const SUBMISSION = 'urn:ietf:params:jmap:submission'

function session(capability: Record<string, unknown> | undefined): Session {
  return {
    capabilities: {},
    accounts: {
      [ACC]: { accountCapabilities: capability === undefined ? {} : { [SUBMISSION]: capability } },
    },
  } as unknown as Session
}

/** What Stalwart actually advertises: 30 days, and FUTURERELEASE among the extensions. */
const STALWART = {
  maxDelayedSend: 2_592_000,
  submissionExtensions: { FUTURERELEASE: [], SIZE: [], DSN: [] },
}

describe('supportsScheduledSend', () => {
  it('is true when the server advertises FUTURERELEASE and a delay', () => {
    expect(supportsScheduledSend(session(STALWART), ACC)).toBe(true)
  })

  it('is false without the FUTURERELEASE extension, however large the delay', () => {
    // A delay the server cannot be ASKED for is not a feature: the parameter would come back as a
    // rejected envelope rather than a scheduled message.
    expect(
      supportsScheduledSend(session({ maxDelayedSend: 2_592_000, submissionExtensions: {} }), ACC),
    ).toBe(false)
  })

  it('is false when the server says it supports no delay at all', () => {
    expect(
      supportsScheduledSend(
        session({ maxDelayedSend: 0, submissionExtensions: { FUTURERELEASE: [] } }),
        ACC,
      ),
    ).toBe(false)
  })

  it('is false without a session or an account', () => {
    expect(supportsScheduledSend(null, ACC)).toBe(false)
    expect(supportsScheduledSend(session(STALWART), null)).toBe(false)
    expect(supportsScheduledSend(session(undefined), ACC)).toBe(false)
  })
})

describe('maxScheduleMs', () => {
  it('caps below what the server advertises', () => {
    // Stalwart advertises 30 days and enforces 7. Trusting the advertisement hands the user a date
    // the server then refuses with `forbiddenMailFrom` at submission time.
    expect(maxScheduleMs(session(STALWART), ACC)).toBe(CONSERVATIVE_MAX_MS)
  })

  it('honours a server that advertises LESS than the cap', () => {
    const modest = { maxDelayedSend: 3600, submissionExtensions: { FUTURERELEASE: [] } }
    expect(maxScheduleMs(session(modest), ACC)).toBe(3_600_000)
  })

  it('is zero where scheduling is unavailable', () => {
    expect(maxScheduleMs(session(undefined), ACC)).toBe(0)
  })
})

describe('checkScheduleTime', () => {
  const now = Date.parse('2026-08-19T12:00:00Z')

  it('accepts a time inside the window', () => {
    expect(checkScheduleTime(new Date(now + 3_600_000), now, CONSERVATIVE_MAX_MS)).toBeNull()
  })

  it('REFUSES a time in the past rather than sending now', () => {
    // The server refuses it too. A client that silently sent immediately would deliver a message
    // the user believed they had deferred.
    expect(checkScheduleTime(new Date(now - 1000), now, CONSERVATIVE_MAX_MS)).toBe('past')
    expect(checkScheduleTime(new Date(now), now, CONSERVATIVE_MAX_MS)).toBe('past')
  })

  it('refuses a time beyond the window', () => {
    expect(
      checkScheduleTime(new Date(now + CONSERVATIVE_MAX_MS + 1000), now, CONSERVATIVE_MAX_MS),
    ).toBe('tooFar')
  })

  it('reports unsupported when the account cannot schedule', () => {
    expect(checkScheduleTime(new Date(now + 1000), now, 0)).toBe('unsupported')
  })
})

describe('holdUntilParameters', () => {
  it('emits an RFC 3339 date-time under the upper-case parameter name', () => {
    // Not a Unix timestamp: RFC 4865 says date-time, and Stalwart only accepts the string form from
    // 0.16.17 onwards.
    const at = new Date('2026-08-20T08:00:00.000Z')
    expect(holdUntilParameters(at)).toEqual({ [HOLD_UNTIL_PARAM]: '2026-08-20T08:00:00.000Z' })
    expect(HOLD_UNTIL_PARAM).toBe('HOLDUNTIL')
  })
})

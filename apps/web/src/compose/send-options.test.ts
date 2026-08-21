/**
 * Send options (M-7, M-11) — the wire shapes, checked against what the fixture ACCEPTED.
 *
 * Every expectation here is a measurement from `Stalwart v0.16.18` on `:18080`, not a reading of
 * RFC 3461 / 6710 / 8689. Where the two disagree, these tests follow the server, and the cases that
 * disagree are called out at the assertion.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEND_OPTIONS,
  hasSendOptions,
  mailFromParameters,
  priorityHeaders,
  rcptToParameters,
  readSubmissionExtensions,
  type SendOptions,
  type SubmissionExtensions,
  xtext,
} from './send-options'

const ALL: SubmissionExtensions = { dsn: true, requireTls: true, mtPriority: true }
const NONE: SubmissionExtensions = { dsn: false, requireTls: false, mtPriority: false }
const options = (over: Partial<SendOptions> = {}): SendOptions => ({
  ...DEFAULT_SEND_OPTIONS,
  ...over,
})

describe('readSubmissionExtensions', () => {
  /** The fixture's own answer, copied verbatim from `/jmap/session`. */
  const session = {
    accounts: {
      b: {
        accountCapabilities: {
          'urn:ietf:params:jmap:submission': {
            maxDelayedSend: 2592000,
            submissionExtensions: {
              FUTURERELEASE: [],
              SIZE: [],
              DSN: [],
              DELIVERYBY: [],
              'MT-PRIORITY': ['MIXER'],
              REQUIRETLS: [],
            },
          },
        },
      },
    },
  } as never

  it('reads an extension whose value is an EMPTY array as present', () => {
    // The trap this exists for: `"DSN": []` is an extension that takes no parameters, not a
    // missing one. A truthiness check on the value would report no DSN support on this server.
    expect(readSubmissionExtensions(session, 'b')).toEqual({
      dsn: true,
      requireTls: true,
      mtPriority: true,
    })
  })

  it('reports nothing for an unknown account or an absent session', () => {
    expect(readSubmissionExtensions(session, 'zzz')).toEqual(NONE)
    expect(readSubmissionExtensions(null, 'b')).toEqual(NONE)
    expect(readSubmissionExtensions(session, null)).toEqual(NONE)
  })
})

describe('priorityHeaders', () => {
  it('writes BOTH headers for high, so no reader disagrees with another', () => {
    expect(priorityHeaders('high')).toEqual({
      'header:X-Priority:asText': '1',
      'header:Importance:asText': 'high',
    })
  })

  it('writes both for low', () => {
    expect(priorityHeaders('low')).toEqual({
      'header:X-Priority:asText': '5',
      'header:Importance:asText': 'low',
    })
  })

  it('writes NOTHING for normal — a normal message carries no priority header at all', () => {
    expect(priorityHeaders('normal')).toEqual({})
  })
})

describe('xtext', () => {
  it('passes ordinary address characters through untouched', () => {
    expect(xtext('anna@example.com')).toBe('anna@example.com')
  })

  it('encodes the two characters RFC 3461 reserves, even though they are printable', () => {
    expect(xtext('a+b=c@x.test')).toBe('a+2Bb+3Dc@x.test')
  })

  it('encodes a space — the case that measurably broke the parameter list', () => {
    // Measured: `ORCPT=rfc822;d5 probe@waxwing.test` came back as
    // `Unsupported parameter: PROBE@WAXWING.TEST` — the space ended ORCPT and the rest was read
    // as a new parameter. Encoding is what keeps one odd address from breaking NOTIFY beside it.
    expect(xtext('d5 probe@waxwing.test')).toBe('d5+20probe@waxwing.test')
  })

  it('encodes non-ASCII per UTF-8 BYTE, not per code point', () => {
    expect(xtext('müller@x.test')).toBe('m+C3+BCller@x.test')
  })
})

describe('mailFromParameters', () => {
  it('is null for default options — an ordinary send carries no parameters at all', () => {
    expect(mailFromParameters(DEFAULT_SEND_OPTIONS, ALL)).toBeNull()
  })

  it('asks for HEADERS in a report, never the whole message', () => {
    // FULL would bounce every attachment back at the sender of a large, important message.
    expect(mailFromParameters(options({ deliveryReceipt: true }), ALL)).toEqual({ RET: 'HDRS' })
  })

  it('sends REQUIRETLS with a null VALUE, not an empty string', () => {
    // Measured: `REQUIRETLS: ""` → `Unsupported parameter: REQUIRETLS=`. `null` is a parameter
    // with no value, which is what RFC 8689 defines and what the server takes.
    const params = mailFromParameters(options({ requireTls: true }), ALL)
    expect(params).toEqual({ REQUIRETLS: null })
    expect(params?.REQUIRETLS).toBeNull()
  })

  it('keeps MT-PRIORITY inside the range this server actually accepts', () => {
    // Measured acceptance window: -6 … 5. `-9`, `6` and `9` are all refused with
    // `501 5.5.4 Invalid priority value`, which fails the WHOLE submission, not just the priority.
    const high = Number(mailFromParameters(options({ priority: 'high' }), ALL)?.['MT-PRIORITY'])
    const low = Number(mailFromParameters(options({ priority: 'low' }), ALL)?.['MT-PRIORITY'])
    expect(high).toBeGreaterThan(0)
    expect(high).toBeLessThanOrEqual(5)
    expect(low).toBeLessThan(0)
    expect(low).toBeGreaterThanOrEqual(-6)
  })

  it('combines everything asked for into ONE parameter map', () => {
    expect(
      mailFromParameters(
        options({ deliveryReceipt: true, requireTls: true, priority: 'high' }),
        ALL,
      ),
    ).toEqual({ RET: 'HDRS', REQUIRETLS: null, 'MT-PRIORITY': '4' })
  })

  it('sends NOTHING the account does not advertise, whatever the user picked', () => {
    // The point: a switch the server would reject must never reach the wire. Priority still
    // travels — as headers, which need no extension at all (see priorityHeaders).
    expect(
      mailFromParameters(
        options({ deliveryReceipt: true, requireTls: true, priority: 'high' }),
        NONE,
      ),
    ).toBeNull()
  })
})

describe('rcptToParameters', () => {
  it('is null unless a receipt was asked for', () => {
    expect(rcptToParameters('anna@example.com', DEFAULT_SEND_OPTIONS, ALL)).toBeNull()
  })

  it('names all three report kinds and prefixes ORCPT with rfc822;', () => {
    // Measured: ORCPT without the `rfc822;` address-type prefix is rejected outright.
    expect(rcptToParameters('anna@example.com', options({ deliveryReceipt: true }), ALL)).toEqual({
      NOTIFY: 'SUCCESS,DELAY,FAILURE',
      ORCPT: 'rfc822;anna@example.com',
    })
  })

  it('never mixes NEVER into the NOTIFY set', () => {
    // Measured: `SUCCESS,NEVER` → `Invalid parameter: NOTIFY`. RFC 3461 forbids the combination
    // and this server enforces it, so a set that could ever contain NEVER is a rejected send.
    const notify = rcptToParameters('a@x.test', options({ deliveryReceipt: true }), ALL)?.NOTIFY
    expect(notify).not.toContain('NEVER')
  })

  it('xtext-encodes the address it echoes back', () => {
    expect(rcptToParameters('d5 probe@x.test', options({ deliveryReceipt: true }), ALL)).toEqual({
      NOTIFY: 'SUCCESS,DELAY,FAILURE',
      ORCPT: 'rfc822;d5+20probe@x.test',
    })
  })

  it('stays silent where the account does not advertise DSN', () => {
    expect(rcptToParameters('a@x.test', options({ deliveryReceipt: true }), NONE)).toBeNull()
  })
})

describe('hasSendOptions', () => {
  it('is false only for the untouched default', () => {
    expect(hasSendOptions(DEFAULT_SEND_OPTIONS)).toBe(false)
    expect(hasSendOptions(options({ priority: 'high' }))).toBe(true)
    expect(hasSendOptions(options({ priority: 'low' }))).toBe(true)
    expect(hasSendOptions(options({ deliveryReceipt: true }))).toBe(true)
    expect(hasSendOptions(options({ requireTls: true }))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { parseAuthResults, topmostAuthResults } from './auth-results'

describe('parseAuthResults', () => {
  it('parses the authserv-id and a single method=result (RFC 8601 §B.2)', () => {
    expect(parseAuthResults('example.com; spf=pass smtp.mailfrom=example.net')).toEqual({
      authservId: 'example.com',
      results: [{ method: 'spf', result: 'pass' }],
    })
  })

  it('parses several methods and drops their propspecs (RFC 8601 §B.3)', () => {
    expect(
      parseAuthResults(
        'example.com; auth=pass (cram-md5) smtp.auth=sender@example.net; spf=pass smtp.mailfrom=example.net',
      ),
    ).toEqual({
      authservId: 'example.com',
      results: [
        { method: 'auth', result: 'pass' },
        { method: 'spf', result: 'pass' },
      ],
    })
  })

  it('parses the real-world SPF/DKIM/DMARC triple', () => {
    expect(
      parseAuthResults(
        'mx.stalwart.test; dkim=pass header.d=example.net; spf=pass smtp.mailfrom=bob@example.net; dmarc=pass header.from=example.net',
      ),
    ).toEqual({
      authservId: 'mx.stalwart.test',
      results: [
        { method: 'dkim', result: 'pass' },
        { method: 'spf', result: 'pass' },
        { method: 'dmarc', result: 'pass' },
      ],
    })
  })

  it('ignores comments in parens, including ones sitting between the tokens', () => {
    expect(
      parseAuthResults('example.org (my mta); dkim (good signature) = pass header.i=@example.net'),
    ).toEqual({
      authservId: 'example.org',
      results: [{ method: 'dkim', result: 'pass' }],
    })
  })

  it('ignores nested comments and escaped parens inside them', () => {
    expect(parseAuthResults('example.org (a (nested \\) one) x); spf=fail')).toEqual({
      authservId: 'example.org',
      results: [{ method: 'spf', result: 'fail' }],
    })
  })

  it('strips the method version from method/version=result (RFC 8601 §B.7)', () => {
    expect(parseAuthResults('example.com; dkim/1=pass header.i=@example.net')).toEqual({
      authservId: 'example.com',
      results: [{ method: 'dkim', result: 'pass' }],
    })
  })

  it('accepts the version token after the authserv-id', () => {
    expect(parseAuthResults('example.com 1; spf=pass')).toEqual({
      authservId: 'example.com',
      results: [{ method: 'spf', result: 'pass' }],
    })
  })

  it('tolerates arbitrary whitespace around every token', () => {
    expect(
      parseAuthResults('  example.com  ;   spf   =   pass   smtp.mailfrom=x@y.test  '),
    ).toEqual({ authservId: 'example.com', results: [{ method: 'spf', result: 'pass' }] })
  })

  it('keeps `none` when it is a RESULT (dmarc=none means "no policy", not "no report")', () => {
    expect(parseAuthResults('example.com; spf=none; dmarc=none header.from=example.net')).toEqual({
      authservId: 'example.com',
      results: [
        { method: 'spf', result: 'none' },
        { method: 'dmarc', result: 'none' },
      ],
    })
  })

  it('returns null for the `none` no-result production — there is nothing to show (§B.1)', () => {
    expect(parseAuthResults('example.org 1; none')).toBeNull()
  })

  it('does not split on a semicolon inside a quoted string', () => {
    expect(
      parseAuthResults('example.com; dkim=fail reason="bad signature; really" header.i=@x.test'),
    ).toEqual({
      authservId: 'example.com',
      results: [{ method: 'dkim', result: 'fail' }],
    })
  })

  it('returns null when the authserv-id is missing', () => {
    expect(parseAuthResults('; spf=pass')).toBeNull()
    expect(parseAuthResults('   ; dkim=pass')).toBeNull()
  })

  it('returns null for an empty value', () => {
    expect(parseAuthResults('')).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseAuthResults('!!! ??? ===')).toBeNull()
    expect(parseAuthResults('not a header at all')).toBeNull()
    expect(parseAuthResults('example.com; = ; =pass; spf=')).toBeNull()
  })

  it('drops a segment whose method or result is not an RFC 5321 Keyword, keeping the rest', () => {
    expect(parseAuthResults('example.com; 9bad=pass; spf=pass; dkim=<script>')).toEqual({
      authservId: 'example.com',
      results: [{ method: 'spf', result: 'pass' }],
    })
  })

  it('tolerates a non-string (a legacy row could hold anything)', () => {
    expect(parseAuthResults(undefined as unknown as string)).toBeNull()
    expect(parseAuthResults(42 as unknown as string)).toBeNull()
  })

  // ---- the authserv-id is attacker text (found by adversarial review) ----

  it('REJECTS an authserv-id shaped into a verdict', () => {
    // The id is rendered as "Reported by {id}". Without the token check this parses, and the reader
    // is shown: "Reported by mx.waxwing.test:dkim=pass·spf=pass·dmarc=pass: dkim=fail" — their own
    // MTA's name followed by three passes, for a message that failed. `method`/`result` were always
    // keyword-guarded; the host field was the way around them.
    expect(parseAuthResults('mx.waxwing.test:dkim=pass·spf=pass·dmarc=pass; dkim=fail')).toBeNull()
    expect(parseAuthResults('mx.test=pass; dkim=fail')).toBeNull()
    expect(parseAuthResults('a"b<c>d; dkim=pass')).toBeNull()
  })

  it('REJECTS an absurdly long authserv-id', () => {
    expect(parseAuthResults(`${'a'.repeat(256)}; spf=pass`)).toBeNull()
    // …but a plausible hostname of any real length still parses.
    expect(parseAuthResults(`${'a'.repeat(255)}; spf=pass`)?.authservId).toHaveLength(255)
  })

  it('accepts a quoted-string authserv-id, but holds it to the same bar', () => {
    expect(parseAuthResults('"mx.waxwing.test"; spf=pass')?.authservId).toBe('mx.waxwing.test')
    // Quoting must not become a way to smuggle the verdict back in.
    expect(parseAuthResults('"mx.waxwing.test: dkim=pass"; dkim=fail')).toBeNull()
  })

  // ---- fail CLOSED on a malformed value (found by adversarial review) ----

  it('returns null on an unbalanced comment rather than reporting a SUBSET', () => {
    // Parsing as far as it goes would report a lone `dkim=pass` and silently swallow the two
    // failures after the stray `(` — a partial report shown as a complete one.
    expect(parseAuthResults('mx.test; dkim=pass header.d=x(oops; dmarc=fail; spf=fail')).toBeNull()
  })

  it('returns null on an unterminated quoted string rather than reporting a SUBSET', () => {
    expect(parseAuthResults('mx.test; dkim=pass header.d="oops; dmarc=fail; spf=fail')).toBeNull()
  })
})

describe('topmostAuthResults', () => {
  it('returns the FIRST report, not the last — the one the receiving MTA prepended', () => {
    // THE case this module exists for. A phishing message carries its own forged
    // Authentication-Results; our MTA prepends the truth (RFC 8601 §5). Asking JMAP the obvious way
    // (`:asText`, "the value of the last instance") renders the forgery, so we ask for `:all` and
    // read [0]. If this ever returns the pass, Waxwing is vouching for the attacker.
    const report = topmostAuthResults([
      'mx.stalwart.test; dkim=fail header.d=paypal.test; spf=fail smtp.mailfrom=evil.test; dmarc=fail header.from=paypal.test',
      'mx.paypal.test; dkim=pass header.d=paypal.test; spf=pass smtp.mailfrom=paypal.test; dmarc=pass header.from=paypal.test',
    ])
    expect(report?.authservId).toBe('mx.stalwart.test')
    expect(report?.results).toEqual([
      { method: 'dkim', result: 'fail' },
      { method: 'spf', result: 'fail' },
      { method: 'dmarc', result: 'fail' },
    ])
  })

  it('does NOT fall through to a lower report when the topmost one is unparsable', () => {
    // Falling back would present a report that is strictly CLOSER to the sender as if it were ours.
    expect(topmostAuthResults(['garbage', 'example.com; dmarc=pass'])).toBeNull()
  })

  it('returns null for an empty array (the message carries no such header)', () => {
    expect(topmostAuthResults([])).toBeNull()
  })

  it('returns null for undefined (a body row written before M3.9)', () => {
    expect(topmostAuthResults(undefined)).toBeNull()
  })
})

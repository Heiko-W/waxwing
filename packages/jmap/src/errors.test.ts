import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import {
  errorFromResponse,
  httpStatusOf,
  isSetErrorType,
  JmapHttpError,
  JmapMethodError,
  JmapProblemError,
  JmapRequestError,
  ProblemTypes,
  parseRetryAfter,
} from './errors'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Invocation, SetError } from './types/core'

describe('parseRetryAfter', () => {
  it('parses delta-seconds to milliseconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000)
    expect(parseRetryAfter(' 5 ')).toBe(5000)
  })
  it('returns undefined for an absent or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})

describe('httpStatusOf — the status, whichever class carries it', () => {
  it('finds it on all three, because they are siblings and not subclasses', async () => {
    // The trap this function exists for: `errorFromResponse` picks the class from the SHAPE OF THE
    // BODY, so the same 401 arrives as a `JmapProblemError` from a server that sends a problem
    // document and as a `JmapHttpError` from one that does not. An `instanceof JmapHttpError` guard
    // therefore recognizes a rejected credential on some servers and not on others — which is how
    // the sync outbox dead-lettered a queue (M3.3) and the sign-in screen answered a mistyped
    // password with "Something went wrong" plus an offer to wipe the mailbox (U2).
    const problem = await errorFromResponse(
      new Response(JSON.stringify({ type: 'about:blank', detail: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    )
    const plain = await errorFromResponse(new Response('', { status: 401 }))

    expect(problem).toBeInstanceOf(JmapProblemError)
    expect(problem).not.toBeInstanceOf(JmapHttpError)
    expect(httpStatusOf(problem)).toBe(401)
    expect(httpStatusOf(plain)).toBe(401)
    expect(
      httpStatusOf(
        new JmapRequestError({ '@type': 'RequestError', type: 'about:blank', status: 401 }),
      ),
    ).toBe(401)
  })

  it('answers undefined for anything that carries no status', () => {
    // "No status" — a failed fetch, an abort, a bug. Callers must not read that as "not an error".
    expect(httpStatusOf(new TypeError('Failed to fetch'))).toBeUndefined()
    expect(httpStatusOf(null)).toBeUndefined()
  })
})

describe('errorFromResponse — carries Retry-After on a 429 (M2.7)', () => {
  it('exposes retryAfterMs from the header', async () => {
    const response = new Response(JSON.stringify({ type: 'x', status: 429 }), {
      status: 429,
      headers: { 'content-type': 'application/problem+json', 'Retry-After': '30' },
    })
    const error = (await errorFromResponse(response)) as JmapProblemError
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(30_000)
  })
})

describe('errorFromResponse — carries Retry-After on a NON-problem body too (M3.3)', () => {
  it('exposes retryAfterMs on a plain JmapHttpError', async () => {
    // A 429 whose body is not a problem document becomes a bare JmapHttpError — the outbox backoff
    // still has to see the server's hint, so it must be carried on BOTH error classes.
    const response = new Response('slow down', {
      status: 429,
      headers: { 'content-type': 'text/plain', 'Retry-After': '45' },
    })
    const error = (await errorFromResponse(response)) as JmapHttpError
    expect(error).toBeInstanceOf(JmapHttpError)
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(45_000)
  })

  it('leaves retryAfterMs undefined when the header is absent', async () => {
    const response = new Response('boom', { status: 503 })
    const error = (await errorFromResponse(response)) as JmapHttpError
    expect(error.retryAfterMs).toBeUndefined()
  })
})

describe('errorFromResponse — request-level (RFC 8620 §3.6.1)', () => {
  it('maps an application/problem+json body to JmapProblemError with type + limit', async () => {
    const response = new Response(
      JSON.stringify({
        type: ProblemTypes.limit,
        status: 400,
        limit: 'maxSizeRequest',
        detail: 'too big',
      }),
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    )
    const error = await errorFromResponse(response)
    expect(error).toBeInstanceOf(JmapProblemError)
    const problem = error as JmapProblemError
    expect(problem.type).toBe('urn:ietf:params:jmap:error:limit')
    expect(problem.limit).toBe('maxSizeRequest')
    expect(problem.status).toBe(400)
    expect(problem.message).toBe('too big')
  })

  it('maps a non-problem HTTP failure (401) to JmapHttpError', async () => {
    const response = new Response('unauthorized', {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    })
    const error = await errorFromResponse(response)
    expect(error).toBeInstanceOf(JmapHttpError)
    const http = error as JmapHttpError
    expect(http.status).toBe(401)
    expect(http.body).toBe('unauthorized')
  })

  it('falls back to JmapHttpError when a JSON body is not a problem document', async () => {
    const response = new Response('{"foo":1}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
    const error = await errorFromResponse(response)
    expect(error).toBeInstanceOf(JmapHttpError)
    expect((error as JmapHttpError).status).toBe(500)
  })

  it('throws JmapProblemError from a real POST when the server returns HTTP 400 problem+json', async () => {
    const badFetch = async () =>
      new Response(JSON.stringify({ type: ProblemTypes.unknownCapability }), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch: badFetch })
    await expect(client.echo({})).rejects.toBeInstanceOf(JmapProblemError)
  })
})

describe('method-level errors (RFC 8620 §3.6.2)', () => {
  it('does not throw at the transport layer but surfaces via MethodResponses', async () => {
    const { fetch } = jmapPostMock((body) => ({
      methodResponses: body.methodCalls.map(
        ([, , id]) => ['error', { type: 'unknownMethod', description: 'nope' }, id] as Invocation,
      ),
      sessionState: 's0',
    }))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    const call = builder.call('Frob/nicate', { accountId: 'a' })
    const result = await builder.send()

    // The batch resolves; the error is inspectable...
    const errors = result.methodErrors()
    expect(errors).toHaveLength(1)
    expect(at(errors, 0)).toBeInstanceOf(JmapMethodError)
    expect(at(errors, 0).type).toBe('unknownMethod')
    // ...and unwrapping the specific call throws a typed error carrying the method name.
    expect(() => result.get(call)).toThrow(JmapMethodError)
    try {
      result.get(call)
    } catch (e) {
      expect((e as JmapMethodError).methodName).toBe('Frob/nicate')
    }
  })
})

describe('SetError (RFC 8620 §5.3)', () => {
  it('isSetErrorType matches the wire type string', () => {
    const err: SetError = { type: 'invalidProperties', description: 'bad', properties: ['from'] }
    expect(isSetErrorType(err, 'invalidProperties')).toBe(true)
    expect(isSetErrorType(err, 'forbidden')).toBe(false)
    expect(err.properties).toEqual(['from'])
  })
})

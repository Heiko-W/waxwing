import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import {
  errorFromResponse,
  isSetErrorType,
  JmapHttpError,
  JmapMethodError,
  JmapProblemError,
  ProblemTypes,
} from './errors'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Invocation, SetError } from './types/core'

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

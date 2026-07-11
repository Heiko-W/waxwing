import { describe, expect, it } from 'vitest'
import { Capabilities, Methods, RequestBuilder, usingForMethods } from './index'

describe('Identity (RFC 8621 §6, submission capability)', () => {
  it('identityGet invokes the Identity/get method', () => {
    const builder = new RequestBuilder()
    builder.invoke(Methods.identityGet, { accountId: 'a', ids: null })
    expect(builder.invocations[0]?.[0]).toBe('Identity/get')
  })

  it('Identity/get maps to the submission capability for `using`', () => {
    expect(usingForMethods(['Identity/get'])).toContain(Capabilities.submission)
  })
})

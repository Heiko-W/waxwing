import { describe, expect, it } from 'vitest'
import { Capabilities, creationRef, Methods, RequestBuilder, usingForMethods } from './index'

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

describe('EmailSubmission (RFC 8621 §7, submission capability) — M2.8', () => {
  it('emailSubmissionSet invokes the EmailSubmission/set method', () => {
    const builder = new RequestBuilder()
    builder.invoke(Methods.emailSubmissionSet, { accountId: 'a' })
    expect(builder.invocations[0]?.[0]).toBe('EmailSubmission/set')
  })

  it('EmailSubmission/set maps to the submission capability for `using`', () => {
    expect(usingForMethods(['EmailSubmission/set'])).toContain(Capabilities.submission)
  })

  it('serializes a #creationId emailId back-ref + onSuccessUpdateEmail verbatim', () => {
    const builder = new RequestBuilder()
    builder.invoke(Methods.emailSubmissionSet, {
      accountId: 'a',
      create: {
        sub1: {
          emailId: creationRef('draft1'),
          identityId: 'id1',
          envelope: { mailFrom: { email: 'me@x.test' }, rcptTo: [{ email: 'a@x.test' }] },
        },
      },
      onSuccessUpdateEmail: { [creationRef('sub1')]: { 'keywords/$draft': null } },
    })
    const args = builder.invocations[0]?.[1] as {
      create: Record<string, { emailId: string }>
      onSuccessUpdateEmail: Record<string, unknown>
    }
    expect(args.create.sub1?.emailId).toBe('#draft1')
    expect(args.onSuccessUpdateEmail).toEqual({ '#sub1': { 'keywords/$draft': null } })
  })
})

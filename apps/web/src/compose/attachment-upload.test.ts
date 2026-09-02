import { JmapHttpError, JmapProblemError, ProblemTypes } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  classifyUploadError,
  totalAttachmentBytes,
  type UploadItem,
  type ValidationLimits,
  validateFile,
  validateTotal,
} from './attachment-upload'

const limits = (over: Partial<ValidationLimits> = {}): ValidationLimits => ({
  maxSizeUpload: 1000,
  maxSizeAttachmentsPerEmail: 2000,
  ...over,
})

const upload = (size: number, status: UploadItem['status'] = 'uploading'): UploadItem => ({
  tempId: 't',
  name: 'a',
  type: 'image/png',
  size,
  inline: false,
  cid: null,
  previewUrl: null,
  status,
  progress: 0,
  error: null,
})

describe('validateFile', () => {
  it('passes within the per-file cap and fails above it', () => {
    expect(validateFile(1000, limits())).toBeNull()
    expect(validateFile(1001, limits())).toEqual({ code: 'tooLarge' })
  })
})

describe('validateTotal', () => {
  it('fails when existing + incoming exceeds the total cap', () => {
    expect(validateTotal(1500, 400, limits())).toBeNull()
    expect(validateTotal(1500, 600, limits())).toEqual({ code: 'totalTooLarge' })
  })

  it('never fails when the cap is null (unlimited)', () => {
    expect(validateTotal(1e9, 1e9, limits({ maxSizeAttachmentsPerEmail: null }))).toBeNull()
  })
})

describe('totalAttachmentBytes', () => {
  it('sums uploaded attachments and in-flight uploads', () => {
    expect(totalAttachmentBytes([{ size: 100 }, { size: 200 }], [upload(50), upload(25)])).toBe(375)
  })

  it('leaves a failed upload out of the sum', () => {
    // A chip that errored carries no blob and will never be part of the message. Counted, it took
    // the draft over the cap: Send went grey under "Attachments too large" and every further file
    // was refused as oversized, for bytes nobody was sending (R-53).
    expect(totalAttachmentBytes([{ size: 20 }], [upload(10, 'error')])).toBe(20)
    expect(totalAttachmentBytes([{ size: 20 }], [upload(10, 'error'), upload(5)])).toBe(25)
  })
})

describe('classifyUploadError', () => {
  it('maps a 429 to quota (carrying retry-after)', () => {
    const err = new JmapProblemError({ type: 'x', status: 429 }, 429, 60_000)
    expect(classifyUploadError(err)).toEqual({ code: 'quota', retryAfterMs: 60_000 })
  })

  it('maps the limit problem type and a 413 to tooLarge', () => {
    // The size signal is `urn:ietf:params:jmap:error:limit` (RFC 8620 §3.6.1) — or HTTP 413, the
    // same statement one layer down. Not "any 400".
    expect(classifyUploadError(new JmapProblemError({ type: ProblemTypes.limit }, 400))).toEqual({
      code: 'tooLarge',
    })
    expect(classifyUploadError(new JmapProblemError({ type: 'other', status: 413 }, 413))).toEqual({
      code: 'tooLarge',
    })
  })

  it('maps a 400 problem of any other type to server, so Retry stays offered', () => {
    // `notRequest`, `notJSON` or anything server-specific used to say "this file is too large,
    // max 25 MB" about a 100 KB file — and `AttachmentChips` hides Retry for `tooLarge`, so the
    // only way on was to remove the chip and attach the file again (R-54).
    for (const type of ['urn:ietf:params:jmap:error:notRequest', 'urn:example:broken']) {
      expect(classifyUploadError(new JmapProblemError({ type, status: 400 }, 400))).toEqual({
        code: 'server',
      })
    }
  })

  /*
   * The same two statuses with NO problem body. RFC 8620 §6.1 only says the upload resource SHOULD
   * carry one, so a bare 413 is a conforming way to refuse an oversized file — and it arrives as a
   * `JmapHttpError`, which fell through to `server`: "Server error" plus a Retry button that
   * re-sent the same too-large file and failed the same way, for ever.
   */
  it('maps a bare 413 to tooLarge and a bare 429 to quota', () => {
    expect(classifyUploadError(new JmapHttpError(413, 'Payload Too Large'))).toEqual({
      code: 'tooLarge',
    })
    expect(classifyUploadError(new JmapHttpError(429, '', undefined, 30_000))).toEqual({
      code: 'quota',
      retryAfterMs: 30_000,
    })
    expect(classifyUploadError(new JmapHttpError(429, ''))).toEqual({ code: 'quota' })
    // Everything else off the transport stays `server`, so Retry stays offered.
    expect(classifyUploadError(new JmapHttpError(500, 'boom'))).toEqual({ code: 'server' })
  })

  it('maps an aborted transfer, a network TypeError, and anything else', () => {
    expect(classifyUploadError({ name: 'AbortError' })).toEqual({ code: 'aborted' })
    expect(classifyUploadError(new TypeError('fetch failed'))).toEqual({ code: 'network' })
    expect(classifyUploadError(new Error('boom'))).toEqual({ code: 'server' })
  })
})

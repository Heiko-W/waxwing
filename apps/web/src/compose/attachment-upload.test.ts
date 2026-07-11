import { JmapProblemError, ProblemTypes } from '@waxwing/jmap'
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

const upload = (size: number): UploadItem => ({
  tempId: 't',
  name: 'a',
  type: 'image/png',
  size,
  inline: false,
  cid: null,
  previewUrl: null,
  status: 'uploading',
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
})

describe('classifyUploadError', () => {
  it('maps a 429 to quota (carrying retry-after)', () => {
    const err = new JmapProblemError({ type: 'x', status: 429 }, 429, 60_000)
    expect(classifyUploadError(err)).toEqual({ code: 'quota', retryAfterMs: 60_000 })
  })

  it('maps a limit / 400 problem to tooLarge', () => {
    expect(classifyUploadError(new JmapProblemError({ type: ProblemTypes.limit }, 400))).toEqual({
      code: 'tooLarge',
    })
    expect(classifyUploadError(new JmapProblemError({ type: 'other', status: 400 }, 400))).toEqual({
      code: 'tooLarge',
    })
  })

  it('maps an aborted transfer, a network TypeError, and anything else', () => {
    expect(classifyUploadError({ name: 'AbortError' })).toEqual({ code: 'aborted' })
    expect(classifyUploadError(new TypeError('fetch failed'))).toEqual({ code: 'network' })
    expect(classifyUploadError(new Error('boom'))).toEqual({ code: 'server' })
  })
})

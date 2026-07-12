import { JmapHttpError, JmapMethodError, JmapProblemError, ProblemTypes } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { RETRY_AFTER_CAP_MS } from './backoff'
import { classifySetError, classifyThrown, isAuthExpiry, type ReplayVerdict } from './conflict'
import type { OutboxIntent } from './outbox'

type Kind = OutboxIntent['kind']

const verdict = (kind: Kind, type: string, description?: string): ReplayVerdict =>
  classifySetError(kind, description === undefined ? { type } : { type, description })

describe('classifySetError — notFound (defect D2: a gone object is not a conflict)', () => {
  it.each<Kind>([
    'destroyEmails',
    'discardDraft',
    'deleteMailbox',
  ])('is SATISFIED on %s — the optimistic delete was right, never resurrect it', (kind) => {
    expect(verdict(kind, 'notFound')).toEqual({ kind: 'satisfied' })
  })

  it.each<Kind>(['setKeywords', 'move'])('is a messageGone conflict on %s', (kind) => {
    expect(verdict(kind, 'notFound')).toEqual({
      kind: 'conflict',
      code: 'messageGone',
      detail: null,
    })
  })

  it.each<Kind>(['renameMailbox', 'moveMailbox'])('is a folderGone conflict on %s', (kind) => {
    expect(verdict(kind, 'notFound')).toMatchObject({ kind: 'conflict', code: 'folderGone' })
  })
})

describe('classifySetError — the rest of the table', () => {
  it('maps invalidProperties on a move to folderGone (the target folder was deleted)', () => {
    expect(verdict('move', 'invalidProperties')).toMatchObject({ code: 'folderGone' })
    expect(verdict('createMailbox', 'invalidProperties')).toMatchObject({ code: 'invalid' })
    expect(verdict('saveDraft', 'invalidPatch')).toMatchObject({ code: 'invalid' })
  })

  it('maps the permanent per-object types to their codes', () => {
    expect(verdict('move', 'forbidden')).toMatchObject({ code: 'forbidden' })
    expect(verdict('setKeywords', 'accountReadOnly')).toMatchObject({ code: 'forbidden' })
    expect(verdict('saveDraft', 'overQuota')).toMatchObject({ code: 'quota' })
    expect(verdict('saveDraft', 'tooLarge')).toMatchObject({ code: 'tooLarge' })
    expect(verdict('deleteMailbox', 'mailboxHasEmail')).toMatchObject({ code: 'folderNotEmpty' })
    expect(verdict('deleteMailbox', 'mailboxHasChild')).toMatchObject({ code: 'folderNotEmpty' })
  })

  it('retries the transient per-object types (never dead-letters them)', () => {
    expect(verdict('move', 'rateLimit')).toEqual({ kind: 'retry', delayMs: 0 })
    expect(verdict('move', 'serverFail')).toEqual({ kind: 'retry', delayMs: 0 })
    expect(verdict('move', 'serverPartialFail')).toEqual({ kind: 'retry', delayMs: 0 })
  })

  it('treats an UNKNOWN SetError type as a user-facing serverRejected conflict', () => {
    expect(verdict('move', 'somethingNobodyDocumented')).toMatchObject({ code: 'serverRejected' })
  })

  it('carries the server description as secondary detail, never as the title', () => {
    expect(verdict('move', 'forbidden', 'ACL denies write')).toEqual({
      kind: 'conflict',
      code: 'forbidden',
      detail: 'ACL denies write',
    })
  })

  it('routes EVERY submission rejection to sendRejected — a send is never auto-retried', () => {
    for (const type of [
      'forbiddenFrom',
      'invalidEmail',
      'noRecipients',
      'forbiddenToSend',
      'tooManyRecipients',
      'overQuota',
      'tooLarge',
      'rateLimit', // even this: EmailSubmission is NOT idempotent
    ]) {
      expect(verdict('sendEmail', type)).toMatchObject({ kind: 'conflict', code: 'sendRejected' })
    }
  })
})

describe('classifyThrown', () => {
  it('refreshes on a stateMismatch (the bounded auto-resolve)', () => {
    expect(classifyThrown(new JmapMethodError({ type: 'stateMismatch' }, 'c1'), 1, 0)).toEqual({
      kind: 'refresh',
    })
  })

  it('retries the transient method errors with the backoff curve', () => {
    for (const type of ['serverUnavailable', 'serverFail', 'serverPartialFail']) {
      expect(classifyThrown(new JmapMethodError({ type }, 'c1'), 2, 0)).toEqual({
        kind: 'retry',
        delayMs: 2_000,
      })
    }
  })

  it('conflicts on the permanent method errors', () => {
    expect(
      classifyThrown(new JmapMethodError({ type: 'invalidArguments' }, 'c1'), 1, 0),
    ).toMatchObject({ code: 'invalid' })
    expect(
      classifyThrown(new JmapMethodError({ type: 'unknownMethod' }, 'c1'), 1, 0),
    ).toMatchObject({ code: 'invalid' })
    expect(classifyThrown(new JmapMethodError({ type: 'forbidden' }, 'c1'), 1, 0)).toMatchObject({
      code: 'forbidden',
    })
    expect(
      classifyThrown(new JmapMethodError({ type: 'accountNotFound' }, 'c1'), 1, 0),
    ).toMatchObject({ code: 'serverRejected' })
  })

  it('retries a 5xx and a 429, honouring Retry-After over the curve — and clamping it', () => {
    expect(classifyThrown(new JmapHttpError(503, ''), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: 1_000,
    })
    expect(classifyThrown(new JmapHttpError(429, '', 'rate', 30_000), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: 30_000, // the server's hint wins over the 1 s curve
    })
    expect(classifyThrown(new JmapHttpError(429, '', 'rate', 3_600_000), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: RETRY_AFTER_CAP_MS, // an hour-long Retry-After cannot park the queue
    })
  })

  it('treats EVERY problem-details failure as transient; a `Retry-After` hint wins over the curve', () => {
    const limit = new JmapProblemError({ type: ProblemTypes.limit }, 400, 5_000)
    expect(classifyThrown(limit, 1, 0)).toEqual({ kind: 'retry', delayMs: 5_000 })
    // A REQUEST-level problem (malformed request, a gateway's JSON error body) says nothing about
    // whether THIS action is valid — only a per-object SetError or a method error can prove that.
    // Conflicting here would dead-letter and roll back the ENTIRE queue on one bad hop.
    const notJson = new JmapProblemError({ type: ProblemTypes.notJSON }, 400)
    expect(classifyThrown(notJson, 1, 0)).toEqual({ kind: 'retry', delayMs: 1_000 })
  })

  it('treats a non-auth HTTP status as TRANSIENT — a moved endpoint must not wipe the queue', () => {
    // A 404 from a moved endpoint, a 400 from a reverse proxy, a 413 on the request envelope: none of
    // them prove that this move or this flag is permanently bad. Stuck is recoverable; destroyed is not.
    expect(classifyThrown(new JmapHttpError(404, ''), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: 1_000,
    })
    expect(classifyThrown(new JmapHttpError(400, ''), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: 1_000,
    })
  })

  it('treats a network failure — and anything unrecognized — as TRANSIENT', () => {
    expect(classifyThrown(new TypeError('Failed to fetch'), 1, 0)).toEqual({
      kind: 'retry',
      delayMs: 1_000,
    })
    expect(classifyThrown(new Error('offline'), 3, 0)).toEqual({ kind: 'retry', delayMs: 4_000 })
    expect(classifyThrown('what even is this', 1, 0)).toMatchObject({ kind: 'retry' })
  })
})

describe('isAuthExpiry', () => {
  it('recognizes a 401/403 and nothing else', () => {
    expect(isAuthExpiry(new JmapHttpError(401, ''))).toBe(true)
    expect(isAuthExpiry(new JmapHttpError(403, ''))).toBe(true)
    expect(isAuthExpiry(new JmapHttpError(500, ''))).toBe(false)
    expect(isAuthExpiry(new JmapMethodError({ type: 'forbidden' }, 'c1'))).toBe(false)
    expect(isAuthExpiry(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('also recognizes a 401 carried by a PROBLEM body — not just a bare JmapHttpError', () => {
    // A gateway/server that answers an expired token with a JSON body yields a `JmapProblemError`,
    // which is NOT a subclass of `JmapHttpError`. Missing it would skip the re-auth funnel AND —
    // far worse — classify the failure as a per-action conflict, dead-lettering and rolling back the
    // ENTIRE offline queue on one expired session.
    expect(isAuthExpiry(new JmapProblemError({ type: 'invalid_token' }, 401))).toBe(true)
    expect(isAuthExpiry(new JmapProblemError({ type: 'forbidden' }, 403))).toBe(true)
    expect(isAuthExpiry(new JmapProblemError({ type: ProblemTypes.limit }, 429))).toBe(false)
  })
})

/**
 * The typed JMAP method registry: a {@link MethodDef} per in-scope method, binding each
 * wire name to its argument and response types. Pass an entry to
 * {@link RequestBuilder.invoke} for a fully typed call whose result
 * {@link MethodResponses.get} infers automatically:
 *
 * ```ts
 * const q = builder.invoke(Methods.emailQuery, { accountId, filter: { inMailbox } })
 * const g = builder.invoke(Methods.emailGet, { accountId, '#ids': q.ref('/ids') })
 * const { list } = (await builder.send()).get(g) // list: Email[]
 * ```
 *
 * SP.1 covers Core, Mailbox, Thread and Email. Later capabilities (Submission, Vacation,
 * Blob-as-method, Quota, Sieve, Contacts) append here as they land.
 */

import { defineMethod, type MethodDef } from './request'
import type {
  EmailChangesRequest,
  EmailChangesResponse,
  EmailGetRequest,
  EmailGetResponse,
  EmailParseRequest,
  EmailParseResponse,
  EmailQueryChangesRequest,
  EmailQueryChangesResponse,
  EmailQueryRequest,
  EmailQueryResponse,
  EmailSetRequest,
  EmailSetResponse,
  MailboxChangesRequest,
  MailboxChangesResponse,
  MailboxGetRequest,
  MailboxGetResponse,
  MailboxQueryChangesRequest,
  MailboxQueryChangesResponse,
  MailboxQueryRequest,
  MailboxQueryResponse,
  MailboxSetRequest,
  MailboxSetResponse,
  SearchSnippetGetRequest,
  SearchSnippetGetResponse,
  ThreadChangesRequest,
  ThreadChangesResponse,
  ThreadGetRequest,
  ThreadGetResponse,
} from './types/mail'
import type {
  EmailSubmissionSetRequest,
  EmailSubmissionSetResponse,
  IdentityGetRequest,
  IdentityGetResponse,
} from './types/submission'

/** Registry of typed method definitions for the SP.1 capability surface. */
export const Methods = {
  /** RFC 8620 §4 — echoes its arguments; useful as a connectivity check. */
  coreEcho: defineMethod<Record<string, unknown>, Record<string, unknown>>('Core/echo'),

  mailboxGet: defineMethod<MailboxGetRequest, MailboxGetResponse>('Mailbox/get'),
  mailboxChanges: defineMethod<MailboxChangesRequest, MailboxChangesResponse>('Mailbox/changes'),
  mailboxQuery: defineMethod<MailboxQueryRequest, MailboxQueryResponse>('Mailbox/query'),
  mailboxQueryChanges: defineMethod<MailboxQueryChangesRequest, MailboxQueryChangesResponse>(
    'Mailbox/queryChanges',
  ),
  mailboxSet: defineMethod<MailboxSetRequest, MailboxSetResponse>('Mailbox/set'),

  threadGet: defineMethod<ThreadGetRequest, ThreadGetResponse>('Thread/get'),
  threadChanges: defineMethod<ThreadChangesRequest, ThreadChangesResponse>('Thread/changes'),

  emailGet: defineMethod<EmailGetRequest, EmailGetResponse>('Email/get'),
  emailChanges: defineMethod<EmailChangesRequest, EmailChangesResponse>('Email/changes'),
  emailQuery: defineMethod<EmailQueryRequest, EmailQueryResponse>('Email/query'),
  emailQueryChanges: defineMethod<EmailQueryChangesRequest, EmailQueryChangesResponse>(
    'Email/queryChanges',
  ),
  emailSet: defineMethod<EmailSetRequest, EmailSetResponse>('Email/set'),
  emailParse: defineMethod<EmailParseRequest, EmailParseResponse>('Email/parse'),
  searchSnippetGet: defineMethod<SearchSnippetGetRequest, SearchSnippetGetResponse>(
    'SearchSnippet/get',
  ),

  identityGet: defineMethod<IdentityGetRequest, IdentityGetResponse>('Identity/get'),
  emailSubmissionSet: defineMethod<EmailSubmissionSetRequest, EmailSubmissionSetResponse>(
    'EmailSubmission/set',
  ),
} as const

/** A key of the {@link Methods} registry (e.g. `"emailQuery"`). */
export type MethodName = keyof typeof Methods

/** Re-exported for convenience so callers can build ad-hoc typed methods without `request.ts`. */
export { defineMethod, type MethodDef }

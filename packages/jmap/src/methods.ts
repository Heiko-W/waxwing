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
 * Quota, Sieve, Contacts) have appended since; Blob-as-method (RFC 9404) has not landed —
 * blobs go through the RFC 8620 §6 endpoints in `blob.ts`.
 */

import { defineMethod, type MethodDef } from './request'
import type {
  CalendarChangesRequest,
  CalendarChangesResponse,
  CalendarEventChangesRequest,
  CalendarEventChangesResponse,
  CalendarEventGetRequest,
  CalendarEventGetResponse,
  CalendarEventParseRequest,
  CalendarEventParseResponse,
  CalendarEventQueryRequest,
  CalendarEventQueryResponse,
  CalendarEventSetRequest,
  CalendarEventSetResponse,
  CalendarGetRequest,
  CalendarGetResponse,
  CalendarSetRequest,
  CalendarSetResponse,
  ParticipantIdentityGetRequest,
  ParticipantIdentityGetResponse,
} from './types/calendar'
import type {
  AddressBookChangesRequest,
  AddressBookChangesResponse,
  AddressBookGetRequest,
  AddressBookGetResponse,
  AddressBookSetRequest,
  AddressBookSetResponse,
  ContactCardChangesRequest,
  ContactCardChangesResponse,
  ContactCardGetRequest,
  ContactCardGetResponse,
  ContactCardQueryChangesRequest,
  ContactCardQueryChangesResponse,
  ContactCardQueryRequest,
  ContactCardQueryResponse,
  ContactCardSetRequest,
  ContactCardSetResponse,
} from './types/contacts'
import type {
  FileNodeChangesRequest,
  FileNodeChangesResponse,
  FileNodeGetRequest,
  FileNodeGetResponse,
  FileNodeQueryRequest,
  FileNodeQueryResponse,
  FileNodeSetRequest,
  FileNodeSetResponse,
} from './types/filenode'
import type {
  EmailChangesRequest,
  EmailChangesResponse,
  EmailGetRequest,
  EmailGetResponse,
  EmailImportRequest,
  EmailImportResponse,
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
  PrincipalGetRequest,
  PrincipalGetResponse,
  PrincipalQueryRequest,
  PrincipalQueryResponse,
  ShareNotificationChangesRequest,
  ShareNotificationChangesResponse,
  ShareNotificationGetRequest,
  ShareNotificationGetResponse,
  ShareNotificationQueryRequest,
  ShareNotificationQueryResponse,
  ShareNotificationSetRequest,
  ShareNotificationSetResponse,
} from './types/principal'
import type {
  PushSubscriptionGetRequest,
  PushSubscriptionGetResponse,
  PushSubscriptionSetRequest,
  PushSubscriptionSetResponse,
} from './types/push'
import type { QuotaGetRequest, QuotaGetResponse } from './types/quota'
import type {
  SieveScriptGetRequest,
  SieveScriptGetResponse,
  SieveScriptSetRequest,
  SieveScriptSetResponse,
  SieveScriptValidateRequest,
  SieveScriptValidateResponse,
} from './types/sieve'
import type {
  EmailSubmissionGetRequest,
  EmailSubmissionGetResponse,
  EmailSubmissionQueryRequest,
  EmailSubmissionQueryResponse,
  EmailSubmissionSetRequest,
  EmailSubmissionSetResponse,
  IdentityGetRequest,
  IdentityGetResponse,
  IdentitySetRequest,
  IdentitySetResponse,
} from './types/submission'
import type {
  VacationResponseGetRequest,
  VacationResponseGetResponse,
  VacationResponseSetRequest,
  VacationResponseSetResponse,
} from './types/vacation'

/**
 * Registry of typed method definitions for the SP.1 capability surface.
 *
 * **Membership is a claim, not a catalogue.** An entry here reads as "this client does this", so a
 * method nobody calls is a lie a reader cannot check. Six were removed for that reason (JMAP gap
 * analysis, I-2/I-3); each server-side method still EXISTS on Stalwart v0.16.18 — measured — so the
 * note says why Waxwing has no use for it, not that it is unavailable:
 *
 *  - `Mailbox/query` / `Mailbox/queryChanges` — the folder tree is always fetched whole
 *    (`Mailbox/get {ids:null}`); a partial, sorted, paged mailbox list has no consumer.
 *  - `SieveScript/query` — the script list comes from `SieveScript/get {ids:null}` for the same
 *    reason. RFC 9661 accounts hold a handful of scripts, not a page of them.
 *
 * Deliberately absent for a HARDER reason, and not to be added on a whim:
 *  - `Principal/set` — v0.16.18 answers the whole batch HTTP 400 `notRequest` (`sharing.test.ts`).
 *  - `SieveScript/changes` / `SieveScript/queryChanges` — RFC 9661 defines neither (`sieve.test.ts`).
 *  - `Blob/*` (RFC 9404) — byte transfer goes through the RFC 8620 §6 endpoints in `blob.ts`.
 *
 * Present but with no production caller **on purpose**: `ShareNotification/changes` and
 * `ShareNotification/query`. Both work on v0.16.18, but the notification list is short-lived and is
 * read whole by `ShareNotification/get {ids:null}` — see `apps/web/src/sharing/incoming.ts` for the
 * measurement. They stay because a sharing UI that grows past "read them all" reaches for exactly
 * these two, and because leaving them out would suggest the server lacks them.
 */
export const Methods = {
  /**
   * RFC 8620 §4 — echoes its arguments. Mandatory for every JMAP server and the cheapest possible
   * connectivity probe, which is what {@link JmapClient.echo} uses it for.
   */
  coreEcho: defineMethod<Record<string, unknown>, Record<string, unknown>>('Core/echo'),

  mailboxGet: defineMethod<MailboxGetRequest, MailboxGetResponse>('Mailbox/get'),
  mailboxChanges: defineMethod<MailboxChangesRequest, MailboxChangesResponse>('Mailbox/changes'),
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
  /**
   * RFC 8621 §4.8 — file an uploaded RFC 5322 blob into mailboxes (M5.3).
   *
   * Not the same as `Email/set create`: an import keeps the original bytes, so headers, signatures
   * and MIME structure survive exactly. Rebuilding a message through `/set` loses whatever the
   * client could not model.
   */
  emailImport: defineMethod<EmailImportRequest, EmailImportResponse>('Email/import'),
  searchSnippetGet: defineMethod<SearchSnippetGetRequest, SearchSnippetGetResponse>(
    'SearchSnippet/get',
  ),

  identityGet: defineMethod<IdentityGetRequest, IdentityGetResponse>('Identity/get'),
  /** RFC 8621 §6.3 — create/update/destroy send identities and their signatures (M5.1, FR-CMP-06). */
  identitySet: defineMethod<IdentitySetRequest, IdentitySetResponse>('Identity/set'),
  emailSubmissionSet: defineMethod<EmailSubmissionSetRequest, EmailSubmissionSetResponse>(
    'EmailSubmission/set',
  ),
  /**
   * RFC 8621 §7 — read submissions (M5.4). The surface a "scheduled" view is built from: a
   * submission is not an Email and lives in no mailbox, so `EmailSubmission/query` with
   * `undoStatus: 'pending'` is the only way to find messages the server is holding.
   */
  emailSubmissionGet: defineMethod<EmailSubmissionGetRequest, EmailSubmissionGetResponse>(
    'EmailSubmission/get',
  ),
  emailSubmissionQuery: defineMethod<EmailSubmissionQueryRequest, EmailSubmissionQueryResponse>(
    'EmailSubmission/query',
  ),

  /** RFC 8621 §8 — the vacation-responder singleton (M3.7, FR-VAC-01). */
  vacationResponseGet: defineMethod<VacationResponseGetRequest, VacationResponseGetResponse>(
    'VacationResponse/get',
  ),
  vacationResponseSet: defineMethod<VacationResponseSetRequest, VacationResponseSetResponse>(
    'VacationResponse/set',
  ),

  /** RFC 9425 — Quota (read-only; M3.7, FR-QTA-01). */
  quotaGet: defineMethod<QuotaGetRequest, QuotaGetResponse>('Quota/get'),

  /**
   * RFC 9661 — SieveScript (M5.2, FR-SIEVE-01/02). The RFC defines four methods and no more:
   * there is no `/changes` and no `/queryChanges`, so scripts are re-read rather than synced.
   * `SieveScript/query` is the fourth and is absent by choice — see the note on {@link Methods}.
   */
  sieveScriptGet: defineMethod<SieveScriptGetRequest, SieveScriptGetResponse>('SieveScript/get'),
  sieveScriptSet: defineMethod<SieveScriptSetRequest, SieveScriptSetResponse>('SieveScript/set'),
  /** Compiles the blob without storing it; `error: null` means it parsed (RFC 9661 §2.6). */
  sieveScriptValidate: defineMethod<SieveScriptValidateRequest, SieveScriptValidateResponse>(
    'SieveScript/validate',
  ),

  /**
   * `draft-ietf-jmap-calendars` + JSCalendar (RFC 8984) — Calendar, CalendarEvent (M5.6).
   *
   * `CalendarEvent/query` carries `expandRecurrences`, which is what makes a month view possible:
   * the server returns one id per OCCURRENCE, so the client never has to expand a recurrence rule
   * across DST in local time itself.
   */
  calendarGet: defineMethod<CalendarGetRequest, CalendarGetResponse>('Calendar/get'),
  /**
   * The calendar-tree delta (K-8). Bound now because there is finally something to apply it to: the
   * replica keeps the calendar list between visits, so a colour changed on a phone has to arrive
   * without re-reading every calendar.
   */
  calendarChanges: defineMethod<CalendarChangesRequest, CalendarChangesResponse>(
    'Calendar/changes',
  ),
  calendarSet: defineMethod<CalendarSetRequest, CalendarSetResponse>('Calendar/set'),
  calendarEventGet: defineMethod<CalendarEventGetRequest, CalendarEventGetResponse>(
    'CalendarEvent/get',
  ),
  /**
   * The event delta (K-8) — and note what it reports on: STORED events, never the synthetic
   * occurrences an `expandRecurrences` query answers with. A changed weekly meeting is ONE id here
   * and fifty-two rows on screen, so the replica uses this to learn THAT a window is stale, then
   * re-materializes the window itself (`sync/engine/delta.ts`).
   */
  calendarEventChanges: defineMethod<CalendarEventChangesRequest, CalendarEventChangesResponse>(
    'CalendarEvent/changes',
  ),
  calendarEventQuery: defineMethod<CalendarEventQueryRequest, CalendarEventQueryResponse>(
    'CalendarEvent/query',
  ),
  calendarEventSet: defineMethod<CalendarEventSetRequest, CalendarEventSetResponse>(
    'CalendarEvent/set',
  ),
  /**
   * Reads an uploaded `.ics` blob as JSCalendar events (K-4).
   *
   * Answers an ARRAY per blob — one VCALENDAR can hold many VEVENTs. See
   * {@link CalendarEventParseResponse} for why the `:parse` capability URN is not added to the
   * `using` set.
   */
  calendarEventParse: defineMethod<CalendarEventParseRequest, CalendarEventParseResponse>(
    'CalendarEvent/parse',
  ),
  /**
   * The addresses the user may act as (K-10).
   *
   * Read only, and that is measured rather than cautious: a `create` naming an address the account
   * does not already own is refused, and `isDefault` cannot be written at all. See
   * {@link ParticipantIdentity}. `ParticipantIdentity/changes` is deliberately not bound — it
   * cannot answer.
   */
  participantIdentityGet: defineMethod<
    ParticipantIdentityGetRequest,
    ParticipantIdentityGetResponse
  >('ParticipantIdentity/get'),

  /**
   * `draft-ietf-jmap-filenode` — FileNode (M5.7, FR-FILE-01). No RFC number yet; the shapes are
   * measured against Stalwart 0.16 rather than taken from the draft.
   */
  fileNodeGet: defineMethod<FileNodeGetRequest, FileNodeGetResponse>('FileNode/get'),
  /**
   * The file-tree delta (D-4). Bound now that there is a replica to apply it to.
   *
   * The measured trap this one exists around: for an account with NO change history the server may
   * refuse to diff the very state a `/get` just handed out (`cannotCalculateChanges`; fixed for this
   * method in v0.16.18, but the case — a brand-new account's first sync — is every new user's).
   * `sync/engine/port.ts` translates that into "read the tree again", never into an error.
   */
  fileNodeChanges: defineMethod<FileNodeChangesRequest, FileNodeChangesResponse>(
    'FileNode/changes',
  ),
  fileNodeQuery: defineMethod<FileNodeQueryRequest, FileNodeQueryResponse>('FileNode/query'),
  fileNodeSet: defineMethod<FileNodeSetRequest, FileNodeSetResponse>('FileNode/set'),

  /**
   * RFC 9670 — JMAP Sharing (M5.18). `Principal/query` is the one a picker runs; note that the
   * usable filter is `text`, not the RFC's `name` — see `types/principal.ts`.
   */
  principalGet: defineMethod<PrincipalGetRequest, PrincipalGetResponse>('Principal/get'),
  principalQuery: defineMethod<PrincipalQueryRequest, PrincipalQueryResponse>('Principal/query'),
  shareNotificationGet: defineMethod<ShareNotificationGetRequest, ShareNotificationGetResponse>(
    'ShareNotification/get',
  ),
  shareNotificationChanges: defineMethod<
    ShareNotificationChangesRequest,
    ShareNotificationChangesResponse
  >('ShareNotification/changes'),
  shareNotificationQuery: defineMethod<
    ShareNotificationQueryRequest,
    ShareNotificationQueryResponse
  >('ShareNotification/query'),
  shareNotificationSet: defineMethod<ShareNotificationSetRequest, ShareNotificationSetResponse>(
    'ShareNotification/set',
  ),

  /** RFC 9610 — AddressBook (M4.2). No `/query`: an account's address books are always fetched whole. */
  addressBookGet: defineMethod<AddressBookGetRequest, AddressBookGetResponse>('AddressBook/get'),
  addressBookChanges: defineMethod<AddressBookChangesRequest, AddressBookChangesResponse>(
    'AddressBook/changes',
  ),
  addressBookSet: defineMethod<AddressBookSetRequest, AddressBookSetResponse>('AddressBook/set'),

  /** RFC 9610 — ContactCard (M4.2). */
  contactCardGet: defineMethod<ContactCardGetRequest, ContactCardGetResponse>('ContactCard/get'),
  contactCardChanges: defineMethod<ContactCardChangesRequest, ContactCardChangesResponse>(
    'ContactCard/changes',
  ),
  contactCardQuery: defineMethod<ContactCardQueryRequest, ContactCardQueryResponse>(
    'ContactCard/query',
  ),
  contactCardQueryChanges: defineMethod<
    ContactCardQueryChangesRequest,
    ContactCardQueryChangesResponse
  >('ContactCard/queryChanges'),
  contactCardSet: defineMethod<ContactCardSetRequest, ContactCardSetResponse>('ContactCard/set'),

  /**
   * RFC 8620 §7.2 — Web Push subscriptions (M4.0, FR-NOTIF-02).
   *
   * The only `get`/`set` pair in JMAP that takes no `accountId`: a subscription belongs to the
   * credentials rather than to an account. `usingForMethods` maps the `PushSubscription` prefix to
   * core, which is correct — RFC 9749's VAPID URN is a session-level announcement and must NOT be
   * added to `using`, or a server that pushes without VAPID would reject the whole request.
   */
  pushSubscriptionGet: defineMethod<PushSubscriptionGetRequest, PushSubscriptionGetResponse>(
    'PushSubscription/get',
  ),
  pushSubscriptionSet: defineMethod<PushSubscriptionSetRequest, PushSubscriptionSetResponse>(
    'PushSubscription/set',
  ),
} as const

/** A key of the {@link Methods} registry (e.g. `"emailQuery"`). */
export type MethodName = keyof typeof Methods

/** Re-exported for convenience so callers can build ad-hoc typed methods without `request.ts`. */
export { defineMethod, type MethodDef }

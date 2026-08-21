/**
 * The {@link JmapPort} adapter (M1.3): the ONE module that speaks the `@waxwing/jmap`
 * RequestBuilder DSL. It maps the task-oriented port surface to typed `Methods.*` calls and
 * normalizes the wire responses (nullable maps → `{}`/`[]`, method-level `cannotCalculateChanges`
 * → {@link CannotCalculateChangesError}), so `delta`/`outbox`/`backfill` stay DSL-free and testable
 * against a plain fake port.
 */

import type { CalendarEvent, ContactCard, Id, PatchObject } from '@waxwing/jmap'
import {
  creationRef,
  isMethodErrorType,
  type JmapClient,
  JmapMethodError,
  MethodErrorTypes,
  Methods,
} from '@waxwing/jmap'
import type { EmailEnvelopeInput } from '../db'
import {
  AUTH_RESULTS_PROPERTY,
  BODY_PART_PROPERTIES,
  CALENDAR_EVENT_PROPERTIES,
  CALENDAR_OBJECT_PROPERTIES,
  CALENDAR_PROPERTIES,
  type CalendarQuerySpec,
  CannotCalculateChangesError,
  type ChangesResult,
  CONTACT_CARD_PROPERTIES,
  type ContactQueryChangesSpec,
  type ContactQuerySpec,
  EMAIL_BODY_PROPERTIES,
  EMAIL_ENVELOPE_PROPERTIES,
  type EmailBodyInput,
  type EmailQueryChangesSpec,
  type EmailQuerySpec,
  type JmapPort,
  LIST_UNSUBSCRIBE_POST_PROPERTY,
  LIST_UNSUBSCRIBE_PROPERTY,
  MDN_REQUEST_PROPERTY,
  type PortSetError,
  type PortSetResult,
  type QueryChangesResult,
  type QueryResult,
} from './types'

/** The wire shape of `SetError`-style entries; only `type`/`description` are surfaced. */
type WireSetErrors = Record<string, { type: string; description?: string | null }> | null

/**
 * The wire shape of a body `/get` record: an {@link EmailBodyInput} whose Authentication-Results
 * arrive under the literal, colon-laden JMAP property name rather than a clean field.
 */
type EmailBodyWire = Omit<
  EmailBodyInput,
  'authResults' | 'listUnsubscribe' | 'listUnsubscribePost' | 'mdnRequestTo'
> & {
  readonly [AUTH_RESULTS_PROPERTY]?: string[] | null
  readonly [LIST_UNSUBSCRIBE_PROPERTY]?: string[] | null
  readonly [LIST_UNSUBSCRIBE_POST_PROPERTY]?: string | null
  readonly [MDN_REQUEST_PROPERTY]?: string | null
}

/** Wire → port: rename the `header:…` keys to clean fields so the awkward names stop here. */
function toEmailBodyInput(wire: EmailBodyWire): EmailBodyInput {
  const {
    [AUTH_RESULTS_PROPERTY]: authResults,
    [LIST_UNSUBSCRIBE_PROPERTY]: listUnsubscribe,
    [LIST_UNSUBSCRIBE_POST_PROPERTY]: listUnsubscribePost,
    [MDN_REQUEST_PROPERTY]: mdnRequestTo,
    ...rest
  } = wire
  return {
    ...rest,
    authResults: authResults ?? [],
    // `null` and `[]` are kept apart deliberately: the first means the header was absent, the
    // second that it was present and empty. Collapsing them would make an absent header
    // indistinguishable from a row written before this feature existed.
    listUnsubscribe: listUnsubscribe ?? null,
    listUnsubscribePost: listUnsubscribePost ?? null,
    mdnRequestTo: mdnRequestTo ?? null,
  }
}

function mapSetErrors(errors: WireSetErrors): Record<string, PortSetError> {
  const out: Record<string, PortSetError> = {}
  for (const [id, error] of Object.entries(errors ?? {})) {
    out[id] =
      error.description === undefined
        ? { type: error.type }
        : { type: error.type, description: error.description }
  }
  return out
}

/** Adapt a connected {@link JmapClient} to the narrow, account-scoped {@link JmapPort}. */
export function createJmapPort(client: JmapClient, accountId: Id): JmapPort {
  return {
    accountId,

    async mailboxChanges(sinceState, maxChanges) {
      const builder = client.request()
      const handle = builder.invoke(Methods.mailboxChanges, {
        accountId,
        sinceState,
        ...(maxChanges === undefined ? {} : { maxChanges }),
      })
      const response = (await builder.send()).get(handle)
      const result: ChangesResult = {
        newState: response.newState,
        hasMoreChanges: response.hasMoreChanges,
        created: response.created,
        updated: response.updated,
        destroyed: response.destroyed,
        updatedProperties: response.updatedProperties,
      }
      return result
    },

    async threadChanges(sinceState, maxChanges) {
      const builder = client.request()
      const handle = builder.invoke(Methods.threadChanges, {
        accountId,
        sinceState,
        ...(maxChanges === undefined ? {} : { maxChanges }),
      })
      const response = (await builder.send()).get(handle)
      return {
        newState: response.newState,
        hasMoreChanges: response.hasMoreChanges,
        created: response.created,
        updated: response.updated,
        destroyed: response.destroyed,
      }
    },

    async emailChanges(sinceState, maxChanges) {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailChanges, {
        accountId,
        sinceState,
        ...(maxChanges === undefined ? {} : { maxChanges }),
      })
      const response = (await builder.send()).get(handle)
      return {
        newState: response.newState,
        hasMoreChanges: response.hasMoreChanges,
        created: response.created,
        updated: response.updated,
        destroyed: response.destroyed,
      }
    },

    async getMailboxes(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.mailboxGet, { accountId, ids })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound, state: response.state }
    },

    async getIdentities() {
      const builder = client.request()
      const handle = builder.invoke(Methods.identityGet, { accountId, ids: null })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound, state: response.state }
    },

    async getThreads(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.threadGet, { accountId, ids })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound, state: response.state }
    },

    async getEmailEnvelopes(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailGet, {
        accountId,
        ids,
        properties: [...EMAIL_ENVELOPE_PROPERTIES] as string[],
      })
      const response = (await builder.send()).get(handle)
      // A partial /get returns Partial<Email>; the requested properties guarantee the envelope shape.
      return {
        list: response.list as unknown as EmailEnvelopeInput[],
        notFound: response.notFound,
        state: response.state,
      }
    },

    async getEmailBodies(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailGet, {
        accountId,
        ids,
        properties: [...EMAIL_BODY_PROPERTIES],
        bodyProperties: [...BODY_PART_PROPERTIES],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
      })
      const response = (await builder.send()).get(handle)
      return {
        list: (response.list as unknown as EmailBodyWire[]).map(toEmailBodyInput),
        notFound: response.notFound,
        state: response.state,
      }
    },

    async queryEmails(spec: EmailQuerySpec): Promise<QueryResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailQuery, {
        accountId,
        ...(spec.filter === undefined ? {} : { filter: spec.filter }),
        ...(spec.sort === undefined ? {} : { sort: spec.sort }),
        ...(spec.collapseThreads === undefined ? {} : { collapseThreads: spec.collapseThreads }),
        ...(spec.position === undefined ? {} : { position: spec.position }),
        ...(spec.limit === undefined ? {} : { limit: spec.limit }),
        ...(spec.calculateTotal === undefined ? {} : { calculateTotal: spec.calculateTotal }),
      })
      const response = (await builder.send()).get(handle)
      const result: QueryResult = {
        ids: response.ids,
        queryState: response.queryState,
        canCalculateChanges: response.canCalculateChanges,
        position: response.position,
        ...(response.total === undefined ? {} : { total: response.total }),
      }
      return result
    },

    async queryEmailChanges(spec: EmailQueryChangesSpec): Promise<QueryChangesResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailQueryChanges, {
        accountId,
        sinceQueryState: spec.sinceQueryState,
        ...(spec.filter === undefined ? {} : { filter: spec.filter }),
        ...(spec.sort === undefined ? {} : { sort: spec.sort }),
        ...(spec.collapseThreads === undefined ? {} : { collapseThreads: spec.collapseThreads }),
        ...(spec.upToId === undefined ? {} : { upToId: spec.upToId }),
        ...(spec.maxChanges === undefined ? {} : { maxChanges: spec.maxChanges }),
        ...(spec.calculateTotal === undefined ? {} : { calculateTotal: spec.calculateTotal }),
      })
      try {
        const response = (await builder.send()).get(handle)
        const result: QueryChangesResult = {
          oldQueryState: response.oldQueryState,
          newQueryState: response.newQueryState,
          removed: response.removed,
          added: response.added,
          ...(response.total === undefined ? {} : { total: response.total }),
        }
        return result
      } catch (error) {
        if (
          error instanceof JmapMethodError &&
          isMethodErrorType(error, MethodErrorTypes.cannotCalculateChanges)
        ) {
          throw new CannotCalculateChangesError()
        }
        throw error
      }
    },

    async getSearchSnippets(emailIds, filter) {
      const builder = client.request()
      const handle = builder.invoke(Methods.searchSnippetGet, { accountId, filter, emailIds })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound }
    },

    async setEmails(args): Promise<PortSetResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailSet, {
        accountId,
        ...(args.create === undefined ? {} : { create: args.create }),
        ...(args.update === undefined ? {} : { update: args.update }),
        ...(args.destroy === undefined ? {} : { destroy: args.destroy }),
        ...(args.ifInState === undefined ? {} : { ifInState: args.ifInState }),
      })
      return toSetResult((await builder.send()).get(handle))
    },

    async setMailboxes(args): Promise<PortSetResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.mailboxSet, {
        accountId,
        ...(args.create === undefined ? {} : { create: args.create }),
        ...(args.update === undefined ? {} : { update: args.update }),
        ...(args.destroy === undefined ? {} : { destroy: args.destroy }),
        ...(args.ifInState === undefined ? {} : { ifInState: args.ifInState }),
      })
      return toSetResult((await builder.send()).get(handle))
    },

    async submitEmail(args): Promise<PortSetResult> {
      const builder = client.request()
      // 1. Create the Email into Drafts (optionally destroy the prior autosaved copy + flag the source).
      const emailUpdate: Record<Id, PatchObject> | undefined = args.sourceUpdate
        ? { [args.sourceUpdate.id]: args.sourceUpdate.patch }
        : undefined
      const emailHandle = builder.invoke(Methods.emailSet, {
        accountId,
        create: { [args.emailCreationId]: args.email },
        ...(args.destroyServerDraftId ? { destroy: [args.destroyServerDraftId] } : {}),
        ...(emailUpdate === undefined ? {} : { update: emailUpdate }),
      })
      // 2. Submit it via a #creationId back-ref; on success refile Drafts→Sent + clear $draft.
      const submission = builder.invoke(Methods.emailSubmissionSet, {
        accountId,
        create: {
          [args.submissionCreationId]: {
            emailId: creationRef(args.emailCreationId),
            identityId: args.identityId,
            envelope: args.envelope,
          },
        },
        onSuccessUpdateEmail: {
          [creationRef(args.submissionCreationId)]: args.onSuccessUpdateEmail,
        },
        ...(args.ifInState === undefined ? {} : { ifInState: args.ifInState }),
      })
      const responses = await builder.send()
      // The submission result drives success/rejection; carry the sibling Email/set create id so the
      // rejection path can adopt the newly-created draft (which committed regardless of the submission).
      const emailCreated = toSetResult(responses.get(emailHandle)).created[args.emailCreationId]
      return { ...toSetResult(responses.get(submission)), emailCreated: emailCreated ?? null }
    },

    // ── Contacts (M4.2, RFC 9610) ────────────────────────────────────────────────────────────

    async getAddressBooks(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.addressBookGet, { accountId, ids })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound, state: response.state }
    },

    async addressBookChanges(sinceState, maxChanges) {
      const builder = client.request()
      const handle = builder.invoke(Methods.addressBookChanges, {
        accountId,
        sinceState,
        ...(maxChanges === undefined ? {} : { maxChanges }),
      })
      const response = (await builder.send()).get(handle)
      return {
        newState: response.newState,
        hasMoreChanges: response.hasMoreChanges,
        created: response.created,
        updated: response.updated,
        destroyed: response.destroyed,
      }
    },

    async setAddressBooks(args): Promise<PortSetResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.addressBookSet, {
        accountId,
        ...(args.create === undefined ? {} : { create: args.create }),
        ...(args.update === undefined ? {} : { update: args.update }),
        ...(args.destroy === undefined ? {} : { destroy: args.destroy }),
        ...(args.onDestroyRemoveContents === undefined
          ? {}
          : { onDestroyRemoveContents: args.onDestroyRemoveContents }),
        ...(args.ifInState === undefined ? {} : { ifInState: args.ifInState }),
      })
      return toSetResult((await builder.send()).get(handle))
    },

    async getContactCards(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.contactCardGet, {
        accountId,
        ids,
        properties: [...CONTACT_CARD_PROPERTIES] as string[],
      })
      const response = (await builder.send()).get(handle)
      // A partial /get returns Partial<ContactCard>; the requested properties cover every modeled field.
      return {
        list: response.list as unknown as ContactCard[],
        notFound: response.notFound,
        state: response.state,
      }
    },

    async contactCardChanges(sinceState, maxChanges) {
      const builder = client.request()
      const handle = builder.invoke(Methods.contactCardChanges, {
        accountId,
        sinceState,
        ...(maxChanges === undefined ? {} : { maxChanges }),
      })
      const response = (await builder.send()).get(handle)
      return {
        newState: response.newState,
        hasMoreChanges: response.hasMoreChanges,
        created: response.created,
        updated: response.updated,
        destroyed: response.destroyed,
      }
    },

    async queryContactCards(spec: ContactQuerySpec): Promise<QueryResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.contactCardQuery, {
        accountId,
        ...(spec.filter === undefined ? {} : { filter: spec.filter }),
        ...(spec.sort === undefined ? {} : { sort: spec.sort }),
        ...(spec.position === undefined ? {} : { position: spec.position }),
        ...(spec.limit === undefined ? {} : { limit: spec.limit }),
        ...(spec.calculateTotal === undefined ? {} : { calculateTotal: spec.calculateTotal }),
      })
      const response = (await builder.send()).get(handle)
      const result: QueryResult = {
        ids: response.ids,
        queryState: response.queryState,
        canCalculateChanges: response.canCalculateChanges,
        position: response.position,
        ...(response.total === undefined ? {} : { total: response.total }),
      }
      return result
    },

    async queryContactCardChanges(spec: ContactQueryChangesSpec): Promise<QueryChangesResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.contactCardQueryChanges, {
        accountId,
        sinceQueryState: spec.sinceQueryState,
        ...(spec.filter === undefined ? {} : { filter: spec.filter }),
        ...(spec.sort === undefined ? {} : { sort: spec.sort }),
        ...(spec.upToId === undefined ? {} : { upToId: spec.upToId }),
        ...(spec.maxChanges === undefined ? {} : { maxChanges: spec.maxChanges }),
        ...(spec.calculateTotal === undefined ? {} : { calculateTotal: spec.calculateTotal }),
      })
      try {
        const response = (await builder.send()).get(handle)
        const result: QueryChangesResult = {
          oldQueryState: response.oldQueryState,
          newQueryState: response.newQueryState,
          removed: response.removed,
          added: response.added,
          ...(response.total === undefined ? {} : { total: response.total }),
        }
        return result
      } catch (error) {
        if (
          error instanceof JmapMethodError &&
          isMethodErrorType(error, MethodErrorTypes.cannotCalculateChanges)
        ) {
          throw new CannotCalculateChangesError()
        }
        throw error
      }
    },

    async setContactCards(args): Promise<PortSetResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.contactCardSet, {
        accountId,
        ...(args.create === undefined ? {} : { create: args.create }),
        ...(args.update === undefined ? {} : { update: args.update }),
        ...(args.destroy === undefined ? {} : { destroy: args.destroy }),
        ...(args.ifInState === undefined ? {} : { ifInState: args.ifInState }),
      })
      return toSetResult((await builder.send()).get(handle))
    },

    // ── Calendar (K-8) ───────────────────────────────────────────────────────────────────────

    async getCalendars(ids) {
      const builder = client.request()
      const handle = builder.invoke(Methods.calendarGet, {
        accountId,
        ids,
        // Named rather than left to the server: without it the answer silently lacks `isVisible`
        // and four other opt-in properties. See CALENDAR_PROPERTIES.
        properties: [...CALENDAR_PROPERTIES],
      })
      const response = (await builder.send()).get(handle)
      return { list: response.list, notFound: response.notFound, state: response.state }
    },

    async calendarChanges(sinceState, maxChanges) {
      return changesOrReload(
        client.request(),
        Methods.calendarChanges,
        accountId,
        sinceState,
        maxChanges,
      )
    },

    async getCalendarEvents(ids, expanded) {
      const builder = client.request()
      const handle = builder.invoke(Methods.calendarEventGet, {
        accountId,
        ids,
        properties: expanded ? [...CALENDAR_EVENT_PROPERTIES] : [...CALENDAR_OBJECT_PROPERTIES],
      })
      const response = (await builder.send()).get(handle)
      // A partial /get answers `Partial<CalendarEvent>`; the requested properties cover every field
      // the grid and the identity join read.
      return {
        list: response.list as unknown as CalendarEvent[],
        notFound: response.notFound,
        state: response.state,
      }
    },

    async calendarEventChanges(sinceState, maxChanges) {
      return changesOrReload(
        client.request(),
        Methods.calendarEventChanges,
        accountId,
        sinceState,
        maxChanges,
      )
    },

    async queryCalendarEvents(spec: CalendarQuerySpec): Promise<QueryResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.calendarEventQuery, {
        accountId,
        ...(spec.filter === undefined || spec.filter === null ? {} : { filter: spec.filter }),
        ...(spec.expandRecurrences === undefined
          ? {}
          : { expandRecurrences: spec.expandRecurrences }),
        ...(spec.limit === undefined ? {} : { limit: spec.limit }),
        ...(spec.calculateTotal === undefined ? {} : { calculateTotal: spec.calculateTotal }),
      })
      const response = (await builder.send()).get(handle)
      const result: QueryResult = {
        ids: response.ids,
        queryState: response.queryState,
        canCalculateChanges: response.canCalculateChanges,
        position: response.position,
        ...(response.total === undefined ? {} : { total: response.total }),
      }
      return result
    },
  }
}

/**
 * Run a `Foo/changes` and translate `cannotCalculateChanges` into the caller's recovery signal.
 *
 * Shared by both calendar feeds because both hit the same measured case, and it is not an exotic
 * one: an account with NO change history yet — a brand-new user's very first sync — is exactly the
 * state a server cannot compute a delta from. v0.16.18 answered `cannotCalculateChanges` there for
 * `FileNode/changes` and `CalendarEventNotification/changes` even for the state a `/get` had just
 * handed out (fixed in that release, but the shape of the failure is the point). Surfacing it as an
 * error would greet a new account with a broken calendar; it means "read it all again".
 */
async function changesOrReload(
  builder: ReturnType<JmapClient['request']>,
  // Both calendar feeds are `ChangesRequest → ChangesResponse`, so one definition types both.
  method: typeof Methods.calendarChanges,
  accountId: Id,
  sinceState: string,
  maxChanges: number | undefined,
): Promise<ChangesResult> {
  const handle = builder.invoke(method, {
    accountId,
    sinceState,
    ...(maxChanges === undefined ? {} : { maxChanges }),
  })
  try {
    const response = (await builder.send()).get(handle)
    return {
      newState: response.newState,
      hasMoreChanges: response.hasMoreChanges,
      created: response.created,
      updated: response.updated,
      destroyed: response.destroyed,
    }
  } catch (error) {
    if (
      error instanceof JmapMethodError &&
      isMethodErrorType(error, MethodErrorTypes.cannotCalculateChanges)
    ) {
      throw new CannotCalculateChangesError()
    }
    throw error
  }
}

/** Wire `SetResponse` (nullable maps) → the normalized {@link PortSetResult}. */
function toSetResult(response: {
  oldState: string | null
  newState: string
  created: Record<string, unknown> | null
  updated: Record<string, unknown> | null
  destroyed: Id[] | null
  notCreated: WireSetErrors
  notUpdated: WireSetErrors
  notDestroyed: WireSetErrors
}): PortSetResult {
  return {
    oldState: response.oldState,
    newState: response.newState,
    created: (response.created ?? {}) as Record<string, { id: Id } & Record<string, unknown>>,
    updated: Object.keys(response.updated ?? {}),
    destroyed: response.destroyed ?? [],
    notCreated: mapSetErrors(response.notCreated),
    notUpdated: mapSetErrors(response.notUpdated),
    notDestroyed: mapSetErrors(response.notDestroyed),
  }
}

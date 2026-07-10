/**
 * The {@link JmapPort} adapter (M1.3): the ONE module that speaks the `@waxwing/jmap`
 * RequestBuilder DSL. It maps the task-oriented port surface to typed `Methods.*` calls and
 * normalizes the wire responses (nullable maps → `{}`/`[]`, method-level `cannotCalculateChanges`
 * → {@link CannotCalculateChangesError}), so `delta`/`outbox`/`backfill` stay DSL-free and testable
 * against a plain fake port.
 */

import type { Id } from '@waxwing/jmap'
import {
  isMethodErrorType,
  type JmapClient,
  JmapMethodError,
  MethodErrorTypes,
  Methods,
} from '@waxwing/jmap'
import type { EmailEnvelopeInput } from '../db'
import {
  CannotCalculateChangesError,
  type ChangesResult,
  EMAIL_ENVELOPE_PROPERTIES,
  type EmailQueryChangesSpec,
  type EmailQuerySpec,
  type JmapPort,
  type PortSetError,
  type PortSetResult,
  type QueryChangesResult,
  type QueryResult,
} from './types'

/** The wire shape of `SetError`-style entries; only `type`/`description` are surfaced. */
type WireSetErrors = Record<string, { type: string; description?: string | null }> | null

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

    async setEmails(args): Promise<PortSetResult> {
      const builder = client.request()
      const handle = builder.invoke(Methods.emailSet, {
        accountId,
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

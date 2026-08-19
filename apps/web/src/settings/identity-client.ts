/**
 * The JMAP seam for send identities (M5.1, FR-CMP-06, RFC 8621 §6).
 *
 * Direct and online-only, for the same reason `vacation-client.ts` is: the outbox is Email-shaped
 * (optimistic apply, rollback, conflict codes), and an identity edit has none of that. Queueing one
 * offline would promise a "sent later" the composer cannot honour anyway — the From selector reads
 * the replica, so an identity that exists only in a queued intent would be offered for sending from
 * an address the server does not yet know.
 *
 * `ifInState` rides on every write, so an edit made in another client (or another tab) is caught
 * rather than silently overwritten. A stale `ifInState` aborts the **method** (RFC 8620 §5.3): it
 * arrives as a thrown `JmapMethodError('stateMismatch')`, never in `notUpdated`.
 *
 * Every write re-reads the list rather than trusting the echo. RFC 8620 §5.3 lets a server answer
 * `updated: { id: null }` ("applied, nothing further to tell you"), and `created` only has to carry
 * the properties the server itself set — so the echo is not a renderable record.
 */

import type { Id, Identity, IdentityCreate, IdentityWritable, JmapClient } from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

/** The account's identities plus the `/get` state string, sent back as `ifInState` on the next write. */
export interface IdentitySnapshot {
  readonly identities: readonly Identity[]
  readonly state: string
}

/**
 * A `/set` the server refused per-object.
 *
 * `type` is the one thing worth branching on: `forbiddenFrom` (create — the user may not send from
 * that address) and `forbidden` (destroy — `mayDelete: false`) are the two the UI can explain
 * precisely, and both are RFC-defined for this method (§6.3, §6.1).
 */
export class IdentitySetError extends Error {
  readonly properties: readonly string[]

  constructor(
    readonly type: string,
    description?: string | null,
    properties?: readonly string[],
  ) {
    super(description ?? type)
    this.name = 'IdentitySetError'
    this.properties = properties ?? []
  }

  static from(error: WireSetError): IdentitySetError {
    return new IdentitySetError(error.type, error.description, error.properties)
  }
}

export interface IdentityClient {
  list(signal?: AbortSignal): Promise<IdentitySnapshot>
  /** Resolves with the id the server assigned, alongside the refreshed list. */
  create(
    identity: IdentityCreate,
    ifInState: string,
  ): Promise<{ readonly snapshot: IdentitySnapshot; readonly id: Id }>
  update(id: Id, patch: IdentityWritable, ifInState: string): Promise<IdentitySnapshot>
  destroy(id: Id, ifInState: string): Promise<IdentitySnapshot>
}

/** The creation id used for the single identity a `create` call adds. */
const NEW = 'new'

/**
 * A SetError as servers actually send it. Deliberately looser than the package's `SetError`, whose
 * `description: string | null` is REQUIRED — real servers omit the field entirely, and
 * `vacation-client.ts` declares the same local shape for the same reason.
 */
interface WireSetError {
  type: string
  description?: string | null
  properties?: string[]
}

interface SetEcho {
  created: Record<string, Identity> | null
  notCreated: Record<string, WireSetError> | null
  notUpdated: Record<Id, WireSetError> | null
  notDestroyed: Record<Id, WireSetError> | null
}

export function makeIdentityClient(client: JmapClient, accountId: Id): IdentityClient {
  async function fetchSnapshot(signal?: AbortSignal): Promise<IdentitySnapshot> {
    const responses = await client.call(
      [[Methods.identityGet.name, { accountId, ids: null }, 'i0']],
      signal ? { signal } : {},
    )
    const response = responses.get<{ state: string; list: Identity[] }>('i0')
    return { identities: response.list, state: response.state }
  }

  async function set(args: Record<string, unknown>): Promise<SetEcho> {
    const responses = await client.call([[Methods.identitySet.name, { accountId, ...args }, 'i0']])
    return responses.get<SetEcho>('i0')
  }

  return {
    list: fetchSnapshot,

    async create(identity, ifInState) {
      const echo = await set({ ifInState, create: { [NEW]: identity } })
      const refused = echo.notCreated?.[NEW]
      if (refused !== undefined) throw IdentitySetError.from(refused)
      const created = echo.created?.[NEW]
      if (created === undefined) {
        // A server that reports neither `created` nor `notCreated` for our creation id has broken
        // the contract; treating that as success would leave the caller selecting an id we made up.
        throw new IdentitySetError('serverFail', 'Identity/set returned no created record')
      }
      return { snapshot: await fetchSnapshot(), id: created.id }
    },

    async update(id, patch, ifInState) {
      const echo = await set({ ifInState, update: { [id]: patch } })
      const refused = echo.notUpdated?.[id]
      if (refused !== undefined) throw IdentitySetError.from(refused)
      return await fetchSnapshot()
    },

    async destroy(id, ifInState) {
      const echo = await set({ ifInState, destroy: [id] })
      const refused = echo.notDestroyed?.[id]
      if (refused !== undefined) throw IdentitySetError.from(refused)
      return await fetchSnapshot()
    },
  }
}

/**
 * Does this server offer identity management for this account?
 *
 * The same capability carries `Identity/*` and `EmailSubmission/*`, so this is really "can this
 * account send at all" — a delegated mailbox typically cannot, and per ADR-020 we never offer to
 * send (or to manage the identities used for sending) from one.
 */
export function serverSupportsIdentities(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.submission, accountId)
}

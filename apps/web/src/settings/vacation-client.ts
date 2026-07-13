/**
 * The JMAP seam for the vacation responder (M3.7, FR-VAC-01, RFC 8621 §8).
 *
 * A direct, online-only call — deliberately NOT an outbox intent. The outbox is Email/Mailbox-shaped
 * (optimistic apply, rollback, conflict codes); a settings singleton with last-write-wins semantics
 * has none of that, and pretending otherwise would buy an offline "queued" state nobody asked for and
 * a rollback path with nothing to roll back.
 *
 * `ifInState` is sent on every save, so a change made in another client (or another tab) is caught
 * rather than silently overwritten. Note that a stale `ifInState` aborts the **method** (RFC 8620
 * §5.3) — it arrives as a thrown `JmapMethodError('stateMismatch')`, never in `notUpdated`.
 */

import type { Id, JmapClient, PatchObject, VacationResponse } from '@waxwing/jmap'
import { Capabilities, hasCapability, Methods, VACATION_SINGLETON_ID } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

export interface VacationSnapshot {
  readonly vacation: VacationResponse
  /** The `/get` state string — sent back as `ifInState` on the next save. */
  readonly state: string
}

/** A `/set` the server refused per-object (`invalidProperties`, `forbidden`, `overQuota`, …). */
export class VacationSetError extends Error {
  constructor(
    readonly type: string,
    description?: string | null,
  ) {
    super(description ?? type)
    this.name = 'VacationSetError'
  }
}

export interface VacationClient {
  get(signal?: AbortSignal): Promise<VacationSnapshot>
  /** Throws `JmapMethodError('stateMismatch')` when `ifInState` is stale, {@link VacationSetError} otherwise. */
  save(patch: PatchObject, ifInState: string): Promise<VacationSnapshot>
}

/** A server that advertises the capability but returns nothing still has to render a form. */
const EMPTY: VacationResponse = {
  id: VACATION_SINGLETON_ID,
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: null,
  textBody: null,
  htmlBody: null,
}

export function makeVacationClient(client: JmapClient, accountId: Id): VacationClient {
  async function fetchSnapshot(signal?: AbortSignal): Promise<VacationSnapshot> {
    const responses = await client.call(
      [[Methods.vacationResponseGet.name, { accountId, ids: [VACATION_SINGLETON_ID] }, 'v0']],
      signal ? { signal } : {},
    )
    const response = responses.get<{ state: string; list: VacationResponse[] }>('v0')
    return { vacation: response.list[0] ?? EMPTY, state: response.state }
  }

  return {
    get: fetchSnapshot,

    async save(patch, ifInState) {
      const responses = await client.call([
        [
          Methods.vacationResponseSet.name,
          { accountId, ifInState, update: { [VACATION_SINGLETON_ID]: patch } },
          'v0',
        ],
      ])
      // A stale `ifInState` throws out of `.get()` as a JmapMethodError — the caller catches it.
      const response = responses.get<{
        notUpdated: Record<string, { type: string; description?: string | null }> | null
      }>('v0')
      const refused = response.notUpdated?.[VACATION_SINGLETON_ID]
      if (refused !== undefined) {
        throw new VacationSetError(refused.type, refused.description)
      }
      // Re-read rather than trust the echo: `/set` may return `updated: { singleton: null }`, meaning
      // "applied, nothing further to tell you" — which is not an object we can render.
      return await fetchSnapshot()
    },
  }
}

/** Does this server offer the vacation responder for this account? */
export function serverSupportsVacation(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.vacationResponse, accountId)
}

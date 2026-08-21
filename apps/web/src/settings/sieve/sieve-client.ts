/**
 * The JMAP seam for filter rules (M5.2, FR-SIEVE-01/02, RFC 9661).
 *
 * Online-only and direct, for the same reason the vacation responder is: a Sieve script is a
 * settings document with last-write-wins semantics, not a mailbox mutation the outbox knows how to
 * replay, roll back or reconcile.
 *
 * Three details of the protocol shape this file, each of which produces a plausible-looking client
 * that misbehaves if ignored:
 *
 * - **Content travels as a blob, never inline** (RFC 9661 §2.2). Every save and every validate
 *   uploads first and then references the returned id.
 * - **`onSuccessActivateScript: null` does not deactivate.** An absent or unknown id must be
 *   ignored, leaving the previous script filtering mail. Deactivation is
 *   `onSuccessDeactivateScript: true`.
 * - **A `/set` response cannot be trusted to report activation.** The RFC requires it; Stalwart
 *   returns an empty `updated` for an activation-only call, so the previously active script is
 *   never reported as deactivated. Every mutation here re-reads rather than patching local state
 *   from the echo.
 */

import type { Id, JmapClient, SetError, SieveScript } from '@waxwing/jmap'
import {
  Capabilities,
  hasCapability,
  isSieveIsActiveError,
  Methods,
  SIEVE_CONTENT_TYPE,
} from '@waxwing/jmap'
import type { JmapSession } from '../../app/session/types'

/** The name of the script this client manages. */
export const MANAGED_SCRIPT_NAME = 'waxwing'

/**
 * Names a server reserves for itself.
 *
 * `vacation` is written by `VacationResponse/set`; creating or editing it through this surface is
 * refused by the server, and would fight the vacation section for the same object.
 */
export const RESERVED_SCRIPT_NAMES: readonly string[] = ['vacation']

/** A script plus the source we downloaded for it. */
export interface SieveScriptWithSource {
  readonly script: SieveScript
  readonly source: string
}

export interface SieveSnapshot {
  /** Every script in the account, minus the server-managed ones. */
  readonly scripts: readonly SieveScript[]
  /** The active script and its source, or `null` when nothing is active. */
  readonly active: SieveScriptWithSource | null
  /**
   * The script this client wrote, active or not.
   *
   * Read even when it is inactive, because "filtering is switched off" has to keep showing the
   * rules it switched off — a section that empties itself when the user turns filtering off looks
   * like it deleted them. Identical to {@link SieveSnapshot.active} when ours is the active one,
   * so the common case still costs one download.
   */
  readonly managed: SieveScriptWithSource | null
  /** The `/get` state string. */
  readonly state: string
}

/** A `/set` the server refused per-object. */
export class SieveSetError extends Error {
  constructor(
    readonly type: string,
    description?: string | null,
  ) {
    super(description ?? type)
    this.name = 'SieveSetError'
  }
}

/** Options for {@link SieveClient.save}. */
export interface SieveSaveOptions {
  /**
   * Activate the script after writing it. Default `true`.
   *
   * `false` is what makes the "filtering is off" switch hold: editing a rule while filtering is
   * switched off must not quietly switch it back on, and `SieveScript/set` activates only when it
   * is asked to.
   */
  readonly activate?: boolean
}

export interface SieveClient {
  /** Lists scripts and downloads the active one's source (and ours, if that is a different one). */
  load(signal?: AbortSignal): Promise<SieveSnapshot>
  /** Downloads one script's source. */
  read(script: SieveScript, signal?: AbortSignal): Promise<string>
  /**
   * Writes `source` to the managed script, creating it when absent, and activates it unless told
   * not to. Returns a fresh snapshot — never the `/set` echo.
   */
  save(
    source: string,
    existing: SieveScript | null,
    options?: SieveSaveOptions,
  ): Promise<SieveSnapshot>
  /** Asks the server to compile `source` without storing it. `null` means it compiled. */
  validate(source: string, signal?: AbortSignal): Promise<SetError | null>
  /** Makes `script` the one that filters mail. */
  activate(script: SieveScript): Promise<SieveSnapshot>
  /** Deactivates all filtering. */
  deactivate(): Promise<SieveSnapshot>
  /** Destroys a script, deactivating it first when it is the active one. */
  destroy(script: SieveScript): Promise<SieveSnapshot>
}

export function makeSieveClient(client: JmapClient, accountId: Id): SieveClient {
  /** Uploads script text and returns the blob id to reference. */
  async function uploadSource(source: string, signal?: AbortSignal): Promise<Id> {
    const options = signal ? { type: SIEVE_CONTENT_TYPE, signal } : { type: SIEVE_CONTENT_TYPE }
    const result = await client.upload(accountId, source, options)
    return result.blobId
  }

  async function fetchScripts(
    signal?: AbortSignal,
  ): Promise<{ scripts: SieveScript[]; state: string }> {
    const responses = await client.call(
      [[Methods.sieveScriptGet.name, { accountId, ids: null }, 's0']],
      signal ? { signal } : {},
    )
    const response = responses.get<{ state: string; list: SieveScript[] }>('s0')
    return { scripts: response.list, state: response.state }
  }

  async function download(script: SieveScript, signal?: AbortSignal): Promise<string> {
    const bytes = await client.download(
      accountId,
      script.blobId,
      SIEVE_CONTENT_TYPE,
      `${script.name ?? MANAGED_SCRIPT_NAME}.siv`,
      signal ? { signal } : {},
    )
    return new TextDecoder().decode(bytes)
  }

  async function snapshot(signal?: AbortSignal): Promise<SieveSnapshot> {
    const { scripts, state } = await fetchScripts(signal)
    // The vacation script belongs to the vacation responder; showing it here would invite edits
    // that the server refuses and that would contradict that section's UI.
    const visible = scripts.filter((script) => !RESERVED_SCRIPT_NAMES.includes(script.name ?? ''))
    const activeScript = visible.find((script) => script.isActive) ?? null
    const active =
      activeScript === null
        ? null
        : { script: activeScript, source: await download(activeScript, signal) }
    const managedScript = visible.find((script) => script.name === MANAGED_SCRIPT_NAME) ?? null
    const managed =
      managedScript === null
        ? null
        : managedScript.id === active?.script.id
          ? active
          : { script: managedScript, source: await download(managedScript, signal) }
    return { scripts: visible, active, managed, state }
  }

  /** Throws {@link SieveSetError} for the first per-object refusal in a `/set` response. */
  function throwIfRefused(response: {
    notCreated?: Record<string, SetError> | null
    notUpdated?: Record<string, SetError> | null
    notDestroyed?: Record<string, SetError> | null
  }): void {
    for (const group of [response.notCreated, response.notUpdated, response.notDestroyed]) {
      const first = Object.values(group ?? {})[0]
      if (first !== undefined) throw new SieveSetError(first.type, first.description)
    }
  }

  return {
    load: snapshot,

    read: download,

    async save(source, existing, options) {
      const blobId = await uploadSource(source)
      const activate = options?.activate ?? true
      const base =
        existing === null
          ? { accountId, create: { managed: { name: MANAGED_SCRIPT_NAME, blobId } } }
          : { accountId, update: { [existing.id]: { blobId } } }
      // Omitted rather than sent as `null`: RFC 9661 §2.4 requires an absent or unknown id to be
      // IGNORED, so `onSuccessActivateScript: null` would be indistinguishable from "activate" for
      // a reader and does nothing for the server.
      const args = activate
        ? { ...base, onSuccessActivateScript: existing === null ? '#managed' : existing.id }
        : base
      const responses = await client.call([[Methods.sieveScriptSet.name, args, 's0']])
      throwIfRefused(
        responses.get<{
          notCreated: Record<string, SetError> | null
          notUpdated: Record<string, SetError> | null
        }>('s0'),
      )
      // Re-read: an activation-only `/set` may report nothing at all, so the echo cannot say which
      // script is now active.
      return await snapshot()
    },

    async validate(source, signal) {
      const blobId = await uploadSource(source, signal)
      const responses = await client.call(
        [[Methods.sieveScriptValidate.name, { accountId, blobId }, 's0']],
        signal ? { signal } : {},
      )
      return responses.get<{ error: SetError | null }>('s0').error
    },

    async activate(script) {
      const responses = await client.call([
        [Methods.sieveScriptSet.name, { accountId, onSuccessActivateScript: script.id }, 's0'],
      ])
      throwIfRefused(responses.get<{ notUpdated: Record<string, SetError> | null }>('s0'))
      // The echo cannot be trusted here either: Stalwart reports an empty `updated` for an
      // activation-only call, so whether it worked is only knowable by re-reading.
      return await snapshot()
    },

    async deactivate() {
      const responses = await client.call([
        [Methods.sieveScriptSet.name, { accountId, onSuccessDeactivateScript: true }, 's0'],
      ])
      throwIfRefused(responses.get<{ notUpdated: Record<string, SetError> | null }>('s0'))
      return await snapshot()
    },

    async destroy(script) {
      if (script.isActive) {
        // RFC 9661 §2.4: the active script must be deactivated in a SEPARATE call before it can be
        // destroyed. Batching both into one `/set` is refused.
        await client.call([
          [Methods.sieveScriptSet.name, { accountId, onSuccessDeactivateScript: true }, 's0'],
        ])
      }
      const responses = await client.call([
        [Methods.sieveScriptSet.name, { accountId, destroy: [script.id] }, 's1'],
      ])
      const response = responses.get<{ notDestroyed: Record<string, SetError> | null }>('s1')
      const refusal = Object.values(response.notDestroyed ?? {})[0]
      if (refusal !== undefined) {
        // Surfacing "it is still active" as itself lets the UI say something true; the generic
        // message would be a lie about what went wrong.
        throw new SieveSetError(refusal.type, refusal.description)
      }
      return await snapshot()
    },
  }
}

/** Does this server offer Sieve scripts for this account? */
export function serverSupportsSieve(
  session: JmapSession | null,
  accountId: string | null,
): boolean {
  if (session === null || accountId === null) return false
  return hasCapability(session, Capabilities.sieve, accountId)
}

/**
 * The extensions this server said it supports, or `undefined` when it advertised no list.
 *
 * Read from the account capability rather than assumed: a `require` the server does not implement
 * may compile cleanly and only fail when mail actually arrives.
 */
export function sieveExtensions(
  session: JmapSession | null,
  accountId: string | null,
): readonly string[] | undefined {
  if (session === null || accountId === null) return undefined
  const capability = session.accounts?.[accountId]?.accountCapabilities?.[Capabilities.sieve]
  const extensions = (capability as { sieveExtensions?: unknown } | undefined)?.sieveExtensions
  return Array.isArray(extensions) ? (extensions as string[]) : undefined
}

/** Whether a refusal means "this script is still active" under either spelling. */
export function isStillActiveRefusal(error: unknown): boolean {
  return error instanceof SieveSetError && isSieveIsActiveError(error.type)
}

/**
 * Cross-tab serialization of the refresh-token grant (FR-AUTH-03).
 *
 * The single-flight inside {@link AuthController.refresh} de-dupes callers within ONE tab, which is
 * all it was ever able to do. Every tab of a browser profile shares one `waxwing-auth` database
 * (ADR-037), so two tabs restored together by a session restore each read the same refresh token
 * and each start their own grant. Against an authorization server that ROTATES refresh tokens and
 * invalidates the old one on use — the OAuth 2.1 rule for public clients, optional in authentik and
 * Keycloak, and exactly the deployments ADR-006 points at when revocation matters — the second
 * grant is answered `invalid_grant`, and the loser used to react by deleting the token the winner
 * had just written. Both tabs then ended up signed out, and so did the next cold start.
 *
 * (Stalwart itself is not affected: its refresh tokens are stateless — signature, expiry,
 * `credential_version` — and an old one stays valid until it expires on its own. The race there
 * ends with two valid tokens.)
 *
 * A Web Lock is the same primitive and the same reasoning as the sync engine's leader election
 * (`sync/engine/leader.ts`): the browser releases it when the tab dies, however it dies, so there
 * is no heartbeat and no stale-holder problem. The {@link LockManagerLike} seam and the
 * feature detection mirror that module — `navigator.locks` is absent in this project's Node-based
 * auth test environment and in older Safari, and the fallback there is simply the previous
 * behaviour plus the compare-and-delete guard in the controller.
 */

/** The subset of `navigator.locks` used here; the real `LockManager` satisfies it. */
export interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>
}

/** The exclusive lock under which a refresh-token grant runs. Profile-wide, like the store. */
export const REFRESH_LOCK = 'waxwing-auth-refresh'

/**
 * How long a tab waits for another tab's grant before going ahead without the lock.
 *
 * A bound is required, not a nicety. The lock is held across network I/O, and `navigator.locks`
 * has no timeout of its own: a tab whose token endpoint accepted the connection and never answered
 * would otherwise hold every other tab's session hostage for as long as the browser's own patience
 * lasts. Timing out means falling back to the unsynchronized path — the race becomes possible
 * again, which is what the compare-and-delete in `doRefresh` is for — and that is strictly better
 * than a silent, unbounded stall. Generous relative to a token grant (tens of ms to low seconds),
 * short relative to the access-token lifetime the refresh is racing.
 */
export const REFRESH_LOCK_WAIT_MS = 15_000

/**
 * Run `task` under the exclusive refresh lock, or — when no lock manager exists or the wait
 * budget expires — run it unlocked.
 *
 * Aborting the signal only removes a request still waiting in the QUEUE; once the lock is granted
 * the callback runs to completion. So the budget bounds the wait and never truncates a grant that
 * is already in flight.
 */
export async function withRefreshLock<T>(
  locks: LockManagerLike | undefined,
  task: () => Promise<T>,
  options: { readonly waitMs?: number; readonly name?: string } = {},
): Promise<T> {
  if (locks === undefined) return task()
  const name = options.name ?? REFRESH_LOCK
  const waitMs = options.waitMs ?? REFRESH_LOCK_WAIT_MS
  // A box, so a rejection from `task` can be told apart from a rejection of the lock request
  // itself. Only the latter may fall back to running unlocked; re-running a token grant that has
  // already failed would send the same dead token twice.
  let ran = false
  try {
    return (await locks.request(
      name,
      { signal: AbortSignal.timeout(waitMs), mode: 'exclusive' },
      () => {
        ran = true
        return task()
      },
    )) as T
  } catch (error) {
    if (ran) throw error
    return task()
  }
}

/** The browser's lock manager, or `undefined` where the API is absent (Node tests, old Safari). */
export function defaultLockManager(): LockManagerLike | undefined {
  const locks = globalThis.navigator?.locks
  return typeof locks?.request === 'function' ? (locks as LockManagerLike) : undefined
}

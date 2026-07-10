/**
 * Single-writer leader election (M1.3, tech-stack §4.3). Only one tab runs the sync engine; the
 * others read the same IndexedDB and re-render via Dexie's cross-tab liveQuery (so the replica
 * needs no cross-tab plumbing). Leadership is a `navigator.locks` exclusive lock held for as long
 * as the leader tab lives: when it closes (or stops the engine) the Web Locks queue hands the lock
 * to the next waiting tab — that IS the re-election, no heartbeat needed.
 *
 * The `LockManager`/`AbortSignal` are injected via {@link LockManagerLike} so the failover can be
 * tested hermetically against a fake lock queue.
 */

/** The subset of `navigator.locks` we use; the real `LockManager` satisfies it. */
export interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>
}

/** The exclusive lock name that serializes the sync engine to one tab. */
export const SYNC_LOCK = 'waxwing-sync'

export interface LeaderElectionOptions {
  readonly locks: LockManagerLike
  /** Aborts to release leadership / leave the queue when the engine stops. */
  readonly signal: AbortSignal
  /** Called with `true` when this tab acquires leadership, `false` when it ends or is abandoned. */
  readonly onLeadership: (isLeader: boolean) => void
  readonly lockName?: string
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Enter the election. Resolves when leadership ends (the signal aborts) or the tab never became
 * leader and was abandoned. While this tab holds the lock it is the leader; other tabs calling this
 * with the same `lockName` wait in the queue and acquire it when this one releases.
 */
export function startLeaderElection(options: LeaderElectionOptions): Promise<void> {
  const { locks, signal, onLeadership, lockName = SYNC_LOCK } = options
  if (signal.aborted) {
    onLeadership(false)
    return Promise.resolve()
  }
  return locks
    .request(lockName, { signal, mode: 'exclusive' }, () => {
      onLeadership(true)
      // Hold the lock (stay leader) until the engine stops.
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    .then(
      () => onLeadership(false),
      (error) => {
        // Aborted while still queued (never led) — the normal stop path for a follower.
        onLeadership(false)
        if (!isAbortError(error)) throw error
      },
    )
}

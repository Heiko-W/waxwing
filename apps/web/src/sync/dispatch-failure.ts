/**
 * "The action could not be queued" signal.
 *
 * `SyncEngine.dispatch` is called fire-and-forget from every action surface — mark read, flag,
 * move, destroy, rename a folder, autosave a draft — and that shape is right: the optimistic store
 * update has already happened, the UI must not wait on IndexedDB, and an action queued behind a
 * dozen others has no useful return value.
 *
 * What was missing is the failure half. `dispatch` awaits `stateGuard`, `enqueueAction` and
 * `refreshQueueCounts`, all of them writes that can throw — a full disk is the realistic one — and
 * with no `catch` anywhere and no `unhandledrejection` handler, the rejection went to the console.
 * The row stayed optimistically changed on screen, no outbox row existed to carry it to the server,
 * and the next reload silently reverted it. The user was told nothing at either end.
 *
 * A module-level observable, on the {@link reportStorageFull} precedent next door: this is a
 * transient event, not part of the cross-tab status the leader broadcasts. One notifier hook in the
 * shell turns it into one toast.
 */

let lastFailureAt = 0
let lastMessage: string | null = null
const listeners = new Set<() => void>()

/** Record that an intent could not be enqueued. Safe to call from any `catch`. */
export function reportDispatchFailure(error: unknown, now: number = Date.now()): void {
  lastFailureAt = now
  lastMessage = error instanceof Error ? error.message : String(error)
  for (const listener of listeners) listener()
}

/** Epoch ms of the last {@link reportDispatchFailure}; `0` when it has never happened. */
export function getDispatchFailureAt(): number {
  return lastFailureAt
}

/** The last failure's message, for the console breadcrumb the toast cannot carry. */
export function getDispatchFailureMessage(): string | null {
  return lastMessage
}

export function subscribeDispatchFailure(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam, and the sign-out reset: forget any recorded failure. */
export function resetDispatchFailure(): void {
  lastFailureAt = 0
  lastMessage = null
}

/**
 * Attach to a fire-and-forget `dispatch`: `void dispatchOrReport(engine?.dispatch(intent, opts))`.
 *
 * Takes the promise rather than the engine so it fits every call shape already in the tree,
 * including the optional-chained ones where there may be no engine at all.
 */
export function dispatchOrReport(pending: Promise<unknown> | undefined): void {
  void pending?.catch((error: unknown) => {
    reportDispatchFailure(error)
  })
}

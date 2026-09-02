/**
 * Would THIS tab raise the live mail banner for a delivery arriving right now? (R-42)
 *
 * One boolean, written by the sync engine that owns the banners and read when the service worker
 * asks (`live-probe.ts`). A module-level cell rather than a store with subscribers, because nothing
 * RENDERS from it — the only reader is a `postMessage` handler answering a question, and giving it a
 * `useSyncExternalStore` would re-render the shell on every push-channel transition for a value no
 * pixel depends on.
 *
 * Deliberately not derived from `EngineStatus` in the shell, although two thirds of it are there:
 * the third part, "has this leadership session already done its silent catch-up pass"
 * (`notifyArmed`), is engine-session state that never leaves the engine — and it is the part that
 * matters. A tab that has just become leader is running, connected and about to stay SILENT for one
 * pass; letting it answer "live" would suppress the push banner and raise nothing in its place.
 */

let ready = false

/** Called by the engine that holds `SyncEngineDeps.notify` — no other engine may speak for it. */
export function setLiveBannerReady(value: boolean): void {
  ready = value
}

export function isLiveBannerReady(): boolean {
  return ready
}

/**
 * Outbox retry backoff (M3.3, FR-OFF-03). A pure function over a PERSISTED attempt counter — not
 * the stateful, full-jitter `Backoff` class the push channel uses (`packages/jmap/src/push`): that
 * one lives for the life of a connection, while an outbox row's schedule must survive a reload, a
 * tab hand-over and an hours-long outage, so the delay has to be derivable from the row alone.
 *
 * Half-jitter (`delay ∈ [w/2, w)`) rather than full jitter: a queue of rows that all failed against
 * the same down server must spread out, but a delay that can round to ~0 would re-hammer it.
 */

export interface OutboxBackoff {
  readonly baseMs: number
  readonly factor: number
  readonly capMs: number
}

/** 2 s → 4 s → 8 s → … capped at 5 minutes. */
export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoff = {
  baseMs: 2_000,
  factor: 2,
  capMs: 300_000,
}

/**
 * After this many failed attempts a still-`pending` row is REPORTED as stuck (a gentle "still
 * trying" notice). It is never discarded and never rolled back — that would be the silent data loss
 * FR-OFF-03 forbids.
 */
export const STUCK_AFTER_ATTEMPTS = 6

/** How many `stateMismatch` auto-refresh + re-execute rounds one row may spend before conflicting. */
export const MAX_REFRESHES = 3

/** Ceiling for a server-supplied `Retry-After` — a hostile/mis-set header must not park the queue. */
export const RETRY_AFTER_CAP_MS = 900_000

/**
 * Half-jittered exponential delay for the `attempts`-th failure (1-based).
 * `w = min(cap, base · factor^(attempts-1))`; the result lies in `[w/2, w)` for `jitter ∈ [0, 1)`.
 */
export function backoffDelayMs(
  attempts: number,
  jitter: number,
  options: OutboxBackoff = DEFAULT_OUTBOX_BACKOFF,
): number {
  const n = Math.max(1, Math.floor(attempts))
  // `factor ** (n - 1)` overflows to Infinity for a large n; Math.min collapses that to the cap.
  const window = Math.min(options.capMs, options.baseMs * options.factor ** (n - 1))
  const bounded = Math.min(0.999_999, Math.max(0, jitter))
  return Math.round(window / 2 + (window / 2) * bounded)
}

/** Clamp a server-supplied delay into `[0, RETRY_AFTER_CAP_MS]`. */
export function clampRetryAfter(ms: number): number {
  if (!Number.isFinite(ms)) return RETRY_AFTER_CAP_MS
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.round(ms)))
}

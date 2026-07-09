/**
 * Exponential backoff with **full jitter** (AWS "Exponential Backoff And Jitter"): the delay
 * before retry N is a uniform random value in `[0, min(cap, initial · factor^N))`. Full jitter
 * spreads a thundering herd of reconnecting clients evenly instead of synchronising them on
 * the same doubling schedule. The attempt counter resets to 0 on a healthy connection.
 */

/** Tuning for {@link Backoff}. All fields optional; sensible push defaults are applied. */
export interface BackoffOptions {
  /** Ceiling of the first attempt's window, in ms (default 1000). */
  initialDelay?: number
  /** Maximum window, in ms — the exponential is capped here (default 30000). */
  maxDelay?: number
  /** Growth factor per attempt (default 2). */
  factor?: number
  /** Source of `[0, 1)` randomness for the jitter; injected for deterministic tests. */
  random?: () => number
}

/** Defaults for {@link Backoff}: 1s initial window, doubling, capped at 30s. */
export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = {
  initialDelay: 1000,
  maxDelay: 30000,
  factor: 2,
}

/** Stateful full-jitter backoff. One instance per channel; not safe to share across channels. */
export class Backoff {
  private attempt = 0
  private readonly initialDelay: number
  private readonly maxDelay: number
  private readonly factor: number
  private readonly random: () => number

  constructor(options: BackoffOptions = {}) {
    this.initialDelay = options.initialDelay ?? DEFAULT_BACKOFF.initialDelay
    this.maxDelay = options.maxDelay ?? DEFAULT_BACKOFF.maxDelay
    this.factor = options.factor ?? DEFAULT_BACKOFF.factor
    this.random = options.random ?? Math.random
  }

  /**
   * Returns the next delay in ms and advances the attempt counter. Full jitter:
   * `random() · min(maxDelay, initialDelay · factor^attempt)`, so the value is in
   * `[0, cap)` and never negative.
   */
  next(): number {
    const window = Math.min(this.maxDelay, this.initialDelay * this.factor ** this.attempt)
    this.attempt++
    return Math.floor(this.random() * window)
  }

  /** Resets the attempt counter (call once a connection is healthy). */
  reset(): void {
    this.attempt = 0
  }

  /** Number of attempts counted since the last {@link Backoff.reset}. */
  get attempts(): number {
    return this.attempt
  }
}

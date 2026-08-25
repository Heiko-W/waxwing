/**
 * The offline horizon as a USER preference, layered over the hoster's `config.json` (FR-OFF-02).
 *
 * ## Why this exists
 *
 * `offline.cacheDays` was deployment configuration and nothing else: the hoster set it, the
 * Settings screen printed it, and the person whose disk it fills could not touch it. M3.4 handed a
 * user override to M3.7, M3.7 shipped without one, and nobody noticed for a milestone because the
 * deferral lived in a work-package note rather than in the decision table (B23).
 *
 * The decision that closed it is the owner's, and his reasoning is the whole design: **Waxwing is a
 * client, and this bounds space on the reader's own device.** A hoster may say what a fresh install
 * starts with; they have no standing to say how much of someone else's disk a mail cache may use.
 * So `config.json` becomes the DEFAULT rather than the value, and this module holds the override.
 *
 * ## What it does and does not bound
 *
 * It bounds what the replica KEEPS, never what a folder SHOWS — since ADR-030 the folder query
 * carries no date bound at all, so a smaller horizon costs a round trip when scrolling old mail
 * offline, and nothing at all online. `maxStorageMB` bounds the same cache from the other side and
 * is deliberately NOT exposed here: two controls trimming one budget from two directions is a way
 * to build a state neither of them explains.
 *
 * ## Per device, like the theme
 *
 * `localStorage`, not `localPrefs` in the replica: this is a statement about THIS machine's disk,
 * and syncing it to a phone would be the one place where "keep 365 days" is exactly wrong. Same
 * shape as `app/theme.ts` and `app/shell/layout.ts` — a tiny external store, so the settings
 * control and the sync engine read one value rather than two copies of it.
 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'waxwing.cacheDays'

/**
 * What the control offers. Discrete, not a slider or a number field, for two reasons: the effect of
 * a change is invisible (it lands on the next maintenance pass, up to five minutes later), and a
 * free number invites the values `config.ts` already documents as traps — `0` and the negatives it
 * refuses rather than clamps.
 *
 * The upper end stops at a year. `clampCacheDays` accepts up to 3650, and a hoster may set that;
 * offering it here would be offering a promise the storage budget cannot keep, since the LRU
 * eviction reclaims bodies long before a decade of envelopes accumulates.
 */
export const CACHE_DAYS_CHOICES = [7, 30, 90, 180, 365] as const

const listeners = new Set<() => void>()
let override: number | null = read()

function read(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const value = Number.parseInt(raw, 10)
    // Anything not on the list is not a value this app wrote. Ignore it rather than clamp it: a
    // stored `0` would otherwise become "keep one day", which is precisely the silent
    // reinterpretation `clampCacheDays` refuses for a hoster typo.
    return CACHE_DAYS_CHOICES.includes(value as (typeof CACHE_DAYS_CHOICES)[number]) ? value : null
  } catch {
    return null
  }
}

/** The reader's own choice, or `null` where they have not made one and the hoster's value stands. */
export function getCacheDaysOverride(): number | null {
  return override
}

export function setCacheDaysOverride(days: number | null): void {
  override = days
  try {
    if (days === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(days))
  } catch {
    // Ignore persistence failures (private mode / storage disabled). The in-memory value still
    // holds for this session, which is better than refusing the change.
  }
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** The current override, re-rendering on change. `null` means "whatever the deployment says". */
export function useCacheDaysOverride(): number | null {
  return useSyncExternalStore(subscribe, getCacheDaysOverride, () => null)
}

/**
 * The horizon that actually applies: the reader's choice if they made one, the deployment's
 * otherwise.
 *
 * One function, called by the settings control and by the sync engine, so the number the screen
 * shows is by construction the number the prune uses. Two independent `??` expressions is how the
 * two drift.
 */
export function effectiveCacheDays(hosterCacheDays: number): number {
  return override ?? hosterCacheDays
}

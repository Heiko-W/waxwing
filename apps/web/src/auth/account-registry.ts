/**
 * The signed-in account registry (M5.10, FR-AUTH-07) — the piece ADR-004 deferred.
 *
 * ADR-004 made the auth persistence account-scoped from day one: each account gets its own
 * `waxwing-auth-<scope>` database with an independent wrapping key, so a second account is purely
 * additive. What it left for later is the part that says *which* scopes exist and which one the
 * user is looking at. This is that part, and it is deliberately pure — no IndexedDB, no React —
 * so the rules are testable on their own.
 *
 * **The scope is derived, not generated.** An account is identified by its issuer plus its
 * username, normalised. A random UUID would be simpler and wrong: signing in again to the same
 * mailbox has to find the *same* scope, or the user accumulates duplicate entries that each hold
 * a separate copy of their credentials. Deriving it makes re-authentication idempotent.
 */

/** One signed-in account. */
export interface RegisteredAccount {
  /** The storage scope: also the `SecretStore` database suffix (ADR-004). */
  readonly scope: string
  /** OAuth issuer or server origin. `null` for a Basic sign-in with no discoverable issuer. */
  readonly issuer: string | null
  readonly username: string
  /** What to show in the switcher; falls back to the username. */
  readonly label: string
  readonly addedAt: number
}

export interface AccountRegistry {
  readonly accounts: readonly RegisteredAccount[]
  /** The scope currently being used; `null` when none is signed in. */
  readonly activeScope: string | null
}

export const EMPTY_REGISTRY: AccountRegistry = { accounts: [], activeScope: null }

/** How many accounts one browser profile may hold. */
export const MAX_ACCOUNTS = 5

/**
 * The storage scope for an account.
 *
 * Lower-cased and stripped of everything that is not safe in an IndexedDB database name. The
 * result is stable for a given (issuer, username) pair, which is what makes signing in twice
 * idempotent rather than duplicating.
 *
 * **The two parts are length-prefixed, not merely separated.** A plain separator collides: with
 * `issuer|username`, the pair `("https://a|b", "c")` and the pair `("https://a", "b|c")` both
 * produce `a|b|c`. Two different accounts would then share one `waxwing-auth-<scope>` database and
 * one wrapping key, so either could read the other's refresh token. Prefixing each part with its
 * length makes the encoding unambiguous, which is what closes that.
 */
export function deriveScope(issuer: string | null, username: string): string {
  const issuerPart = issuer ?? 'basic'
  const userPart = username.trim().toLowerCase()
  const raw = `${issuerPart.length}:${issuerPart}|${userPart.length}:${userPart}`
  const cleaned = raw
    .replace(/^(\d+):https?:\/\//, '$1:')
    .replace(/[^a-z0-9@._|:-]+/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
  // Bounded: a database name is not a place for an unbounded string, and 96 characters is far more
  // than any real issuer/username pair needs.
  return cleaned.slice(0, 96)
}

/** Whether `scope` is already registered. */
export function hasAccount(registry: AccountRegistry, scope: string): boolean {
  return registry.accounts.some((account) => account.scope === scope)
}

/**
 * Adds an account, or updates the one that already has this scope, and makes it active.
 *
 * Re-signing in to an account that is already registered is an UPDATE, not a second entry: the
 * scope is derived, so the same mailbox always lands on the same row.
 */
export function addAccount(registry: AccountRegistry, account: RegisteredAccount): AccountRegistry {
  const existing = registry.accounts.findIndex((entry) => entry.scope === account.scope)
  if (existing >= 0) {
    return {
      accounts: registry.accounts.map((entry, index) =>
        // `addedAt` is kept from the original: it records when this account was FIRST added, and
        // a re-authentication is not a new account.
        index === existing ? { ...account, addedAt: entry.addedAt } : entry,
      ),
      activeScope: account.scope,
    }
  }
  if (registry.accounts.length >= MAX_ACCOUNTS) return registry
  return { accounts: [...registry.accounts, account], activeScope: account.scope }
}

/**
 * Removes an account and picks a successor.
 *
 * The successor matters: leaving `activeScope` pointing at a removed account would leave the app
 * with a session it cannot restore and no obvious way back. The first remaining account is chosen,
 * and `null` when none remains — which is the signed-out state.
 */
export function removeAccount(registry: AccountRegistry, scope: string): AccountRegistry {
  const accounts = registry.accounts.filter((account) => account.scope !== scope)
  if (registry.activeScope !== scope) return { accounts, activeScope: registry.activeScope }
  return { accounts, activeScope: accounts[0]?.scope ?? null }
}

/** Switches the active account. A scope that is not registered is ignored rather than trusted. */
export function setActiveAccount(registry: AccountRegistry, scope: string): AccountRegistry {
  if (!hasAccount(registry, scope)) return registry
  return { ...registry, activeScope: scope }
}

/** The active account, or `null`. */
export function activeAccount(registry: AccountRegistry): RegisteredAccount | null {
  if (registry.activeScope === null) return null
  return registry.accounts.find((account) => account.scope === registry.activeScope) ?? null
}

/** Reads a persisted registry, tolerating any shape. */
export function coerceRegistry(value: unknown): AccountRegistry {
  if (typeof value !== 'object' || value === null) return EMPTY_REGISTRY
  const raw = value as { accounts?: unknown; activeScope?: unknown }
  if (!Array.isArray(raw.accounts)) return EMPTY_REGISTRY

  const accounts: RegisteredAccount[] = []
  for (const candidate of raw.accounts) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const entry = candidate as Record<string, unknown>
    if (typeof entry.scope !== 'string' || entry.scope === '') continue
    if (typeof entry.username !== 'string') continue
    accounts.push({
      scope: entry.scope,
      issuer: typeof entry.issuer === 'string' ? entry.issuer : null,
      username: entry.username,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.username,
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0,
    })
  }

  // An `activeScope` naming an account that is not in the list is dropped rather than kept: it
  // would send the app looking for credentials in a database that does not exist.
  const activeScope =
    typeof raw.activeScope === 'string' &&
    accounts.some((account) => account.scope === raw.activeScope)
      ? raw.activeScope
      : (accounts[0]?.scope ?? null)

  return { accounts: accounts.slice(0, MAX_ACCOUNTS), activeScope }
}

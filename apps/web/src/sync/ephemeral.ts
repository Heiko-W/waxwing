/**
 * Public-computer mode: a replica that is meant to leave nothing behind (FR-AUTH-07).
 *
 * ## The problem this exists for
 *
 * Waxwing is offline-first, so signing in writes mail to IndexedDB — envelopes, bodies,
 * attachments, address history — and IndexedDB is **not encrypted**, because a browser gives an
 * application nowhere to put a key that the next person at the same machine could not also reach.
 * On your own laptop that trade is the whole point. On a library terminal it is a data leak with a
 * delay, and until this file existed the only defence was remembering to pick "Sign out & remove
 * data" from a menu on the way out.
 *
 * ## What it does, precisely
 *
 * A session marked ephemeral opens its replica under a **one-off database name** —
 * `waxwing-replica-eph-<random>` — recorded in `localStorage` under {@link EPHEMERAL_INDEX_KEY} and
 * held under a Web Lock for as long as the tab is using it (see {@link claimEphemeral}). The choice
 * applies to **both** sign-in methods: Basic passes it straight through, and OAuth carries it across
 * the redirect inside the PKCE transaction so the callback also keeps the refresh token in memory
 * and writes no AuthRecord — otherwise the mail would be gone but the credential to fetch it again
 * would still be sitting on the machine.
 *
 * Three things remove the replica:
 *
 *  1. **Sign-out.** Either menu item wipes it; in this mode there is no "keep my cache" variant.
 *  2. **`pagehide`.** A best-effort delete when the tab goes away. Browsers give a page very little
 *     time here and `indexedDB.deleteDatabase` is not guaranteed to finish, which is why it is not
 *     the only mechanism.
 *  3. **The next start.** {@link sweepEphemeral} deletes every name in the index that is not the
 *     current session's. This is the one that covers a crash, a killed browser, a power cut — the
 *     cases (2) cannot. Whoever opens Waxwing next on that machine clears the previous person's
 *     mail before they could look at it.
 *
 * ## What it does NOT do, and this is written here so nobody has to infer it
 *
 * Between a crash and the next start, the data is on disk. Someone who opens devtools in that
 * window can read it. No browser API closes that gap: there is no "delete this database when the
 * tab dies" primitive, and an in-memory database is not something IndexedDB offers. The UI says so
 * rather than implying a guarantee this cannot make.
 *
 * It also does not hide anything from the SERVER, or from anyone with the password. It is about one
 * thing: mail left on a disk that is not yours.
 */

/** `localStorage` key holding the JSON array of ephemeral database names ever created here. */
export const EPHEMERAL_INDEX_KEY = 'waxwing.ephemeralDbs'

/** Prefix every ephemeral database shares, so a sweep can recognise one by name alone. */
export const EPHEMERAL_DB_PREFIX = 'waxwing-replica-eph-'

/** Reads the index defensively: a corrupt value must not stop a sweep from running. */
function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(EPHEMERAL_INDEX_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function writeIndex(names: readonly string[]): void {
  try {
    if (names.length === 0) localStorage.removeItem(EPHEMERAL_INDEX_KEY)
    else localStorage.setItem(EPHEMERAL_INDEX_KEY, JSON.stringify(names))
  } catch {
    // A full or blocked localStorage must not stop the session from starting. The name is still
    // prefixed, so `sweepEphemeral` can find it through `indexedDB.databases()` where supported.
  }
}

/**
 * A random suffix that does not need a secure context.
 *
 * `crypto.randomUUID` is secure-context-only, and Waxwing explicitly supports a plain-HTTP
 * deployment (the sign-in form says so, offering Basic when OAuth's PKCE cannot run). On such an
 * origin `randomUUID` throws a TypeError, which surfaced as "Could not reach the server" — the user
 * then unticks the box, tries again, and gets a durable replica on a machine they had just told us
 * was not theirs. `getRandomValues` carries no such restriction.
 */
function randomSuffix(): string {
  if (typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID()
    } catch {
      // Insecure context — fall through.
    }
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * A fresh database name for an ephemeral session, recorded so a later sweep can find it, and
 * CLAIMED so a sweep in another tab does not delete it while it is in use.
 *
 * The name is random rather than a counter or a timestamp: two tabs opened in the same second must
 * not collide, and a predictable name is a name someone else can look for.
 */
export function newEphemeralDbName(): string {
  const name = `${EPHEMERAL_DB_PREFIX}${randomSuffix()}`
  writeIndex([...readIndex(), name])
  claimEphemeral(name)
  return name
}

/** Web Lock name under which a tab holds its live ephemeral replica. */
function lockName(dbName: string): string {
  return `waxwing.ephemeral.${dbName}`
}

/** Releases this tab's claim; set while one is held. */
let releaseClaim: (() => void) | undefined

/**
 * Hold a lock on `name` for as long as this tab is using it.
 *
 * Without this, the sweep is indiscriminate across tabs: it enumerates every ephemeral database on
 * the profile, and the one tab 1 is actively writing looks exactly like the leftovers of a session
 * that crashed last week. Dexie closes on `versionchange`, so the delete SUCCEEDS — tab 1 keeps
 * running against a silently emptied database and loses its cache, its drafts and any message still
 * inside the undo-send window.
 *
 * A Web Lock is the right primitive because the browser releases it when the tab dies, however it
 * dies. That is precisely the distinction the sweep needs: "in use right now" versus "left behind".
 */
function claimEphemeral(name: string): void {
  const locks = globalThis.navigator?.locks
  if (locks === undefined) return
  void locks
    .request(lockName(name), () => new Promise<void>((resolve) => (releaseClaim = resolve)))
    .catch(() => {
      // A failed claim only costs protection against a concurrent sweep, never correctness.
    })
}

/** Give up this tab's claim, so the next sweep may collect the database (sign-out). */
export function releaseEphemeralClaim(): void {
  releaseClaim?.()
  releaseClaim = undefined
}

/** Whether some tab currently holds `name`. Absent Web Locks (jsdom, old Safari) → treated as free. */
async function isClaimed(name: string): Promise<boolean> {
  const locks = globalThis.navigator?.locks
  if (locks === undefined) return false
  try {
    return await locks.request(lockName(name), { ifAvailable: true }, (lock) => lock === null)
  } catch {
    return false
  }
}

/** Every ephemeral database this browser profile knows about, from the index AND from the engine. */
async function knownEphemeralNames(): Promise<string[]> {
  const names = new Set(readIndex())
  // `indexedDB.databases()` catches what the index cannot: a session whose `localStorage` write was
  // blocked, or whose index entry was cleared by a site-data reset that left the database behind.
  // It is Baseline 2024 (Firefox shipped it in 126); the index is kept anyway because the two fail
  // in different directions and the cost of keeping both is a `Set` union.
  if (typeof indexedDB.databases === 'function') {
    try {
      for (const info of await indexedDB.databases()) {
        if (info.name?.startsWith(EPHEMERAL_DB_PREFIX) === true) names.add(info.name)
      }
    } catch {
      // Not fatal: fall back to the index alone.
    }
  }
  return [...names]
}

/** Delete one database. Resolves `true` when it is genuinely gone, `false` on error or blocked. */
function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve(true)
    // Never reject and never hang: a sweep that waits on a stuck database would block the app from
    // starting. But `blocked` and `error` mean the data is STILL THERE, so the name has to stay in
    // the index for the next attempt rather than being quietly forgotten.
    request.onerror = () => resolve(false)
    request.onblocked = () => resolve(false)
  })
}

/**
 * Delete every ephemeral replica except `keep` and those a live tab still claims; return how many
 * went.
 *
 * Called at startup BEFORE any session opens, which is what makes it a crash guard rather than
 * housekeeping: the leftovers of whoever used this machine last are gone before the app has drawn
 * anything, let alone let anyone read them.
 *
 * @param keep the current session's database name, when this session is itself ephemeral.
 */
export async function sweepEphemeral(keep?: string): Promise<number> {
  const candidates = (await knownEphemeralNames()).filter((name) => name !== keep)
  const outcomes = await Promise.all(
    candidates.map(async (name) => {
      // Another tab is using it right now — that is a live session, not a leftover.
      if (await isClaimed(name)) return { name, gone: false }
      return { name, gone: await deleteDatabase(name) }
    }),
  )
  const survivors = outcomes.filter((outcome) => !outcome.gone).map((outcome) => outcome.name)
  // Read-modify-write against the CURRENT index, not the snapshot this sweep started from. A
  // sign-in that happened while the deletes were in flight has already appended its own name, and
  // a blind overwrite would drop it — leaving a live ephemeral database that no later sweep looks
  // for by name.
  const current = readIndex()
  const kept = new Set([...survivors, ...(keep === undefined ? [] : [keep])])
  for (const name of current) {
    if (!candidates.includes(name)) kept.add(name)
  }
  writeIndex([...kept])
  return outcomes.filter((outcome) => outcome.gone).length
}

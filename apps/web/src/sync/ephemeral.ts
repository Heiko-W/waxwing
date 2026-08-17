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
 * `waxwing-replica-eph-<random>` — recorded in `localStorage` under {@link EPHEMERAL_INDEX_KEY}.
 * Three things then remove it:
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
 * A fresh database name for an ephemeral session, recorded so a later sweep can find it.
 *
 * `crypto.randomUUID` rather than a counter or a timestamp: two tabs opened in the same second must
 * not collide, and a predictable name is a name someone else can look for.
 */
export function newEphemeralDbName(): string {
  const name = `${EPHEMERAL_DB_PREFIX}${crypto.randomUUID()}`
  writeIndex([...readIndex(), name])
  return name
}

/** Every ephemeral database this browser profile knows about, from the index AND from the engine. */
async function knownEphemeralNames(): Promise<string[]> {
  const names = new Set(readIndex())
  // `indexedDB.databases()` catches what the index cannot: a session whose `localStorage` write was
  // blocked, or whose index entry was cleared by a site-data reset that left the database behind.
  // Firefox does not implement it, which is exactly why the index exists as well — neither source
  // is sufficient alone.
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

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    // Resolve on every outcome including `blocked` — a database another tab still holds open cannot
    // be deleted now, and a sweep that hangs on it would block the app from starting.
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

/**
 * Delete every ephemeral replica except `keep`, and return how many went.
 *
 * Called at startup BEFORE any session opens, which is what makes it a crash guard rather than
 * housekeeping: the leftovers of whoever used this machine last are gone before the app has drawn
 * anything, let alone let anyone read them.
 *
 * @param keep the current session's database name, when this session is itself ephemeral.
 */
export async function sweepEphemeral(keep?: string): Promise<number> {
  const names = (await knownEphemeralNames()).filter((name) => name !== keep)
  await Promise.all(names.map(deleteDatabase))
  writeIndex(keep === undefined ? [] : [keep])
  return names.length
}

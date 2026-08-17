/**
 * Public-computer mode (FR-AUTH-07).
 *
 * The promise is narrow and worth stating exactly: mail written on someone else's machine is gone
 * again. Three mechanisms deliver it — sign-out, `pagehide`, and a sweep at the next start — and the
 * third is the one that matters most, because it is the only one that survives the browser dying.
 * These tests are about the sweep and the naming that makes it possible.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EPHEMERAL_DB_PREFIX,
  EPHEMERAL_INDEX_KEY,
  newEphemeralDbName,
  sweepEphemeral,
} from './ephemeral'

/** Create a real IndexedDB database so the sweep has something to actually delete. */
function createDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('x')
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

async function existingNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '')
}

beforeEach(async () => {
  localStorage.clear()
  // `fake-indexeddb/auto` is module-scoped, so databases outlive a test. Each case below counts
  // what is on disk, which only means anything from an empty one.
  for (const info of await indexedDB.databases()) {
    if (info.name !== undefined) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(info.name as string)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
    }
  }
})

describe('ephemeral database names', () => {
  it('are unique, prefixed, and recorded', () => {
    const a = newEphemeralDbName()
    const b = newEphemeralDbName()

    expect(a).not.toBe(b) // two tabs opened in the same second must not collide
    expect(a.startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
    expect(JSON.parse(localStorage.getItem(EPHEMERAL_INDEX_KEY) ?? '[]')).toEqual([a, b])
  })

  it('survives a corrupt index rather than throwing', () => {
    localStorage.setItem(EPHEMERAL_INDEX_KEY, 'not json at all')
    // A broken index must not stop a session from starting — nor from being swept later.
    expect(() => newEphemeralDbName()).not.toThrow()
  })
})

describe('the startup sweep', () => {
  it('deletes every leftover ephemeral database', async () => {
    const first = newEphemeralDbName()
    const second = newEphemeralDbName()
    await createDb(first)
    await createDb(second)
    await createDb('waxwing-replica') // the durable one, from an ordinary session
    expect(await existingNames()).toHaveLength(3)

    const removed = await sweepEphemeral()

    expect(removed).toBe(2)
    // THE assertion: someone else's mail is gone before this session shows anything.
    expect(await existingNames()).toEqual(['waxwing-replica'])
    expect(localStorage.getItem(EPHEMERAL_INDEX_KEY)).toBeNull()
  })

  it('keeps the current session and clears the rest', async () => {
    const previous = newEphemeralDbName()
    const mine = newEphemeralDbName()
    await createDb(previous)
    await createDb(mine)

    const removed = await sweepEphemeral(mine)

    expect(removed).toBe(1)
    expect(await existingNames()).toEqual([mine])
    // The index keeps exactly the live name, so the NEXT start sweeps this one too.
    expect(JSON.parse(localStorage.getItem(EPHEMERAL_INDEX_KEY) ?? '[]')).toEqual([mine])
  })

  it('finds a database the index lost — the crash case the index cannot cover', async () => {
    // A session whose `localStorage` write was blocked (private mode, full quota) still created a
    // prefixed database. `indexedDB.databases()` is the second source that catches it; without it
    // that mail would sit on the disk forever, which is the whole failure this mode exists to stop.
    await createDb(`${EPHEMERAL_DB_PREFIX}orphan-with-no-index-entry`)
    expect(localStorage.getItem(EPHEMERAL_INDEX_KEY)).toBeNull()

    const removed = await sweepEphemeral()

    expect(removed).toBe(1)
    expect(await existingNames()).toEqual([])
  })

  it('never touches the durable replica', async () => {
    await createDb('waxwing-replica')
    await createDb('waxwing-auth')

    await sweepEphemeral()

    // An ordinary session on a personal machine must come back to its cache. A sweep that took the
    // durable replica would turn every public-computer sign-in into a month of lost offline mail
    // for everyone else using that browser.
    expect((await existingNames()).toSorted()).toEqual(['waxwing-auth', 'waxwing-replica'])
  })
})

describe('the sweep does not collect a database that is still in use', () => {
  /** A Web Locks stand-in: `held` names behave as locked by another tab. */
  function stubLocks(held: ReadonlySet<string>): void {
    const locks = {
      request: async (
        name: string,
        optionsOrCallback: unknown,
        maybeCallback?: (lock: unknown) => unknown,
      ) => {
        const callback = (maybeCallback ?? optionsOrCallback) as (lock: unknown) => unknown
        const available = !held.has(name)
        // `ifAvailable` hands the callback `null` when the lock could not be granted.
        return callback(available ? { name } : null)
      },
    }
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips one another tab currently holds', async () => {
    // Two tabs is where this bites. Tab 2 starts, sweeps, and sees tab 1's LIVE ephemeral replica
    // — which looks exactly like the leftovers of a session that crashed last week. Dexie closes
    // on `versionchange`, so the delete SUCCEEDS: tab 1 keeps running against a silently emptied
    // database and loses its cache, its drafts, and any message still inside the undo-send window.
    const live = newEphemeralDbName()
    const abandoned = newEphemeralDbName()
    await createDb(live)
    await createDb(abandoned)
    stubLocks(new Set([`waxwing.ephemeral.${live}`]))

    const removed = await sweepEphemeral()

    expect(removed).toBe(1)
    expect(await existingNames()).toEqual([live])
    // …and it stays in the index, so the sweep AFTER that tab closes still finds it.
    expect(JSON.parse(localStorage.getItem(EPHEMERAL_INDEX_KEY) ?? '[]')).toEqual([live])
  })

  it('still collects one whose tab has gone — the counter-test', async () => {
    // Without this, "never delete anything claimed" would look identical to "never delete
    // anything", and the crash guard — the whole point of the mode — would be gone.
    const abandoned = newEphemeralDbName()
    await createDb(abandoned)
    stubLocks(new Set())

    expect(await sweepEphemeral()).toBe(1)
    expect(await existingNames()).toEqual([])
  })
})

describe('the index survives what happens around a sweep', () => {
  it('keeps a name that appeared while the sweep was running', async () => {
    // `sweepEphemeral` used to end with a blind `writeIndex([])` against the state it read at the
    // start. Signing in during the deletes appended a new name, which that overwrite then dropped —
    // leaving a live ephemeral database that no later sweep looks for by name.
    const old = newEphemeralDbName()
    await createDb(old)

    // Interleave a sign-in: `deleteDatabase` is async, so this lands between the read and the write.
    const sweeping = sweepEphemeral()
    const signedInMeanwhile = newEphemeralDbName()
    await sweeping

    expect(JSON.parse(localStorage.getItem(EPHEMERAL_INDEX_KEY) ?? '[]')).toContain(
      signedInMeanwhile,
    )
  })

  it('keeps a name whose database could not be deleted', async () => {
    // `blocked` and `error` mean the data is STILL THERE. Forgetting the name would retire the one
    // record that says so, on exactly the database that most needs a second attempt.
    const stuck = newEphemeralDbName()
    await createDb(stuck)
    const holdOpen = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(stuck, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const removed = await sweepEphemeral()

    expect(removed).toBe(0)
    expect(JSON.parse(localStorage.getItem(EPHEMERAL_INDEX_KEY) ?? '[]')).toEqual([stuck])
    holdOpen.close()
  })
})

describe('the name generator works where the mode is offered', () => {
  it('does not need a secure context', () => {
    // `crypto.randomUUID` is secure-context-only, and a plain-HTTP deployment is explicitly
    // supported — the sign-in form says so, offering Basic when OAuth's PKCE cannot run. There the
    // throw surfaced as "Could not reach the server", so the user unticked the box, tried again,
    // and got a durable replica on a machine they had just told us was not theirs.
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not available in insecure contexts')
    })

    const name = newEphemeralDbName()

    expect(name.startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
    expect(name).not.toBe(newEphemeralDbName())
    vi.restoreAllMocks()
  })
})

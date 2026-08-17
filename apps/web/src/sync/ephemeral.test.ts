/**
 * Public-computer mode (FR-AUTH-07).
 *
 * The promise is narrow and worth stating exactly: mail written on someone else's machine is gone
 * again. Three mechanisms deliver it — sign-out, `pagehide`, and a sweep at the next start — and the
 * third is the one that matters most, because it is the only one that survives the browser dying.
 * These tests are about the sweep and the naming that makes it possible.
 */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
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

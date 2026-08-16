/**
 * Engine-registry resolution (M4.4 Etappe 4) — the rule that decides WHICH engine a write reaches.
 *
 * This is the anti-corruption boundary, so it is tested as a rule rather than through a UI: JMAP
 * mailbox and email ids are per-account and SHORT (`a`, `b`, …), so an intent handed to the wrong
 * engine does not fail — it succeeds, against a different account's identically-id'd mailbox. Every
 * assertion below exists because a plausible simplification of `getEngineFor` reopens exactly that.
 */

import type { Id } from '@waxwing/jmap'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearEngines,
  getActiveEngine,
  getEngineFor,
  getRunningEngines,
  type SyncEngine,
  setActiveEngine,
  setEngineFor,
  stopAllEngines,
  subscribeEngines,
} from './engine'

/** A stand-in engine: the registry only ever holds and hands back references. */
function fakeEngine(accountId: Id, onStop?: () => void): SyncEngine {
  return { accountId, stop: async () => onStop?.() } as unknown as SyncEngine
}

afterEach(() => {
  clearEngines()
})

describe('engine registry (M4.4)', () => {
  it('hands every account its OWN engine', () => {
    const primary = fakeEngine('acctP')
    const shared = fakeEngine('acctS')
    setActiveEngine(primary)
    setEngineFor('acctP', primary)
    setEngineFor('acctS', shared)

    expect(getEngineFor('acctP')).toBe(primary)
    expect(getEngineFor('acctS')).toBe(shared)
  })

  it('answers a MISS on a populated registry with null, never the primary', () => {
    // The corruption case. `acctGone` is a share the session no longer grants (revoked mid-session, or
    // a teardown window). Substituting the primary here would run the caller's intent — carrying
    // acctGone's short mailbox id — against the primary's mailbox of the same id.
    const primary = fakeEngine('acctP')
    setActiveEngine(primary)
    setEngineFor('acctP', primary)

    expect(getEngineFor('acctGone')).toBeNull()
    // Stated as the mutation it guards: `?? activeEngine` on the miss branch would make this pass.
    expect(getEngineFor('acctGone')).not.toBe(primary)
  })

  it('falls back to the primary while the registry is EMPTY', () => {
    // No fleet has published: the pre-M4.4 world, and every component test that sets a bare engine.
    // This clause is what keeps the single-account path byte-for-byte unchanged.
    const engine = fakeEngine('acctP')
    setActiveEngine(engine)

    expect(getEngineFor('acctP')).toBe(engine)
    expect(getEngineFor('anything-at-all')).toBe(engine)
    expect(getEngineFor(null)).toBe(engine)
  })

  it('degrades a null account to the primary (a component with no ReplicaProvider)', () => {
    const primary = fakeEngine('acctP')
    setActiveEngine(primary)
    setEngineFor('acctP', primary)
    setEngineFor('acctS', fakeEngine('acctS'))

    expect(getEngineFor(null)).toBe(primary)
  })

  it('withdraws a single account without touching the others', () => {
    const primary = fakeEngine('acctP')
    const shared = fakeEngine('acctS')
    setActiveEngine(primary)
    setEngineFor('acctP', primary)
    setEngineFor('acctS', shared)

    setEngineFor('acctS', null)

    expect(getEngineFor('acctS')).toBeNull()
    expect(getEngineFor('acctP')).toBe(primary)
  })

  it('lists every running engine, primary first', () => {
    const primary = fakeEngine('acctP')
    const shared = fakeEngine('acctS')
    setEngineFor('acctP', primary)
    setEngineFor('acctS', shared)

    expect(getRunningEngines()).toEqual([primary, shared])
  })

  it('lists the bare primary handle when no fleet has published', () => {
    const engine = fakeEngine('acctP')
    setActiveEngine(engine)

    expect(getRunningEngines()).toEqual([engine])
  })

  it('stops EVERY engine on sign-out, handles withdrawn first', async () => {
    // The wipe blocks on any open IndexedDB handle, and since the fleet the shared engines hold one
    // too. Withdrawing before stopping also means a click in this window can no longer reach them.
    const stopped: Id[] = []
    const primary = fakeEngine('acctP', () => stopped.push('acctP'))
    const shared = fakeEngine('acctS', () => stopped.push('acctS'))
    setActiveEngine(primary)
    setEngineFor('acctP', primary)
    setEngineFor('acctS', shared)

    const pending = stopAllEngines()
    expect(getEngineFor('acctS')).toBeNull()
    expect(getEngineFor('acctP')).toBeNull()
    expect(getActiveEngine()).toBeNull()
    await pending

    expect(stopped.toSorted()).toEqual(['acctP', 'acctS'])
  })

  it('survives an engine that throws on stop', async () => {
    const thrower = {
      accountId: 'acctS',
      stop: async () => {
        throw new Error('lock release failed')
      },
    } as unknown as SyncEngine
    const stopped: Id[] = []
    setEngineFor(
      'acctP',
      fakeEngine('acctP', () => stopped.push('acctP')),
    )
    setEngineFor('acctS', thrower)

    await expect(stopAllEngines()).resolves.toBeUndefined()
    expect(stopped).toEqual(['acctP'])
  })

  it('notifies subscribers on BOTH mutators, so a pane re-renders when its engine appears', () => {
    // A pane can mount before the fleet effect commits; a one-shot null read would leave its watch
    // unregistered for the life of the pane — a list window that never resolves.
    let notifications = 0
    const unsubscribe = subscribeEngines(() => {
      notifications += 1
    })

    setActiveEngine(fakeEngine('acctP'))
    setEngineFor('acctS', fakeEngine('acctS'))
    setEngineFor('acctS', null)
    unsubscribe()
    setEngineFor('acctP', fakeEngine('acctP'))

    expect(notifications).toBe(3)
  })

  it('leaves nothing dispatchable after a sign-out', () => {
    setActiveEngine(fakeEngine('acctP'))
    setEngineFor('acctP', fakeEngine('acctP'))
    setEngineFor('acctS', fakeEngine('acctS'))

    clearEngines()

    expect(getEngineFor('acctP')).toBeNull()
    expect(getEngineFor('acctS')).toBeNull()
    expect(getActiveEngine()).toBeNull()
    expect(getRunningEngines()).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { type LockManagerLike, startLeaderElection } from './leader'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Entry {
  cb: (lock: unknown) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  granted: boolean
}

/** Models `navigator.locks` exclusive-mode queueing: one holder at a time, FIFO handover. */
class FakeLockManager implements LockManagerLike {
  private readonly busy = new Set<string>()
  private readonly queues = new Map<string, Entry[]>()

  request(
    name: string,
    options: { signal?: AbortSignal },
    cb: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: Entry = { cb, resolve, reject, granted: false }
      const queue = this.queues.get(name) ?? []
      queue.push(entry)
      this.queues.set(name, queue)

      const signal = options.signal
      if (signal) {
        const onAbort = () => {
          if (entry.granted) return // the holder resolves itself via its callback promise
          const q = this.queues.get(name)
          const index = q?.indexOf(entry) ?? -1
          if (q && index >= 0) q.splice(index, 1)
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pump(name)
    })
  }

  private pump(name: string): void {
    if (this.busy.has(name)) return
    const queue = this.queues.get(name) ?? []
    const entry = queue.shift()
    if (!entry) return
    this.busy.add(name)
    entry.granted = true
    Promise.resolve()
      .then(() => entry.cb(undefined))
      .then(
        (value) => {
          this.busy.delete(name)
          entry.resolve(value)
          this.pump(name)
        },
        (error) => {
          this.busy.delete(name)
          entry.reject(error)
          this.pump(name)
        },
      )
  }
}

describe('startLeaderElection', () => {
  it('elects one leader and hands over when the leader releases', async () => {
    const locks = new FakeLockManager()
    const a = new AbortController()
    const b = new AbortController()
    const roles: string[] = []

    const pa = startLeaderElection({
      locks,
      signal: a.signal,
      onLeadership: (isLeader) => roles.push(`a:${isLeader}`),
    })
    const pb = startLeaderElection({
      locks,
      signal: b.signal,
      onLeadership: (isLeader) => roles.push(`b:${isLeader}`),
    })
    await flush()

    // A leads; B waits in the queue.
    expect(roles).toContain('a:true')
    expect(roles).not.toContain('b:true')

    a.abort() // A releases leadership
    await pa
    await flush()

    // B takes over.
    expect(roles).toContain('b:true')

    b.abort()
    await pb
  })

  it('a follower that aborts while queued resolves without ever leading', async () => {
    const locks = new FakeLockManager()
    const a = new AbortController()
    const b = new AbortController()
    const bRoles: boolean[] = []

    const pa = startLeaderElection({ locks, signal: a.signal, onLeadership: () => {} })
    const pb = startLeaderElection({
      locks,
      signal: b.signal,
      onLeadership: (isLeader) => bRoles.push(isLeader),
    })
    await flush()

    b.abort() // abort while still queued behind A
    await expect(pb).resolves.toBeUndefined()
    expect(bRoles).not.toContain(true)

    a.abort()
    await pa
  })

  it('an already-aborted signal never enters the election', async () => {
    const locks = new FakeLockManager()
    const controller = new AbortController()
    controller.abort()
    const roles: boolean[] = []

    await startLeaderElection({
      locks,
      signal: controller.signal,
      onLeadership: (isLeader) => roles.push(isLeader),
    })

    expect(roles).toEqual([false])
  })
})

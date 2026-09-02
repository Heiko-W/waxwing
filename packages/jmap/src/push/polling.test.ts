import { describe, expect, it } from 'vitest'
import { bearer } from '../auth'
import { makeSession } from '../test-support'
import type { FetchLike } from '../transport'
import type { StateChange } from '../types/push'
import { PollingChannel } from './polling'
import { FakeScheduler, sessionFetchMock, tick } from './test-support'
import type { PushStatus } from './types'

const auth = bearer('tok')

describe('PollingChannel', () => {
  it('reaches open after the first successful session poll', async () => {
    const statuses: PushStatus[] = []
    const channel = new PollingChannel({
      session: makeSession(),
      auth,
      fetch: sessionFetchMock(['s0']).fetch,
      scheduler: new FakeScheduler(),
    })
    channel.onStatus((status) => statuses.push(status))

    channel.open()
    await tick()

    expect(statuses).toContain('connecting')
    expect(channel.status).toBe('open')

    channel.close()
    expect(channel.status).toBe('closed')
  })

  it('emits a coarse resync StateChange when the polled state differs from the baseline', async () => {
    // Baseline is makeSession().state ('s0'); the first (immediate) poll returns 's1' ⇒ resync.
    const changes: StateChange[] = []
    const channel = new PollingChannel({
      session: makeSession(),
      auth,
      fetch: sessionFetchMock(['s1']).fetch,
      scheduler: new FakeScheduler(),
    })
    channel.subscribe((change) => changes.push(change))

    channel.open()
    await tick()

    expect(channel.status).toBe('open')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.['@type']).toBe('StateChange')
    // Every known account, with an EMPTY type map — a "resync everything" signal.
    expect(changes[0]?.changed).toEqual({ a: {} })

    channel.close()
  })

  it('emits nothing while the session state is unchanged', async () => {
    const changes: StateChange[] = []
    const channel = new PollingChannel({
      session: makeSession(),
      auth,
      fetch: sessionFetchMock(['s0']).fetch, // equals the baseline
      scheduler: new FakeScheduler(),
    })
    channel.subscribe((change) => changes.push(change))

    channel.open()
    await tick()

    expect(channel.status).toBe('open')
    expect(changes).toHaveLength(0)

    channel.close()
  })

  it('goes reconnecting on a fetch error and recovers to open', async () => {
    const scheduler = new FakeScheduler()
    let failNext = true
    const fetch: FetchLike = () => {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('network'))
      }
      return Promise.resolve(
        new Response(JSON.stringify(makeSession()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const statuses: PushStatus[] = []
    const errors: Error[] = []
    const channel = new PollingChannel({
      session: makeSession(),
      auth,
      fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.onStatus((status) => statuses.push(status))
    channel.onError((error) => errors.push(error))

    channel.open()
    await tick() // first poll rejects ⇒ reportClosed ⇒ reconnecting

    expect(errors).toHaveLength(1)
    expect(channel.status).toBe('reconnecting')

    scheduler.runNext() // fire the reconnect timer ⇒ a fresh connect() attempt
    await tick()

    expect(channel.status).toBe('open')
    channel.close()
  })

  /**
   * R-91. `resync` reads `session.accounts`, which `isSessionShape` deliberately does not require —
   * and it ran OUTSIDE the `try` around the fetch. A server whose session omits `accounts` therefore
   * produced an unhandled `TypeError`, `scheduleNext()` was never reached, and the channel sat at
   * `open` and never polled again: no `onError`, no reconnect, nothing for the app to notice.
   */
  it('keeps polling a session that omits accounts instead of dying at open', async () => {
    const scheduler = new FakeScheduler()
    const calls = { count: 0 }
    const fetch: FetchLike = () => {
      calls.count++
      const { accounts: _accounts, ...rest } = makeSession()
      return Promise.resolve(
        new Response(JSON.stringify({ ...rest, state: `s${String(calls.count)}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const changes: StateChange[] = []
    const channel = new PollingChannel({ session: makeSession(), auth, fetch, scheduler })
    channel.subscribe((change) => changes.push(change))

    channel.open()
    await tick()

    expect(channel.status).toBe('open')
    // A session with no accounts means "nothing to resync", not a crash.
    expect(changes).toEqual([{ '@type': 'StateChange', changed: {} }])
    expect(calls.count).toBe(1)

    // The load-bearing half: the next poll was ARMED. Before the fix `scheduleNext()` was never
    // reached, so this timer did not exist and the channel never fetched again.
    expect(scheduler.pending).toBeGreaterThan(0)
    // Not necessarily the OLDEST live timer — the reconnect policy arms a stable-reset one at
    // `open` as well — so run what is live until the next fetch happens.
    for (let i = 0; i < 4 && calls.count < 2; i++) {
      scheduler.runNext()
      await tick()
    }
    expect(calls.count).toBe(2)

    channel.close()
  })

  it('close() cancels the scheduled poll and stops fetching', async () => {
    const scheduler = new FakeScheduler()
    const { fetch, calls } = sessionFetchMock(['s0'])
    const channel = new PollingChannel({ session: makeSession(), auth, fetch, scheduler })

    channel.open()
    await tick() // initial poll (calls.count === 1), open, timers armed

    expect(calls.count).toBe(1)
    channel.close()
    expect(scheduler.pending).toBe(0) // poll timer + stable-reset timer both cancelled

    scheduler.runNext() // nothing live to run
    await tick()
    expect(calls.count).toBe(1) // no further poll after close
  })
})

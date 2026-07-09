import { describe, expect, it, vi } from 'vitest'
import { Backoff } from './backoff'
import { type ConnectionHandlers, ReconnectLoop } from './reconnect'
import { FakeScheduler } from './test-support'
import type { PushStatus } from './types'

/** A connector whose attempts are captured so the test can drive open/close per attempt. */
function fakeConnector() {
  const attempts: { handlers: ConnectionHandlers; closed: boolean }[] = []
  const connect = (handlers: ConnectionHandlers) => {
    const attempt = { handlers, closed: false }
    attempts.push(attempt)
    return {
      close: () => {
        attempt.closed = true
      },
    }
  }
  return { connect, attempts }
}

function makeLoop(overrides: Partial<Parameters<typeof buildConfig>[0]> = {}) {
  return buildConfig(overrides)
}

function buildConfig(opts: {
  connector?: ReturnType<typeof fakeConnector>
  scheduler?: FakeScheduler
  backoff?: Backoff
  retryHint?: () => number | undefined
  stableAfter?: number
  onStatus?: (status: PushStatus, loop: ReconnectLoop) => void
}) {
  const connector = opts.connector ?? fakeConnector()
  const scheduler = opts.scheduler ?? new FakeScheduler()
  const backoff = opts.backoff ?? new Backoff({ random: () => 1 })
  const statuses: PushStatus[] = []
  const errors: Error[] = []
  const loop = new ReconnectLoop({
    connect: connector.connect,
    backoff,
    scheduler,
    onStatus: (status) => {
      statuses.push(status)
      opts.onStatus?.(status, loop)
    },
    onError: (error) => errors.push(error),
    ...(opts.retryHint ? { retryHint: opts.retryHint } : {}),
    ...(opts.stableAfter !== undefined ? { stableAfter: opts.stableAfter } : {}),
  })
  return { loop, connector, scheduler, backoff, statuses, errors }
}

describe('ReconnectLoop', () => {
  it('connects on start and reports open on a healthy connection', () => {
    const { loop, connector, statuses } = makeLoop({})
    loop.start()
    expect(connector.attempts).toHaveLength(1)
    expect(statuses).toEqual(['connecting'])
    connector.attempts[0]?.handlers.reportOpen()
    expect(statuses).toEqual(['connecting', 'open'])
  })

  it('is idempotent on repeated start()', () => {
    const { loop, connector } = makeLoop({})
    loop.start()
    loop.start()
    expect(connector.attempts).toHaveLength(1)
  })

  it('schedules a backed-off reconnect after a drop and reconnects when the timer fires', () => {
    const { loop, connector, scheduler, statuses } = makeLoop({})
    loop.start()
    connector.attempts[0]?.handlers.reportOpen()
    connector.attempts[0]?.handlers.reportClosed(new Error('drop'))
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting'])
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    expect(connector.attempts).toHaveLength(2)
  })

  it('reports the error passed to reportClosed', () => {
    const { loop, connector, errors } = makeLoop({})
    loop.start()
    const boom = new Error('boom')
    connector.attempts[0]?.handlers.reportClosed(boom)
    expect(errors).toEqual([boom])
  })

  it('does not emit an error on a clean close, but still reconnects', () => {
    const { loop, connector, scheduler, errors } = makeLoop({})
    loop.start()
    connector.attempts[0]?.handlers.reportClosed()
    expect(errors).toEqual([])
    expect(scheduler.pending).toBe(1)
  })

  it('resets backoff after a connection stays stable so the next drop starts from the base delay', () => {
    const backoff = new Backoff({ initialDelay: 100, factor: 2, random: () => 1 })
    const { loop, connector, scheduler } = makeLoop({ backoff, stableAfter: 50 })
    loop.start()
    // First drop without ever opening ⇒ attempt 0 window (100), attempt grows.
    connector.attempts[0]?.handlers.reportClosed(new Error('a'))
    expect(scheduler.delays).toEqual([100])
    scheduler.runNext()
    // Second connection opens and STAYS stable past the window (stability timer fires) ⇒
    // backoff resets, so the next drop is back to the base window (100), not 200.
    connector.attempts[1]?.handlers.reportOpen()
    scheduler.runNext() // fire the stability timer ⇒ backoff.reset()
    connector.attempts[1]?.handlers.reportClosed(new Error('b'))
    expect(scheduler.delays).toEqual([100])
  })

  it('escalates backoff on a flapping server (open→immediate drop), never pinning the base window', () => {
    // Finding: reportOpen used to reset backoff on connection-*established*; a server that
    // accepts then instantly drops kept the window at the base delay ⇒ ~2 reconnects/s storm.
    const backoff = new Backoff({ initialDelay: 100, factor: 2, random: () => 1 })
    const scheduler = new FakeScheduler()
    const { loop, connector } = makeLoop({ backoff, scheduler, stableAfter: 10_000 })
    loop.start()
    // Cycle 1: open then drop BEFORE the stability window ⇒ no reset.
    connector.attempts[0]?.handlers.reportOpen()
    connector.attempts[0]?.handlers.reportClosed(new Error('flap'))
    expect(scheduler.delays).toEqual([100]) // attempt-0 window
    scheduler.runNext() // fire reconnect ⇒ attempt 1
    // Cycle 2: open then drop again before stability ⇒ still no reset ⇒ window escalates.
    connector.attempts[1]?.handlers.reportOpen()
    connector.attempts[1]?.handlers.reportClosed(new Error('flap'))
    expect(scheduler.delays).toEqual([200]) // escalated, NOT back to 100
  })

  it('does not open a connection when a status listener stops the loop during "connecting"', () => {
    // Finding: onStatus is emitted synchronously before connect(); a listener that calls
    // close()→stop() during 'connecting' must not leave a live socket that no stop() can close.
    const { loop, connector } = makeLoop({
      onStatus: (status, self) => {
        if (status === 'connecting') self.stop()
      },
    })
    loop.start()
    // No live (unclosed) handle may survive: connect() must not have run, or its handle closed.
    expect(connector.attempts.filter((a) => !a.closed)).toHaveLength(0)
    loop.stop() // a later stop() is a no-op and must not resurrect anything
    expect(connector.attempts.filter((a) => !a.closed)).toHaveLength(0)
  })

  it('arms no reconnect timer (nor double-connects on reopen) when a listener stops during "reconnecting"', () => {
    // Finding: onStatus('reconnecting') is emitted before the timer is armed; a listener that
    // stops the loop then must not leave a dangling timer that fires against a reopened loop.
    let armed = false
    const { loop, connector, scheduler } = makeLoop({
      onStatus: (status, self) => {
        if (status === 'reconnecting' && armed) self.stop()
      },
    })
    loop.start()
    armed = true
    connector.attempts[0]?.handlers.reportClosed(new Error('drop')) // ⇒ reconnecting ⇒ stop()
    expect(scheduler.pending).toBe(0) // the re-entrant stop cancelled everything
    // Reopen; a stale reconnect timer (if one leaked) would fire a SECOND concurrent attempt.
    loop.start()
    scheduler.flush()
    expect(connector.attempts).toHaveLength(2) // the initial + the single reopened attempt
  })

  it('applies a retry hint as a floor on the reconnect delay', () => {
    const backoff = new Backoff({ initialDelay: 100, factor: 2, random: () => 0 }) // window→0
    const { loop, connector, scheduler } = makeLoop({ backoff, retryHint: () => 2500 })
    loop.start()
    connector.attempts[0]?.handlers.reportClosed(new Error('x'))
    expect(scheduler.delays).toEqual([2500])
  })

  it('stop() closes the live connection, cancels the timer and goes to closed', () => {
    const { loop, connector, scheduler, statuses } = makeLoop({})
    loop.start()
    loop.stop()
    expect(connector.attempts[0]?.closed).toBe(true)
    expect(scheduler.pending).toBe(0)
    expect(statuses.at(-1)).toBe('closed')
  })

  it('ignores callbacks from a superseded attempt after stop()', () => {
    const { loop, connector, scheduler, statuses } = makeLoop({})
    loop.start()
    loop.stop()
    // Late callbacks from the dead attempt must be no-ops (no zombie reconnect/status).
    connector.attempts[0]?.handlers.reportOpen()
    connector.attempts[0]?.handlers.reportClosed(new Error('late'))
    expect(scheduler.pending).toBe(0)
    expect(statuses.filter((s) => s === 'open')).toHaveLength(0)
  })

  it('ignores a second reportClosed from the same attempt (single reconnect scheduled)', () => {
    const { loop, connector, scheduler } = makeLoop({})
    loop.start()
    connector.attempts[0]?.handlers.reportClosed(new Error('once'))
    connector.attempts[0]?.handlers.reportClosed(new Error('twice'))
    expect(scheduler.pending).toBe(1)
  })

  it('does not reconnect if stop() runs while a reconnect timer is pending', () => {
    const { loop, connector, scheduler } = makeLoop({})
    loop.start()
    connector.attempts[0]?.handlers.reportClosed(new Error('drop'))
    expect(scheduler.pending).toBe(1)
    loop.stop()
    expect(scheduler.pending).toBe(0)
    scheduler.flush()
    expect(connector.attempts).toHaveLength(1)
  })

  it('closes a handle the connector reported closed synchronously (contract guard)', () => {
    // A misbehaving connector that reports closure during the connect() call itself.
    let syncHandleClosed = false
    const scheduler = new FakeScheduler()
    const loop = new ReconnectLoop({
      connect: (handlers) => {
        handlers.reportClosed(new Error('sync'))
        return {
          close: () => {
            syncHandleClosed = true
          },
        }
      },
      backoff: new Backoff({ random: () => 0 }),
      scheduler,
      onStatus: vi.fn(),
      onError: vi.fn(),
    })
    loop.start()
    expect(syncHandleClosed).toBe(true)
  })
})

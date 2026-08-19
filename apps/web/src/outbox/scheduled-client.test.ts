/**
 * Reading and cancelling scheduled sends (M5.4, FR-CMP-11).
 *
 * The assertion that carries this file is the "too late" one: a submission whose moment has passed
 * answers `cannotUnsend`, and that has to surface as "already sent" rather than as an error. The
 * message went out, which is what the user asked for when they scheduled it.
 */

import type { JmapClient } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { makeScheduledClient } from './scheduled-client'

const ACC = 'a'

type Call = [name: string, args: Record<string, unknown>, id: string]

/** A fake of the `call()` seam, matching the house pattern for app-side JMAP tests. */
function fakeClient(setResponse: Record<string, unknown>): { client: JmapClient; calls: Call[] } {
  const calls: Call[] = []
  const client = {
    async call(invocations: Call[]) {
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        responses.push([name, { accountId: ACC, ...setResponse }, id])
      }
      return {
        get<T>(id: string): T {
          const found = responses.find(([, , callId]) => callId === id)
          if (found === undefined) throw new Error(`no response for ${id}`)
          return found[1] as T
        },
      }
    },
  } as unknown as JmapClient
  return { client, calls }
}

describe('cancel', () => {
  it('writes the ONLY undoStatus a client may set', () => {
    // `pending` and `final` are server-set (RFC 8621 §7.1); writing either is a rejected update.
    const { client, calls } = fakeClient({ updated: { s1: null }, notUpdated: null })
    void makeScheduledClient(client, ACC).cancel('s1')
    // The call is recorded synchronously by the fake.
    expect(calls[0]?.[0]).toBe('EmailSubmission/set')
    expect(calls[0]?.[1]).toEqual({ accountId: ACC, update: { s1: { undoStatus: 'canceled' } } })
  })

  it('reports success when the server accepted the cancel', async () => {
    const { client } = fakeClient({ updated: { s1: null }, notUpdated: null })
    expect(await makeScheduledClient(client, ACC).cancel('s1')).toBe(true)
  })

  it('reports "too late" rather than throwing when the message had already gone', async () => {
    const { client } = fakeClient({
      updated: null,
      notUpdated: { s1: { type: 'cannotUnsend' } },
    })
    expect(await makeScheduledClient(client, ACC).cancel('s1')).toBe(false)
  })

  it('does not claim success when the server acknowledged nothing', async () => {
    const { client } = fakeClient({ updated: {}, notUpdated: null })
    expect(await makeScheduledClient(client, ACC).cancel('s1')).toBe(false)
  })
})

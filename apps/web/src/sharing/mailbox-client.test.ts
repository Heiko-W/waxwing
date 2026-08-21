/**
 * The wire shape of a mail-folder share (S-3).
 *
 * The first test here is the one that matters, and it is not about types: `Mailbox/get` does not
 * return `shareWith` unless it is asked for. Measured against Stalwart v0.16.18 — a property-less
 * get answers with eleven keys and `shareWith` is not among them. A dialog that read the grant map
 * off a replica row (built by `sync/engine/port.ts`, which sends no `properties`) would read
 * `undefined`, show "Only you", and write `{}` back over three people's access on the first edit.
 */

import type { Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { mailboxRoles } from './mailbox'
import { MailboxShareError, makeMailboxSharingClient } from './mailbox-client'

interface Recorder {
  readonly client: JmapClient
  readonly calls: Invocation[][]
}

function recorder(respond: (name: string, args: Record<string, unknown>) => unknown): Recorder {
  const calls: Invocation[][] = []
  const client = {
    call: vi.fn(async (invocations: Invocation[]) => {
      calls.push(invocations)
      const responses: Invocation[] = invocations.map(([name, args, callId]) => [
        name,
        respond(name, (args ?? {}) as Record<string, unknown>) as never,
        callId,
      ])
      return new MethodResponses(responses, 's0', undefined)
    }),
  } as unknown as JmapClient
  return { client, calls }
}

describe('load', () => {
  it('NAMES shareWith in `properties` — it does not arrive otherwise', () => {
    const { client, calls } = recorder(() => ({ list: [{ id: 'a', shareWith: {} }], notFound: [] }))
    void makeMailboxSharingClient(client, 'b').load('a')
    const args = calls[0]?.[0]?.[1] as { properties: string[]; ids: string[] }
    expect(args.properties).toContain('shareWith')
    expect(args.ids).toEqual(['a'])
  })

  it('answers `{}` for a folder nobody has access to', async () => {
    const { client } = recorder(() => ({ list: [{ id: 'a' }], notFound: [] }))
    expect(await makeMailboxSharingClient(client, 'b').load('a')).toEqual({})
  })

  it('answers `{}` rather than throwing when the folder is not there at all', async () => {
    const { client } = recorder(() => ({ list: [], notFound: ['a'] }))
    expect(await makeMailboxSharingClient(client, 'b').load('a')).toEqual({})
  })

  it('returns the grant map the server holds', async () => {
    const viewer = mailboxRoles.rightsFor('viewer')
    const { client } = recorder(() => ({
      list: [{ id: 'a', shareWith: { 'p-bob': viewer } }],
      notFound: [],
    }))
    expect(await makeMailboxSharingClient(client, 'b').load('a')).toEqual({ 'p-bob': viewer })
  })
})

describe('setShareWith', () => {
  it('sends ONE Mailbox/set update carrying the whole map', async () => {
    const { client, calls } = recorder(() => ({ updated: { a: null } }))
    const grant = { 'p-bob': mailboxRoles.rightsFor('editor') }
    await makeMailboxSharingClient(client, 'b').setShareWith('a', grant)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]?.[0]).toBe('Mailbox/set')
    expect((calls[0]?.[0]?.[1] as { update: unknown }).update).toEqual({ a: { shareWith: grant } })
  })

  it('does NOT send the mail:share URN', async () => {
    /*
     * Measured twice over. Both the get and the set succeed on v0.16.18 with a `using` of core +
     * mail alone — and an unrecognised `using` entry answers the WHOLE request with HTTP 400
     * `notRequest`, taking every other call in the batch with it. Sending a URN "just in case" is
     * therefore not free; it is the difference between working and not working against a server
     * without the extension.
     */
    const { client } = recorder(() => ({ updated: { a: null } }))
    await makeMailboxSharingClient(client, 'b').setShareWith('a', {})
    const options = (client.call as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]
    expect(options).toBeUndefined()
  })

  it('reports a per-object refusal as an error the UI can name', async () => {
    // The one that will really happen: an unknown rights key. Measured —
    // `invalidProperties: 'Invalid permission "mayFlibber"'`, per object, batch intact.
    const { client } = recorder(() => ({
      notUpdated: { a: { type: 'invalidProperties', description: 'Invalid permission "x".' } },
    }))
    await expect(makeMailboxSharingClient(client, 'b').setShareWith('a', {})).rejects.toThrow(
      MailboxShareError,
    )
  })

  it('classifies a refusal so the message can differ from "something went wrong"', async () => {
    const { client } = recorder(() => ({ notUpdated: { a: { type: 'forbidden' } } }))
    await makeMailboxSharingClient(client, 'b')
      .setShareWith('a', {})
      .then(
        () => expect.unreachable('should have thrown'),
        (error: MailboxShareError) => expect(error.failure).toBe('forbidden'),
      )
  })

  it('resolves quietly when the server accepted it', async () => {
    const { client } = recorder(() => ({ updated: { a: null } }))
    await expect(
      makeMailboxSharingClient(client, 'b').setShareWith('a', {}),
    ).resolves.toBeUndefined()
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import type { EmailBodyPart } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putEmailBody, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { useInlineImages } from './useInlineImages'
import { useMessageBody } from './useMessageBody'

/**
 * Opening a message with inline images, once (R-46).
 *
 * `useEmailBody` (a liveQuery read) and `fetchBody` run at the same time, and `fetchBody` used to
 * write an LRU stamp onto the very row the liveQuery is watching. Its `readwrite` transaction can
 * only commit after the `readonly` one, so the row was emitted TWICE — the second time
 * byte-identical with a fresh object identity. This hook keyed its pipeline on that identity: it
 * cancelled its own run, revoked whatever object URLs it had already made and read every `cid:` blob
 * out of IndexedDB again.
 *
 * Fixed on both sides, and both are pinned here: the hook keys on CONTENT, and a duplicate emission
 * (which a liveQuery is free to produce for any reason) no longer restarts anything.
 */
const fetchBlob = vi.fn()
vi.mock('./use-blob', () => ({ useBlobFetcher: () => fetchBlob }))

let db: ReplicaDb

function part(over: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: null,
    blobId: null,
    size: 0,
    headers: [],
    name: null,
    type: 'text/plain',
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    subParts: null,
    ...over,
  }
}

async function seedBody(images: number): Promise<void> {
  const cids = Array.from({ length: images }, (_, i) => `c${String(i)}`)
  await putEmailBody(db, {
    accountId: 'a',
    id: 'e1',
    bodyValues: {
      h: {
        value: cids.map((cid) => `<img src="cid:${cid}" alt="">`).join(''),
        isEncodingProblem: false,
        isTruncated: false,
      },
    },
    bodyStructure: part({
      type: 'multipart/related',
      subParts: [
        part({ partId: 'h', type: 'text/html' }),
        ...cids.map((cid, i) =>
          part({ cid, blobId: `b${String(i)}`, type: 'image/png', disposition: 'inline' }),
        ),
      ],
    }),
    textBody: [],
    htmlBody: [part({ partId: 'h', type: 'text/html' })],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
  } as unknown as Parameters<typeof putEmailBody>[1])
}

/** The reading pane's two hooks, side by side, exactly as `MessageView` mounts them. */
function Probe() {
  const { body, loading } = useMessageBody('e1')
  const { ready } = useInlineImages('a', body)
  return <span data-testid="ready">{String(!loading && ready)}</span>
}

let revoke: ReturnType<typeof vi.fn>
let restoreUrl: () => void

beforeEach(() => {
  db = freshDb()
  fetchBlob.mockReset()
  fetchBlob.mockImplementation(async () => new Blob(['img'], { type: 'image/png' }))
  revoke = vi.fn()
  const urlAny = URL as unknown as Record<string, unknown>
  const saved = [urlAny.createObjectURL, urlAny.revokeObjectURL]
  urlAny.createObjectURL = vi.fn(() => 'blob:probe')
  urlAny.revokeObjectURL = revoke
  restoreUrl = () => {
    urlAny.createObjectURL = saved[0]
    urlAny.revokeObjectURL = saved[1]
  }
})

afterEach(async () => {
  restoreUrl()
  setActiveEngine(null)
  await db.delete()
})

/** Give a late second liveQuery emission time to arrive (or not to). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120))

describe('useInlineImages', () => {
  it('reads each inline blob once when the body is already cached', async () => {
    // The touching `fetchBody` of the shipping engine, reproduced: read the row, write it back. The
    // hook must not care that the liveQuery answers twice.
    const fetchBody = vi.fn(async (id: string) => {
      await db.emailBodies.update(['a', id], { lastAccessedAt: 2 })
      return null
    })
    setActiveEngine({ fetchBody } as unknown as Parameters<typeof setActiveEngine>[0])
    await seedBody(3)

    render(
      <ReplicaProvider accountId="a" db={db}>
        <Probe />
      </ReplicaProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    await settle()

    expect(fetchBlob).toHaveBeenCalledTimes(3)
    // Nothing was made and then thrown away: a revoke here is a run that was abandoned.
    expect(revoke).not.toHaveBeenCalled()
  })

  it('does not restart when the same body is emitted again', async () => {
    // A liveQuery may emit an equal row for any number of reasons; the LRU touch was only the one
    // that did it on every open. Written against the emission itself so the hook stays correct
    // whatever the engine does next.
    setActiveEngine({ fetchBody: vi.fn(async () => null) } as unknown as Parameters<
      typeof setActiveEngine
    >[0])
    await seedBody(2)

    render(
      <ReplicaProvider accountId="a" db={db}>
        <Probe />
      </ReplicaProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    expect(fetchBlob).toHaveBeenCalledTimes(2)

    await db.emailBodies.update(['a', 'e1'], { lastAccessedAt: 99 })
    await settle()

    expect(fetchBlob).toHaveBeenCalledTimes(2)
    expect(revoke).not.toHaveBeenCalled()
    expect(screen.getByTestId('ready')).toHaveTextContent('true')
  })

  it('DOES restart when the inline parts really change', async () => {
    // The counter-control: a fix that simply never re-ran would pass everything above.
    setActiveEngine({ fetchBody: vi.fn(async () => null) } as unknown as Parameters<
      typeof setActiveEngine
    >[0])
    await seedBody(1)

    render(
      <ReplicaProvider accountId="a" db={db}>
        <Probe />
      </ReplicaProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    expect(fetchBlob).toHaveBeenCalledTimes(1)

    await seedBody(2)
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(3))
  })
})

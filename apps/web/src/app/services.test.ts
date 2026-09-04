import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultServices } from './services'

/**
 * The PRODUCTION service seam, which nothing tested before this file existed.
 *
 * Everything above it injects fakes — that is what the seam is for — so the one implementation
 * that actually ships had no coverage at all, and a defect in it was invisible to 5000 tests. The
 * probe is where that mattered: it answered "no server here" to a request nobody replied to, and
 * boot step C read that as the cue to open the manual server-entry step. Offline, where nothing
 * can reply, that put the most technical screen this app has in front of the reader least able to
 * use it (FR-OFF-01).
 */

const ORIGIN = 'https://mail.example.com'

afterEach(() => {
  vi.unstubAllGlobals()
})

function respondWith(status: number): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(null, { status })
  })
  return { calls }
}

describe('defaultServices.probe', () => {
  it('asks the well-known path, without a cache in between', async () => {
    const { calls } = respondWith(200)
    await defaultServices.probe(ORIGIN)
    expect(calls).toEqual(['https://mail.example.com/.well-known/jmap'])
  })

  it.each([200, 401, 403, 500, 503])('reads %i as a server that is there', async (status) => {
    // Stalwart answers an unauthenticated probe with 200 and an anonymous session; 401/403 are
    // just as much a server. `connect()` stays the real arbiter, so this only has to be right
    // about the ONE thing it decides: whether to offer this origin at all.
    respondWith(status)
    expect(await defaultServices.probe(ORIGIN)).toBe('present')
  })

  it.each([404, 410])('reads %i as a measured absence', async (status) => {
    respondWith(status)
    expect(await defaultServices.probe(ORIGIN)).toBe('absent')
  })

  it('THE ONE: a request nobody answered is `unknown`, not `absent`', async () => {
    // A failed `fetch` — offline, DNS gone, connection refused. The server did not say "no";
    // nobody said anything. Reporting that as absence is how a device with no network came to be
    // asked to type in a mail server, and it is the distinction boot step C now acts on.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await defaultServices.probe(ORIGIN)).toBe('unknown')
  })

  it('an origin that cannot even be parsed is `unknown` too', async () => {
    // `new URL()` throws before any request happens. Same answer for the same reason: nothing was
    // measured, so nothing may be claimed.
    respondWith(200)
    expect(await defaultServices.probe('not a url')).toBe('unknown')
  })
})

import { renderHook, waitFor } from '@testing-library/react'
import { JmapError, JmapHttpError, JmapProblemError } from '@waxwing/jmap'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { type EmailRow, toEmailRow } from '../sync'
import { email } from '../sync/test-utils'
import {
  classifySourceError,
  FALLBACK_FILENAME,
  MAX_SOURCE_TEXT_BYTES,
  sourceFilename,
  useMessageSource,
} from './use-message-source'
// The module's own text, for the structural guard at the bottom of this file. (`?raw`, not
// `readFileSync`: under the jsdom project `import.meta.url` is an http:// URL, not a file path.)
import moduleSource from './use-message-source.ts?raw'

describe('sourceFilename', () => {
  it('turns a plain subject into <subject>.eml', () => {
    expect(sourceFilename('Quarterly report')).toBe('Quarterly report.eml')
  })

  it('strips the path/Windows-reserved characters', () => {
    expect(sourceFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij.eml')
  })

  it('strips control characters', () => {
    expect(sourceFilename('re\u0000po\u001Frt\u007F')).toBe('report.eml')
  })

  it('defuses a traversal attempt: every `..` and any leading dot go', () => {
    // Both halves matter. `/` is already gone by the time this runs, so what is left to neutralize is
    // the `..` itself — and a leading dot, which would otherwise write a hidden file.
    expect(sourceFilename('../../etc/passwd')).toBe('etcpasswd.eml')
    expect(sourceFilename('..\\..\\windows\\system32')).toBe('windowssystem32.eml')
    expect(sourceFilename('.bashrc')).toBe('bashrc.eml')
    expect(sourceFilename('....')).toBe(FALLBACK_FILENAME)
  })

  it('clamps a very long subject', () => {
    const name = sourceFilename('x'.repeat(300))
    expect(name).toBe(`${'x'.repeat(100)}.eml`)
    expect(name.length).toBe(104)
  })

  it('does not leave a trailing dot or space in front of the extension', () => {
    expect(sourceFilename('Report ')).toBe('Report.eml')
    expect(sourceFilename('Report.')).toBe('Report.eml')
    // A clamp that lands mid-space must not produce `xxx .eml` either.
    expect(sourceFilename(`${'x'.repeat(99)} tail`)).toBe(`${'x'.repeat(99)}.eml`)
  })

  it('falls back to message.eml when nothing usable survives', () => {
    expect(sourceFilename(null)).toBe(FALLBACK_FILENAME)
    expect(sourceFilename('')).toBe(FALLBACK_FILENAME)
    expect(sourceFilename('   ')).toBe(FALLBACK_FILENAME)
    expect(sourceFilename('///')).toBe(FALLBACK_FILENAME)
  })
})

describe('classifySourceError', () => {
  it('maps a network TypeError to offline', () => {
    expect(classifySourceError(new TypeError('Failed to fetch'))).toBe('offline')
  })

  it('maps a 404 to notFound', () => {
    expect(classifySourceError(new JmapHttpError(404, ''))).toBe('notFound')
    expect(
      classifySourceError(new JmapProblemError({ type: 'about:blank', status: 404 }, 404)),
    ).toBe('notFound')
  })

  it('maps any other HTTP status to failed', () => {
    expect(classifySourceError(new JmapHttpError(500, ''))).toBe('failed')
    expect(classifySourceError(new JmapHttpError(401, ''))).toBe('failed')
  })

  it('maps anything unrecognized to failed', () => {
    expect(classifySourceError(new JmapError('boom'))).toBe('failed')
    expect(classifySourceError('nope')).toBe('failed')
  })
})

const ROW: EmailRow = toEmailRow('a', email('e1', { subject: 'Hi', blobId: 'blob-1' }))

function wrapperFor(download: SessionDownload): (props: { children: ReactNode }) => ReactNode {
  const session = {
    getClient: () => (download === null ? null : { download }),
  } as unknown as SessionContextValue
  return ({ children }) => createElement(SessionContext.Provider, { value: session }, children)
}

type SessionDownload =
  | null
  | ((accountId: string, blobId: string, type: string, name: string) => Promise<Uint8Array>)

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('useMessageSource', () => {
  it('does not download anything while inactive — opening a message must not pull its source', () => {
    const download = vi.fn(async () => bytesOf('From: a@b.test\r\n\r\nhi'))
    const { result } = renderHook(() => useMessageSource('a', ROW, false), {
      wrapper: wrapperFor(download),
    })
    expect(download).not.toHaveBeenCalled()
    expect(result.current.text).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('downloads the message blob as message/rfc822 once active', async () => {
    const download = vi.fn(async () => bytesOf('From: a@b.test\r\n\r\nhi'))
    const { result } = renderHook(() => useMessageSource('a', ROW, true), {
      wrapper: wrapperFor(download),
    })
    await waitFor(() => expect(result.current.text).not.toBeNull())
    expect(download).toHaveBeenCalledWith(
      'a',
      'blob-1',
      'message/rfc822',
      'Hi.eml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(result.current.text).toBe('From: a@b.test\r\n\r\nhi')
    expect(result.current.truncated).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('ABORTS the download when the dialog closes, rather than letting it stream on', async () => {
    // Without the signal a closed dialog leaves the whole message buffering into memory nobody will
    // read — close/reopen a 50 MB .eml a few times and the discards pile up concurrently.
    let seen: AbortSignal | undefined
    const download = vi.fn(async (_a, _b, _c, _d, options?: { signal?: AbortSignal }) => {
      seen = options?.signal
      return bytesOf('x')
    })
    const { result, unmount } = renderHook(() => useMessageSource('a', ROW, true), {
      wrapper: wrapperFor(download as never),
    })
    await waitFor(() => expect(result.current.text).not.toBeNull())
    expect(seen?.aborted).toBe(false)
    unmount()
    expect(seen?.aborted).toBe(true)
  })

  it('shows only the head of an oversized message but SAVES every byte of it', async () => {
    // A 50 MB message must never be laid out in a <pre>; the clamp is a rendering limit, and `bytes`
    // stays the real size so the UI can say what is being withheld.
    //
    // The save assertion is the load-bearing one: without it, clamping the SAVE too (one `subarray`)
    // would silently write a corrupt .eml for every message over 1 MB and leave the suite green.
    const size = MAX_SOURCE_TEXT_BYTES + 500
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const download = vi.fn(async () => new Uint8Array(size).fill(0x61))
      const { result } = renderHook(() => useMessageSource('a', ROW, true), {
        wrapper: wrapperFor(download),
      })
      await waitFor(() => expect(result.current.text).not.toBeNull())
      expect(result.current.truncated).toBe(true)
      expect(result.current.text).toHaveLength(MAX_SOURCE_TEXT_BYTES)
      expect(result.current.bytes).toBe(size)

      result.current.save()
      expect(createObjectURL.mock.calls[0]?.[0].size).toBe(size) // the WHOLE message, not the head
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('decodes non-UTF-8 bytes without throwing (a message need not be UTF-8)', async () => {
    const download = vi.fn(async () => new Uint8Array([0x68, 0x69, 0xff, 0xfe]))
    const { result } = renderHook(() => useMessageSource('a', ROW, true), {
      wrapper: wrapperFor(download),
    })
    await waitFor(() => expect(result.current.text).not.toBeNull())
    expect(result.current.text).toContain('hi')
  })

  it('reports offline when there is no client', async () => {
    const { result } = renderHook(() => useMessageSource('a', ROW, true), {
      wrapper: wrapperFor(null),
    })
    await waitFor(() => expect(result.current.error).toBe('offline'))
    expect(result.current.loading).toBe(false)
  })

  it('maps a failed download onto the error state', async () => {
    const download = vi.fn(async () => {
      throw new JmapHttpError(404, '')
    })
    const { result } = renderHook(() => useMessageSource('a', ROW, true), {
      wrapper: wrapperFor(download),
    })
    await waitFor(() => expect(result.current.error).toBe('notFound'))
    expect(result.current.text).toBeNull()
  })

  /**
   * The revoke must NOT be synchronous. Activating an `<a download>` only QUEUES the fetch (HTML,
   * "download the hyperlink"); revoking first can make the blob URL unresolvable and the saved file
   * empty. Chromium resolves it during click dispatch and so survives a synchronous revoke — which
   * is exactly why this needs a test rather than a manual check in one browser.
   */
  it('save() clicks a download anchor and revokes the object URL only AFTER the click task', async () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const clicked: HTMLAnchorElement[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
      // The browser resolves the blob URL while handling the click — so it must still be live here.
      expect(revokeObjectURL).not.toHaveBeenCalled()
    })
    try {
      const download = vi.fn(async () => bytesOf('raw'))
      const { result } = renderHook(() => useMessageSource('a', ROW, true), {
        wrapper: wrapperFor(download),
      })
      await vi.waitFor(() => expect(result.current.text).not.toBeNull())
      result.current.save()
      expect(clicked[0]?.download).toBe('Hi.eml')
      expect(clicked[0]?.getAttribute('href')).toBe('blob:fake')
      // Still live right after save() returns…
      expect(revokeObjectURL).not.toHaveBeenCalled()
      // …and released once the queued task runs, so nothing leaks either.
      vi.runAllTimers()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('save() is a no-op before the bytes arrive', () => {
    const createObjectURL = vi.fn(() => 'blob:fake')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    try {
      const { result } = renderHook(() => useMessageSource('a', ROW, false), {
        wrapper: wrapperFor(vi.fn(async () => bytesOf('raw'))),
      })
      result.current.save()
      expect(createObjectURL).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the blob-cache trap (F4)', () => {
  it('never routes the .eml through use-blob / blob-cache', () => {
    // A STRUCTURAL guard, because no behavioural test can see this. `classifyBlobOrphans`
    // (sync/engine/eviction.ts) deletes any blobsMeta row with no owning body, with no budget check —
    // and `collectBodyBlobIds` (sync/db.ts) walks bodyStructure/textBody/htmlBody/attachments, which
    // never contain the Email's OWN blobId. A cached .eml would be written and then reaped as an
    // orphan on the next maintenance pass. The download must stay direct.
    const specifiers = [...moduleSource.matchAll(/^import[\s\S]*?from '([^']+)'$/gm)].map(
      (match) => match[1],
    )
    expect(specifiers.length).toBeGreaterThan(0) // the scan found imports at all
    expect(specifiers).not.toContain('./use-blob')
    expect(specifiers.some((specifier) => specifier?.includes('blob-cache'))).toBe(false)
    expect(specifiers.some((specifier) => specifier?.includes('use-blob'))).toBe(false)
    // Named re-exports of the same machinery through the `../sync` barrel.
    expect(moduleSource).not.toMatch(/\bgetOrFetchBlob\b|\buseBlobFetcher\b/)
  })
})

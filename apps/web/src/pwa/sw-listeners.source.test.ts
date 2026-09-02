import { describe, expect, it } from 'vitest'
import { readAppFile } from '../ui/css-sources'

/**
 * `pwa-options.ts`'s header against the worker it configures (R-101).
 *
 * That header is where a reader finds out which events `sw.ts` actually handles — and for a whole
 * milestone it said the wrong thing. It claimed `push` and `pushsubscriptionchange` were "still
 * absent" and the client half an "open owner decision", both of which stopped being true with
 * ADR-017 in M4.0. Nothing failed; someone looking for the push handling simply went to the wrong
 * file, which is what a stale comment costs.
 *
 * A comment cannot be unit-tested, but the CLAIM in it can. `sw.ts` compiles in its own program
 * (`tsconfig.sw.json`) and may hold no test of its own — see its header — so this reads the source,
 * the same technique `list-keys.source.test.ts` uses to keep two halves of one statement in step.
 */
const worker = readAppFile('src/sw/sw.ts').text

describe('the worker listeners `pwa-options.ts` describes', () => {
  it.each(['push', 'notificationclick'])('registers a `%s` listener', (event) => {
    expect(worker).toContain(`self.addEventListener('${event}'`)
  })

  /**
   * Absent by decision, not by omission: telling the server about a rotated endpoint is a JMAP
   * write, and the worker holds no token by construction (ADR-017, owner decision D6a). A handler
   * could only re-subscribe in the browser, which the page's own pass does on the next start.
   * Adding one fails this test, and the header has to be rewritten with it.
   */
  it('registers no `pushsubscriptionchange` listener', () => {
    expect(worker).not.toContain('pushsubscriptionchange')
  })
})

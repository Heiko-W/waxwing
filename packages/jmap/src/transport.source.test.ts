/**
 * R-97. `postApi`'s docblock had drifted away from `postApi`: the W-16 commit inserted
 * `DEFAULT_REQUEST_TIMEOUT_MS` and `withDeadline` between the two, leaving two `/** … *\/` blocks in
 * a row of which TypeScript and every IDE attach only the NEAREST to a symbol. The reasoning for
 * narrowing the response instead of casting it — the class R-92 and R-95 both point at — was
 * therefore invisible on hover at the one function it is about, and the constant appeared to be
 * documented as an HTTP POST.
 *
 * A source test, because the defect is one of PLACEMENT and nothing at runtime can see it. It is
 * cheap and specific: the block immediately above the function must be the one about the function.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'transport.ts'),
  'utf8',
)

describe('transport.ts documentation placement', () => {
  it('puts postApi’s docblock directly above postApi', () => {
    const index = SOURCE.indexOf('export async function postApi(')
    expect(index).toBeGreaterThan(-1)
    const before = SOURCE.slice(0, index)
    const lastBlock = before.slice(before.lastIndexOf('/**'))
    expect(lastBlock).toContain('POSTs a JMAP')
    expect(lastBlock).toContain('narrowed rather than cast')
    // …and nothing between that block and the function but its closing delimiter.
    expect(before.slice(before.lastIndexOf('*/') + 2).trim()).toBe('')
  })

  it('leaves the deadline constant its own docblock', () => {
    const index = SOURCE.indexOf('export const DEFAULT_REQUEST_TIMEOUT_MS')
    expect(index).toBeGreaterThan(-1)
    const before = SOURCE.slice(0, index)
    const lastBlock = before.slice(before.lastIndexOf('/**'))
    expect(lastBlock).toContain('How long one JMAP request may take')
    expect(lastBlock).not.toContain('POSTs a JMAP')
  })
})

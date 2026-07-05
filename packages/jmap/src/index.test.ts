import { describe, expect, it } from 'vitest'
import { PACKAGE } from './index'

// Harness smoke test: proves the node/unit Vitest project collects and runs against
// packages/*. It is intentionally NOT behavioral coverage — index.ts is scaffold-only
// (it just re-exports PACKAGE). Real coverage (session parsing, request chunking,
// back-references, error mapping) arrives with SP.1, which should REPLACE this with a
// behavioral assertion so the node project has at least one meaningful test — see
// docs/implementation-plan.md.
describe('@waxwing/jmap harness smoke', () => {
  it('collects and runs the node/unit project (scaffold — real tests land in SP.1)', () => {
    expect(PACKAGE).toBe('@waxwing/jmap')
  })
})

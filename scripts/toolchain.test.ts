/**
 * The Node version this repository declares, in the three places that have to agree (R-107, R-112).
 *
 * `.nvmrc` pinned 24, README said 24 "and not just a recommendation", `scripts/ci.mjs` refused to
 * run on anything else — and `engines.node` said `">=22"`, so `pnpm install` on node 22 or 26
 * succeeded and the contradiction only surfaced two minutes later, from `pnpm verify`. The install
 * gate that was supposed to prevent that (`engine-strict=true` in `.npmrc`) had never worked:
 * pnpm 11 reads its settings from `pnpm-workspace.yaml` and ignores `.npmrc` for this key, which
 * makes the failure of the range the only thing that was ever holding.
 *
 * Both halves are checked here, because either one alone is inert: a narrow range with no
 * `engineStrict` is a warning, and `engineStrict` with a wide range stops nothing.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), 'utf8')

/** Every workspace manifest, so a new package cannot quietly reintroduce a wider range. */
const MANIFESTS = [
  'package.json',
  'apps/web/package.json',
  'e2e/package.json',
  'packages/jmap/package.json',
  'packages/jscontact/package.json',
  'packages/mail-html/package.json',
] as const

interface Manifest {
  readonly engines?: { readonly node?: string }
}

const NVMRC_MAJOR = read('.nvmrc').trim()

describe('the declared Node version', () => {
  it('pins a single major in `.nvmrc`', () => {
    expect(NVMRC_MAJOR).toMatch(/^\d+$/)
  })

  /**
   * A manifest without `engines.node` is fine — it inherits the root's install gate. One that has
   * the field has to name the same major, in a range that excludes the next one: `">=24"` would
   * let node 26 install again, which is the whole of R-107.
   */
  it.each(MANIFESTS)('gives %s a range that admits only that major', (manifest) => {
    const declared = (JSON.parse(read(manifest)) as Manifest).engines?.node
    if (declared === undefined) return
    expect(declared).toBe(`>=${NVMRC_MAJOR} <${Number(NVMRC_MAJOR) + 1}`)
  })

  /**
   * Without this, the range above is advisory: pnpm prints one `[WARN]` line and installs anyway.
   * Measured with pnpm 11.1.1 against an unsatisfiable manifest — `engineStrict: true` here gives
   * `ERR_PNPM_UNSUPPORTED_ENGINE` and exit 1, the same setting in `.npmrc` gives exit 0.
   */
  it('makes pnpm enforce it, from the file pnpm 11 actually reads', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/^engineStrict: true$/m)
  })

  /**
   * `.npmrc` is where this setting was, doing nothing. It may come back for a setting npm-the-CLI
   * reads, but not for a pnpm one — that is the trap `allowBuilds` and `overrides` already document
   * in `pnpm-workspace.yaml`.
   */
  it('keeps no pnpm setting in `.npmrc`', () => {
    let npmrc: string
    try {
      npmrc = read('.npmrc')
    } catch {
      return // Deleted with R-112, which is the expected state.
    }
    expect(npmrc).not.toMatch(/engine[-_]?strict/i)
  })
})

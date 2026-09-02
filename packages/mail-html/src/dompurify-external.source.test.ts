/**
 * R-106. DOMPurify was shipped TWICE: once inlined into this package's `dist` (tsup
 * `noExternal: ['dompurify']`, justified as "so the published package is self-contained") and
 * therefore into apps/web's eager entry chunk, and once more in the lazy composer chunk, which
 * imports `dompurify` directly for its own permissive editor instance. Roughly 10 KB gzip of
 * duplicate sanitizer, and — worse than the bytes — two places that would need the fixed version
 * on the next DOMPurify advisory. The justification never held: this package is `private: true`
 * and is not published.
 *
 * A build-output test, because the defect only exists in the emitted artefact: the sources are
 * identical either way, and `pnpm size` cannot see it (the initial budget does not count the lazy
 * composer chunk). `dist/` is a prerequisite of the whole suite anyway — apps/web resolves both
 * the types and the runtime of `@waxwing/mail-html` from it, which is why `pnpm verify` runs
 * `build:libs` before `test`.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${path} is missing — run \`pnpm build:libs\` (\`pnpm verify\` does).`)
  }
}

const DIST = read(resolve(PACKAGE_ROOT, 'dist/index.js'))

// Identifiers that appear only INSIDE DOMPurify's own source, so their presence in this package's
// dist means the library was copied in rather than imported.
const DOMPURIFY_INTERNALS = ['SAFE_FOR_XML', 'ALLOWED_NAMESPACES', 'removeAllHooks']

describe('@waxwing/mail-html keeps DOMPurify external', () => {
  it('imports the sanitizer instead of inlining it', () => {
    expect(DIST).toMatch(/import DOMPurify from ['"]dompurify['"]/)
  })

  it.each(DOMPURIFY_INTERNALS)('carries no copy of DOMPurify (%s)', (identifier) => {
    expect(DIST).not.toContain(identifier)
  })

  /**
   * The dedupe that the external import buys only holds while both importers land on ONE resolved
   * copy. apps/web declares `dompurify` for the composer's isolated instance; two diverging ranges
   * would let pnpm install two versions and quietly restore the duplicate — in the bundle and in
   * the advisory surface.
   */
  it('declares the same DOMPurify range as apps/web', () => {
    const range = (manifest: string) =>
      JSON.parse(read(resolve(REPO_ROOT, manifest))).dependencies.dompurify as string
    expect(range('packages/mail-html/package.json')).toBe(range('apps/web/package.json'))
  })
})

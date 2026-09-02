/**
 * `SECURITY.md`'s sandbox claim against the attribute `frame.ts` actually sets (R-102).
 *
 * The threat-model section — the first thing an auditor reads — said the mail frame is mounted
 * `sandbox="allow-same-origin"` **and nothing else**, naming `allow-popups` among the tokens it
 * does not carry. ADR-029 added exactly that token, plus `allow-popups-to-escape-sandbox`, so that
 * an ordinary link opens natively on WebKit (which delivers a sandboxed frame's click events to
 * nobody, leaving every link in every message dead). The guarantee that matters was untouched —
 * no `allow-scripts`, inner `script-src 'none'` — but a document that describes a different DOM
 * than the one that ships is worth less than no document.
 *
 * Nothing could see it: none of the four tests that mention `SECURITY.md` reads this sentence, and
 * a comment cannot be type-checked. So the string is read from the source and looked for in the
 * prose, which is the only join these two have.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')

const FRAME = readFileSync(resolve(PACKAGE_ROOT, 'src/frame.ts'), 'utf8')
const SECURITY = readFileSync(resolve(REPO_ROOT, 'SECURITY.md'), 'utf8')

/** The one place the attribute is set — `iframe.setAttribute('sandbox', '…')`. */
const SANDBOX: string = (() => {
  const value = /setAttribute\('sandbox', '([^']+)'\)/.exec(FRAME)?.[1]
  if (value === undefined) throw new Error('frame.ts sets no sandbox attribute')
  return value
})()

describe('the sandbox SECURITY.md describes', () => {
  it('is the one frame.ts sets, token for token', () => {
    expect(SECURITY).toContain(`sandbox="${SANDBOX}"`)
  })

  /**
   * The guarantee, as opposed to the wording: the tokens that would break it must be absent from
   * the attribute AND stated as absent, because "no script runs in there" is what every other
   * defence in that section is argued from.
   */
  it.each([
    'allow-scripts',
    'allow-forms',
    'allow-top-navigation',
  ])('grants no %s, and says so', (token) => {
    expect(SANDBOX.split(' ')).not.toContain(token)
    expect(SECURITY).toContain(token)
  })

  /** A token the frame DOES carry has to be explained where the claim is made, not elsewhere. */
  it.each(['allow-popups', 'allow-popups-to-escape-sandbox'])('explains %s', (token) => {
    expect(SANDBOX.split(' ')).toContain(token)
    expect(SECURITY).toContain(token)
  })
})

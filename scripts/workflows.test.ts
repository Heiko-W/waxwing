/**
 * The `concurrency` block of every workflow (R-108).
 *
 * A workflow without one lets two runs of the same thing overlap; a workflow with
 * `cancel-in-progress: true` lets the second run END the first. Both are right somewhere and wrong
 * somewhere else, and this repository had one of each:
 *
 *  - `ci.yml` cancelled unconditionally, including on pushes to `main`. Two merges a minute apart
 *    left the first commit with "cancelled" instead of a verdict — a state nobody goes back and
 *    rechecks, and one `git bisect` cannot read.
 *  - `release.yml` had no block at all. Two tag runs finishing out of order both write
 *    `releases/latest`, and `waxwing-stalwart.zip` is fetched from `releases/latest/download/…` by
 *    every Stalwart that auto-updates — so the newer release can leave every deployment pointing
 *    at the older one.
 *
 * Read as text rather than parsed: there is no YAML parser in this repository's dependencies, the
 * shapes asserted here are two lines each, and `scripts/ci.mjs --check-actions` reads the same
 * files the same way for the same reason.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows')

const read = (file: string) => readFileSync(join(WORKFLOWS, file), 'utf8')

const FILES = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()

/** The `concurrency:` mapping of a workflow, as raw lines — `[]` when there is none. */
function concurrency(file: string): string[] {
  const lines = read(file).split('\n')
  const start = lines.indexOf('concurrency:')
  if (start === -1) return []
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    body.push(line.trim())
  }
  return body
}

describe('workflow concurrency', () => {
  it('finds the workflows to check', () => {
    expect(FILES).toContain('ci.yml')
    expect(FILES).toContain('release.yml')
  })

  /**
   * Not "has the block we wrote", but "has a block": the point of the finding is that a workflow
   * running twice at once is a decision, and an absent block is that decision made by omission.
   */
  it.each(FILES)('gives %s a concurrency group', (file) => {
    expect(concurrency(file).some((line) => line.startsWith('group:'))).toBe(true)
  })

  /**
   * `cancel-in-progress: true` on a `push` trigger throws away a verdict on a commit that is
   * already merged. Any workflow that cancels has to say WHICH events it cancels for, and none of
   * this repository's triggers other than `pull_request` supersedes its predecessor.
   */
  it.each(FILES)('lets %s cancel a run only for a pull request', (file) => {
    const cancel = concurrency(file).find((line) => line.startsWith('cancel-in-progress:'))
    if (cancel === undefined) return
    expect(cancel).toMatch(
      /^cancel-in-progress: (false|\$\{\{ github\.event_name == 'pull_request' \}\})$/,
    )
  })

  /**
   * One group for ALL tags, deliberately: `release-${{ github.ref }}` would serialise re-runs of
   * one tag and leave two different tags racing for `releases/latest`, which is the case that
   * misdirects the auto-update path.
   */
  it('serialises every release run into one group', () => {
    expect(concurrency('release.yml')).toContain('group: release')
  })
})

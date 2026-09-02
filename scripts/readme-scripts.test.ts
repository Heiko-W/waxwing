/**
 * README's description of `pnpm verify` against the script it describes (R-110).
 *
 * The table said "`typecheck` → `lint` → `test` → `size`" and had said it since before `verify`
 * grew `check:node`, `build:libs`, `check:dist`, `check:site`, `check:actions` and `check:nul`.
 * A contributor reading it expects four steps and is surprised by ten — and, worse, does not learn
 * from the one place they were going to look that `check:node` is what refuses to run on the wrong
 * Node major, or that `build:libs` has to happen before the tests can resolve `@waxwing/*`.
 *
 * The row is prose, so it cannot be generated; it can be checked, which is what this does.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string) => readFileSync(join(ROOT, relativePath), 'utf8')

const README = read('README.md')

/** The `pnpm x && pnpm y && …` chain of a root script, as the script names in order. */
function chain(script: string): string[] {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
  const command = scripts[script]
  if (command === undefined) throw new Error(`package.json has no ${script} script`)
  return command.split('&&').map((step) => step.trim().replace(/^pnpm /, ''))
}

/** The README table row for a command, i.e. the line starting `| \`pnpm x\` |`. */
function row(command: string): string {
  const line = README.split('\n').find((one) => one.startsWith(`| \`pnpm ${command}\` |`))
  if (line === undefined) throw new Error(`README has no table row for pnpm ${command}`)
  return line
}

describe('the README script table', () => {
  it('names every step of `pnpm verify`, in order', () => {
    const steps = chain('verify')
    expect(steps.length).toBeGreaterThan(4)
    const line = row('verify')
    let cursor = 0
    for (const step of steps) {
      const at = line.indexOf(`\`${step}\``, cursor)
      expect(at, `\`${step}\` is missing from the README row for pnpm verify`).toBeGreaterThan(-1)
      cursor = at
    }
  })

  it('claims no step `pnpm verify` does not run', () => {
    const steps = new Set(chain('verify'))
    const claimed = [...row('verify').matchAll(/`([\w:]+)`/g)].map((match) => match[1] as string)
    expect(claimed.filter((step) => !steps.has(step))).toEqual([])
  })
})

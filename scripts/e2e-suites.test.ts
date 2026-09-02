/**
 * No spec file may be run by two of the gate's Playwright configs (R-44).
 *
 * `scripts/verify-e2e.mjs` runs seven configs one after another, each with its own fixture, its own
 * port and its own login. A spec listed in two of them therefore costs a full extra pass — and the
 * way this repository acquired one is the part worth guarding: the B25 experiment took over the
 * NAME `security.spec.ts` and overwrote the five "Account & security" tests that had it, while the
 * write config still listed the name and a comment describing the tests that were gone. The result
 * ran twice per gate and covered less than before. Restored as `account-security.spec.ts`.
 *
 * The one deliberate exception is `read.spec.ts`, which `playwright.webkit.config.ts` runs a second
 * time on the other engine — that IS the suite (B11), and it is named here so the exception has to
 * be argued rather than added.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const E2E = join(ROOT, 'e2e')
const VERIFY = join(ROOT, 'scripts/verify-e2e.mjs')

/** The configs `pnpm verify:e2e` runs, via the `pnpm e2e*` scripts it shells out to. */
const GATE_CONFIGS = [
  'playwright.config.ts',
  'playwright.mount.config.ts',
  'playwright.read.config.ts',
  'playwright.write.config.ts',
  'playwright.shared.config.ts',
  'playwright.webkit.config.ts',
  'playwright.deploy.config.ts',
] as const

/**
 * `read.spec.ts` on WebKit — the second engine is the point, so this pair is allowed.
 * Anything else that lands here is the R-44 defect coming back.
 */
const ALLOWED_TWICE = new Map<string, string>([['read.spec.ts', 'playwright.webkit.config.ts']])

/** The `scripts` block of a manifest, relative to the repository root. */
function scriptsOf(manifest: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, manifest), 'utf8')) as {
    scripts: Record<string, string>
  }
  return parsed.scripts
}

/** The `**\/x.spec.ts` entries of a config's `testMatch`, in file order. */
function specsOf(config: string): string[] {
  const source = readFileSync(join(E2E, config), 'utf8')
  const start = source.indexOf('testMatch:')
  if (start === -1) throw new Error(`${config} has no testMatch — every gate config needs one`)
  const list = source.slice(start, source.indexOf(']', start))
  return [...list.matchAll(/'\*\*\/([\w.-]+\.spec\.ts)'/g)].map((match) => match[1] as string)
}

describe('the Playwright gate configs', () => {
  /**
   * The list above is maintained by hand; this is what stops it drifting from the script that
   * actually runs them. `verify-e2e.mjs` names the pnpm scripts, and `e2e/package.json` maps each
   * one to its `-c <config>` — so a new suite added to the gate has to appear here too.
   */
  it('covers every config `verify-e2e.mjs` runs', () => {
    const script = readFileSync(VERIFY, 'utf8')
    const root = scriptsOf('package.json')
    const e2e = scriptsOf('e2e/package.json')
    const configs: string[] = []
    // `run('read e2e suite', ['e2e:read'])` → the root `e2e:read` script → the `e2e:read` script in
    // the e2e package → its `-c <config>`. Names that do not resolve to `playwright test` are the
    // fixture's own (`e2e:server:down`) and are not suites.
    for (const match of script.matchAll(/\brun\('[^']*', \['([\w:]+)'\]\)/g)) {
      const name = match[1] as string
      const rootCommand = root[name]
      if (rootCommand === undefined) throw new Error(`verify-e2e.mjs runs unknown script: ${name}`)
      const delegated = /--filter @waxwing\/e2e run (\S+)/.exec(rootCommand)?.[1]
      if (delegated === undefined) continue
      const command = e2e[delegated]
      if (command === undefined) throw new Error(`e2e/package.json has no ${delegated}`)
      if (!command.startsWith('playwright test')) continue
      configs.push(/-c (\S+)/.exec(command)?.[1] ?? 'playwright.config.ts')
    }
    expect(configs.length).toBeGreaterThan(0)
    expect([...new Set(configs)].sort()).toEqual([...GATE_CONFIGS].sort())
  })

  it.each(GATE_CONFIGS)('%s lists at least one spec', (config) => {
    expect(specsOf(config).length).toBeGreaterThan(0)
  })

  it('runs no spec in two configs', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const config of GATE_CONFIGS) {
      for (const spec of specsOf(config)) {
        const first = seen.get(spec)
        if (first === undefined) {
          seen.set(spec, config)
          continue
        }
        if (ALLOWED_TWICE.get(spec) === config) continue
        duplicates.push(`${spec} — in ${first} AND ${config}`)
      }
    }
    expect(duplicates).toEqual([])
  })

  /**
   * The restored suite, by name: it is the file the overwrite lost, and a rename back to
   * `security.spec.ts` would collide with the B25 file all over again.
   */
  it('runs the account-security suite in the write harness only', () => {
    expect(specsOf('playwright.write.config.ts')).toContain('account-security.spec.ts')
    expect(specsOf('playwright.read.config.ts')).not.toContain('account-security.spec.ts')
  })
})

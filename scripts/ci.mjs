#!/usr/bin/env node
// Waxwing — the local pipeline (ADR-003's "CI as a script", made a pipeline).
//
//   pnpm gate          the full gate: preflight → verify → jmap integration → e2e
//   pnpm gate --fast     everything that needs neither Docker nor a browser (the pre-push hook)
//   pnpm gate --no-e2e   preflight + verify + integration (fixture up, Playwright skipped)
//
// WHY THIS EXISTS ALONGSIDE `pnpm verify`. ADR-003 made the verify scripts the gate and accepted, in
// so many words, that "correctness relies on contributors running `pnpm verify`". Three things that
// costs, and this closes:
//
//  1. **The Node version is not checked anywhere.** `.nvmrc` pins 24 and `engines` says `>=22`, so
//     node 26 satisfies the manifest and breaks the suite: it defines a global `localStorage` that is
//     `undefined` without `--localstorage-file`, which shadows jsdom's and fails 22 tests that have
//     nothing wrong with them. Measured on this machine, 2026-08-16. A gate whose failures cannot be
//     trusted is worse than no gate, so preflight refuses to run on the wrong major.
//  2. **B22: the `@waxwing/jmap` integration suites run in NEITHER `verify` nor `verify:e2e`,** and
//     they `describe.skipIf` themselves away when the fixture is unreachable — so they have never
//     failed, because they have never run. This pipeline runs them against a live fixture AND
//     asserts they were not skipped, which is the only way that class of hole stays closed.
//  3. **Nothing runs automatically.** `.githooks/pre-push` calls `--fast`.
//
// It stays a thin sequencer over the same pnpm scripts, exactly as ADR-003 requires, so the local
// gate and the eventual `.github/workflows/ci.yml` cannot diverge: both call these scripts, and the
// workflow file is the same list of stages.
//
// No dependencies — Node globals only, like the other scripts here.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))
const FAST = args.has('--fast')
const NO_E2E = args.has('--no-e2e')

const results = []
let failed = null

const bold = (s) => `\u001b[1m${s}\u001b[0m`
const dim = (s) => `\u001b[2m${s}\u001b[0m`

function heading(text) {
  console.log(`\n${bold(`[ci] ${text}`)}`)
}

/** Run a pnpm script as its own stage; a non-zero exit aborts the pipeline. */
function stage(label, args, { capture = false } = {}) {
  heading(`${label} → pnpm ${args.join(' ')}`)
  const started = Date.now()
  const result = spawnSync('pnpm', args, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  if (capture && result.stdout) process.stdout.write(result.stdout)
  if (result.error) throw result.error
  const ok = result.status === 0
  results.push({ label, ok, seconds })
  if (!ok) {
    failed = `${label} (pnpm ${args.join(' ')} exited with ${result.status})`
    throw new Error(failed)
  }
  return result.stdout ?? ''
}

// ---------------------------------------------------------------------------------------------
// Preflight — the checks that make every later result trustworthy.
// ---------------------------------------------------------------------------------------------

function preflight() {
  heading('preflight')
  const started = Date.now()

  const want = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()
  const have = process.versions.node
  const haveMajor = have.split('.')[0]
  if (haveMajor !== want) {
    console.error(
      `\n[ci] REFUSING TO RUN — node ${have}, but .nvmrc pins ${want}.\n` +
        '\n' +
        '  This is not pedantry. On node >= 25 a global `localStorage` exists but is `undefined`\n' +
        "  without --localstorage-file, and it shadows jsdom's: 22 tests then fail for reasons that\n" +
        '  have nothing to do with the code under test. A gate you cannot trust is worse than none.\n' +
        '\n' +
        `  Fix:  nvm use ${want}     (or: nvm install ${want})\n` +
        `  Then: pnpm gate${FAST ? ' --fast' : ''}\n`,
    )
    process.exit(1)
  }
  console.log(`  node ${have} matches .nvmrc (${want})`)

  const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
  console.log(`  pnpm ${pnpmVersion}`)

  // Docker is only needed by the stages that use it; report it here so a missing daemon is called
  // out at second 0 rather than after the multi-minute verify stage.
  let docker = false
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    docker = true
  } catch {
    docker = false
  }
  console.log(`  docker ${docker ? 'available' : 'NOT available'}`)
  if (!docker && !FAST) {
    console.error(
      '\n[ci] The full pipeline needs Docker for the Stalwart fixture.\n' +
        '     Start Docker, or run `pnpm gate --fast` for the hermetic half.\n',
    )
    process.exit(1)
  }

  results.push({ label: 'preflight', ok: true, seconds: Math.round((Date.now() - started) / 1000) })
  return { docker }
}

// ---------------------------------------------------------------------------------------------
// The jmap integration suites, run for real (B22).
// ---------------------------------------------------------------------------------------------

/**
 * These suites `describe.skipIf(!AVAILABLE)` themselves away when the fixture is unreachable, which
 * is why they have never failed: a skipped suite is a green suite. Running them is not enough — the
 * pipeline has to assert they RAN. Vitest reports skips in its summary, so the count is the check.
 */
function integration() {
  stage('fixture up (for the integration suites)', ['e2e:server'])
  const output = stage(
    'jmap integration suites (B22)',
    ['--filter', '@waxwing/jmap', 'run', 'test:integration'],
    { capture: true },
  )

  // Hand the next stage a CLEAN fixture. `verify:e2e` brings its own up, and `up` is idempotent —
  // so without this teardown it would inherit THIS stage's container: same volume, same seeded
  // state, and an origin advertised for a different consumer. Measured: leaving it up failed two
  // offline specs that pass from a fresh fixture. A pipeline stage that changes the next stage's
  // result is worse than no stage, so the ~20 s to recreate it is the right price.
  stage('fixture down (isolate the e2e stage)', ['e2e:server:down'])

  const skipped = /(\d+)\s+skipped/.exec(output)
  const passed = /Tests\s+(\d+)\s+passed/.exec(output)
  if (skipped !== null && Number(skipped[1]) > 0) {
    failed = `jmap integration suites skipped ${skipped[1]} test(s) — the fixture was not reachable`
    throw new Error(
      `${failed}\n` +
        '  This is defect B22: these suites fail OPEN, so a skip is indistinguishable from a pass\n' +
        '  unless something asserts otherwise. That something is this check.',
    )
  }
  if (passed === null || Number(passed[1]) === 0) {
    failed = 'jmap integration suites reported no passing tests — they did not really run'
    throw new Error(failed)
  }
  console.log(`  ${passed[1]} integration tests actually ran (not skipped)`)
}

// ---------------------------------------------------------------------------------------------

function summarise() {
  const width = Math.max(...results.map((r) => r.label.length), 10)
  console.log(`\n${bold('[ci] summary')}`)
  for (const { label, ok, seconds } of results) {
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(width)} ${dim(`${seconds}s`)}`)
  }
  const total = results.reduce((sum, r) => sum + r.seconds, 0)
  console.log(dim(`  ${Math.floor(total / 60)}m ${total % 60}s total`))
}

try {
  preflight()
  stage('verify (typecheck, lint, tests, build, size budget)', ['verify'])

  if (!FAST) {
    integration()
    if (NO_E2E) {
      console.log('\n[ci] --no-e2e: skipping the Playwright suites; tearing the fixture down.')
      spawnSync('pnpm', ['e2e:server:down'], { cwd: ROOT, stdio: 'inherit' })
    } else {
      // verify:e2e manages the fixture itself (and tears it down in a finally), so the container the
      // integration stage brought up is simply reused and then removed by it.
      stage('e2e (Docker fixture + six Playwright suites)', ['verify:e2e'])
    }
  }

  summarise()
  console.log(
    `\n[ci] ${bold('PASSED')} — ${FAST ? 'the hermetic half' : 'the full gate'}. ${
      FAST ? 'Run `pnpm gate` before a release or after touching sync/e2e.' : ''
    }`,
  )
} catch (error) {
  summarise()
  console.error(`\n[ci] ${bold('FAILED')} — ${failed ?? error.message}`)
  // Leave nothing running: a fixture left up reshapes the next run's results.
  spawnSync('pnpm', ['e2e:server:down'], { cwd: ROOT, stdio: 'ignore' })
  process.exit(1)
}

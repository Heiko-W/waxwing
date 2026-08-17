#!/usr/bin/env node
// Waxwing — the `@waxwing/jmap` integration suites against a live Stalwart fixture (defect B22).
//
//   pnpm verify:integration
//
// ── WHY THIS IS ITS OWN SCRIPT ────────────────────────────────────────────────────────────────
//
// It used to be a private function inside `scripts/ci.mjs`, reachable only through `pnpm gate`.
// `pnpm gate` is called by exactly one workflow — `release.yml` — so these nine tests ran ONCE PER
// RELEASE and never on a pull request. `ci.yml` runs `pnpm verify` and `pnpm verify:e2e`, and
// neither one touched them: the root `vitest.config.ts` collects `packages/*/src/**` while these
// live in `packages/jmap/test/integration/`, and `vitest.integration.config.ts` says in its own
// header that it is intentionally not a project of the root config.
//
// So the very hole B22 describes — suites that fail open and therefore never fail — had reopened in
// the hosted pipeline, one layer up: they were not failing open, they were not running. A break in
// `packages/jmap` would first have surfaced on a tag push, which is the most expensive moment
// available. Lifting the stage into a script both `verify:e2e` and `gate --no-e2e` can call closes
// that without moving a single stage into YAML — ADR-003's rule is that the workflow stays a thin
// caller of the same pnpm scripts, and this keeps it one.
//
// ── WHY RUNNING THEM IS NOT ENOUGH ────────────────────────────────────────────────────────────
//
// The suites `describe.skipIf(!AVAILABLE)` themselves away when the fixture is unreachable, so a
// skipped run and a passing run are the same colour. The pipeline therefore asserts they RAN, by
// counting vitest's own summary. That assertion is the whole point of the stage.
//
// Dependency-free: node: builtins only, like its neighbours here.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function run(label, args, { capture = false } = {}) {
  console.log(`\n[integration] ${label} → pnpm ${args.join(' ')}`)
  const result = spawnSync('pnpm', args, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    // On Windows pnpm resolves to pnpm.cmd; spawning a .cmd without shell:true throws.
    shell: process.platform === 'win32',
  })
  if (capture && result.stdout) process.stdout.write(result.stdout)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed (pnpm ${args.join(' ')} exited with ${result.status})`)
  }
  return result.stdout ?? ''
}

/**
 * Run the suites and prove they were not skipped.
 *
 * Leaves NO fixture behind. `verify:e2e` brings its own up and `up` is idempotent, so a container
 * left running here would be inherited by the next stage: same volume, same seeded state, and an
 * origin advertised for a different consumer. Measured — leaving it up failed two offline specs
 * that pass from a fresh fixture. A stage that changes the next stage's result is worse than no
 * stage, so the ~20s to recreate it is the right price.
 */
export async function runIntegration() {
  let output = ''
  try {
    run('fixture up', ['e2e:server'])

    // Grant the delegated shares for the duration of this stage (M4.4). The suites include ADR-020's
    // executable evidence — that a shared account advertises `submission` and then refuses both
    // `Identity/get` and `EmailSubmission/set` — and that probe is dead without a share: it would
    // report itself skipped and the gate would prove nothing about the very finding it exists to
    // keep honest. No explicit revoke: the teardown below is `down -v`, which removes the volume and
    // takes the shares with it. (`shared.teardown.mjs` DOES revoke, because it may keep the fixture
    // up.) The fixture's default is single-account and `smoke()` asserts it — a leaked share
    // reshapes every later suite's sidebar.
    const fixture = await import(new URL('../e2e/stalwart/fixture.mjs', import.meta.url).href)
    await fixture.ensureDelegations()

    output = run(
      'jmap integration suites (B22)',
      ['--filter', '@waxwing/jmap', 'run', 'test:integration'],
      { capture: true },
    )
  } finally {
    // Always, including when the suites failed: see the note above about inherited containers.
    try {
      run('fixture down (isolate the next stage)', ['e2e:server:down'])
    } catch (teardownError) {
      console.error(`[integration] teardown failed: ${teardownError.message}`)
    }
  }

  // STRIP ANSI FIRST. Vitest colours its summary when it believes something is watching, and
  // GitHub's runner is one of those somethings — so in CI the line carries escape sequences BETWEEN
  // the word `Tests` and the number, and `/Tests\s+(\d+)/` matches nothing. Locally the output goes
  // down a pipe, vitest drops the colour, and the same regex works fine. The result was this check
  // failing every hosted run with "they did not really run" about nine tests that had passed on
  // screen a second earlier: the B22 guard defeating itself.
  const plain = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
  const skipped = /(\d+)\s+skipped/.exec(plain)
  const passed = /Tests\s+(\d+)\s+passed/.exec(plain)

  if (skipped !== null && Number(skipped[1]) > 0) {
    throw new Error(
      `jmap integration suites skipped ${skipped[1]} test(s) — the fixture was not reachable\n` +
        '  This is defect B22: these suites fail OPEN, so a skip is indistinguishable from a pass\n' +
        '  unless something asserts otherwise. That something is this check.',
    )
  }
  if (passed === null || Number(passed[1]) === 0) {
    throw new Error('jmap integration suites reported no passing tests — they did not really run')
  }
  console.log(`  ${passed[1]} integration tests actually ran (not skipped)`)
  return Number(passed[1])
}

// Only when invoked directly (`pnpm verify:integration`), so `verify-e2e.mjs` can import it as a
// step of the larger runner and keep ownership of the teardown backstop.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runIntegration()
    console.log('\n[integration] OK')
  } catch (error) {
    console.error(`\n[integration] FAILED — ${error.message}`)
    process.exit(1)
  }
}

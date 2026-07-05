// Waxwing local E2E gate (WP P0.5, see docs/adr/003-local-verify-first-ci-later.md).
//
// The Docker + browser half of the "CI as a script" pair. `pnpm verify` is the fast gate
// (typecheck, lint, test, size); this runner adds the slow, host-dependent E2E gate:
//
//   1. ensure the pinned Playwright chromium is installed
//   2. bring the Stalwart fixture up (pnpm e2e:server — self-smokes per ADR-002)
//   3. run the Playwright suite (pnpm e2e)
//   4. ALWAYS tear the fixture down (pnpm e2e:server:down), even if a step above failed
//
// A plain `&&` chain cannot guarantee teardown-on-failure, so steps 1–3 run inside a `try`
// and teardown lives in `finally`. Dependency-free: node: builtins only.

import { spawnSync } from 'node:child_process'

const run = (label, args) => {
  console.log(`\n[verify:e2e] ${label} → pnpm ${args.join(' ')}`)
  // On Windows pnpm resolves to pnpm.cmd; spawning a .cmd without shell:true throws
  // (EINVAL since the Node CVE-2024-27980 fix, ENOENT before it). The args are all
  // static literals here, so shell quoting is safe.
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed (pnpm ${args.join(' ')} exited with ${result.status})`)
  }
}

// An operator interrupt (Ctrl-C / SIGTERM) during the long `pnpm e2e` step kills Node
// before the finally block runs, leaking the Stalwart container (which then trips the next
// `up` port-conflict preflight). Tear the fixture down on signal too, then exit 130.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.error(`\n[verify:e2e] ${sig} received — tearing fixture down`)
    try {
      run('fixture down', ['e2e:server:down'])
    } catch (teardownError) {
      console.error(`[verify:e2e] teardown after ${sig} failed: ${teardownError.message}`)
    } finally {
      process.exit(130)
    }
  })
}

let failure

try {
  run('install pinned chromium', [
    '--filter',
    '@waxwing/e2e',
    'exec',
    'playwright',
    'install',
    'chromium',
  ])
  run('fixture up + smoke', ['e2e:server'])
  run('playwright suite', ['e2e'])
} catch (error) {
  failure = error
} finally {
  try {
    run('fixture down', ['e2e:server:down'])
  } catch (teardownError) {
    // Never let a teardown error mask the real failure; surface it, keep the first one.
    if (failure) console.error(`[verify:e2e] teardown also failed: ${teardownError.message}`)
    else failure = teardownError
  }
}

if (failure) {
  console.error(`\n[verify:e2e] FAILED — ${failure.message}`)
  process.exit(1)
}

console.log('\n[verify:e2e] OK — chromium + fixture smoke + playwright + teardown all passed')

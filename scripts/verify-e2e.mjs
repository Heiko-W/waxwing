// Waxwing local E2E gate (WP P0.5, see docs/adr/003-local-verify-first-ci-later.md).
//
// The Docker + browser half of the "CI as a script" pair. `pnpm verify` is the fast gate
// (typecheck, lint, test, size); this runner adds the slow, host-dependent E2E gate:
//
//   0. build the workspace libraries the app imports (their `dist/`, which every webServer's
//      `vite build` needs to resolve `@waxwing/jmap` and friends)
//   1. ensure the pinned Playwright chromium is installed
//   2. run the self-contained placeholder suite (pnpm e2e — vite preview, no fixture)
//   3. run the M3.10 /mail/ mount suite (pnpm e2e:mount — static mount server, no fixture)
//   4. run the M1.9 read, M2.9 write and M3.10 deploy suites (pnpm e2e:read / e2e:write /
//      e2e:deploy) — they self-manage the Stalwart fixture: their Playwright globalSetup brings the
//      fixture up advertising the app origin + seeds alice's inbox (self-smokes per ADR-002), and
//      globalTeardown tears it down
//   5. ALWAYS tear the fixture down as a backstop, even if a step above failed or was killed
//      before those suites' own teardown ran
//
// Order is cheapest-first: the two fixture-free suites (2, 3) fail in seconds on a bundle that
// cannot boot, so a broken build never pays for a Docker fixture to find out.
//
// This IS the E2E gate — ADR-003 realizes CI as `pnpm verify` + `pnpm verify:e2e` because no
// GitHub repository exists yet. Every suite therefore has to be listed here or it is not gated
// at all; a suite that only ever runs when someone types its script by hand is not covered. M3.10
// found this the hard way: the placeholder config had no `testMatch`, silently collected all five
// fixture-backed spec files, and step 2 had been failing for a milestone (see the testMatch
// comment in e2e/playwright.config.ts).
//
// A plain `&&` chain cannot guarantee teardown-on-failure, so steps 1–4 run inside a `try`
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
  // The workspace libraries FIRST. Every Playwright config's webServer runs `vite build`, and the
  // app imports `@waxwing/jmap` etc. through their `exports` → `dist/index.js`. Without a build
  // those files do not exist and the bundle fails to resolve them.
  //
  // `pnpm verify` opens with the same step, which is exactly why this was missing here and why it
  // was invisible locally: anyone who has ever run `verify` has a `dist/` lying around, so
  // `verify:e2e` on its own appeared to work. On a clean checkout — CI, or a new contributor's
  // first run — it fails inside a webServer with `Rolldown failed to resolve import`, which reads
  // like an application bug rather than a missing build step.
  run('build workspace libraries', ['build:libs'])
  run('install pinned chromium', [
    '--filter',
    '@waxwing/e2e',
    'exec',
    'playwright',
    'install',
    'chromium',
  ])
  run('placeholder e2e suite', ['e2e'])
  // The /mail/ mount suite (M3.10). Fixture-free and fast, so it runs BEFORE the Docker-backed
  // suites: it asserts the built bundle boots under a path prefix, which is the deployment shape
  // Stalwart produces, and a bundle that cannot boot there should fail in seconds rather than
  // after two minutes of fixture work.
  run('mount e2e suite', ['e2e:mount'])
  run('read e2e suite', ['e2e:read'])
  run('write e2e suite', ['e2e:write'])
  // The M4.4 shared-account suite. Its own config and its own fixture STATE: it grants two
  // delegations in globalSetup and revokes them in teardown, because a share changes what the
  // sidebar IS (account-grouped sections) and would make every other suite's `treeitem name=/Inbox/`
  // ambiguous. Listed here or it is not gated — see the header.
  run('shared-account e2e suite', ['e2e:shared'])
  // The M3.10 deploy suite runs LAST: it is the only one that builds the app TWICE (a staged second
  // deploy, e2e/pwa-stage.vite.config.mjs), so putting it earlier would make every other suite wait
  // on work none of them need. It self-manages the fixture like read/write.
  run('deploy e2e suite', ['e2e:deploy'])
} catch (error) {
  failure = error
} finally {
  try {
    run('fixture down (backstop)', ['e2e:server:down'])
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

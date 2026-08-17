#!/usr/bin/env node
// Waxwing — the local pipeline (ADR-003's "CI as a script", made a pipeline).
//
//   pnpm gate          the full gate: preflight → verify → jmap integration → e2e
//   pnpm gate --fast     everything that needs neither Docker nor a browser (the pre-push hook)
//   pnpm gate --no-e2e   preflight + verify + integration (fixture up, Playwright skipped)
//
// WHY THIS EXISTS ALONGSIDE `pnpm verify`. ADR-003 made the verify scripts the gate and accepted, in
// so many words, that "correctness relies on contributors running `pnpm verify`". Four things that
// costs, and this closes:
//
//  1. **The Node version is not checked anywhere.** `.nvmrc` pins 24 and `engines` says `>=22`, so
//     node 26 satisfies the manifest and breaks the suite: it defines a global `localStorage` that is
//     `undefined` without `--localstorage-file`, which shadows jsdom's and fails 22 tests that have
//     nothing wrong with them. Measured on this machine, 2026-08-16. A gate whose failures cannot be
//     trusted is worse than no gate, so preflight refuses to run on the wrong major.
//  2. **B22: the `@waxwing/jmap` integration suites** `describe.skipIf` themselves away when the
//     fixture is unreachable — so they had never failed, because they had never run. They are run
//     against a live fixture AND asserted not to have been skipped, which is the only way that
//     class of hole stays closed. That stage no longer lives HERE, though: it is
//     `scripts/integration.mjs` behind `pnpm verify:integration`, and `verify:e2e` calls it. It had
//     to move, because while it lived here it was reachable only through `pnpm gate` — and the only
//     workflow that calls `pnpm gate` is `release.yml`. So on the hosted pipeline these nine tests
//     ran once per RELEASE and not once on a pull request: B22 one layer up.
//  3. **Nothing runs automatically.** `.githooks/pre-push` calls `--fast`.
//  4. **Nothing enforces that the workflows' own `uses:` lines stay SHA-pinned.** A pin nobody
//     checks is a pin someone re-tags away in a hurry; `release.yml` is the job that holds
//     `contents: write` over the published artefacts, and it calls `pnpm gate`. See
//     `checkWorkflowActionPins` for what runs it and, honestly, what does not.
//
// It stays a thin sequencer over the same pnpm scripts, exactly as ADR-003 requires, so the local
// gate and the eventual `.github/workflows/ci.yml` cannot diverge: both call these scripts, and the
// workflow file is the same list of stages.
//
// No dependencies — Node globals only, like the other scripts here.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))
const FAST = args.has('--fast')
const ONLY_ACTIONS = args.has('--check-actions')
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

/**
 * Every `uses:` in `.github/workflows/` must name a 40-hex commit SHA, never a tag.
 *
 * A tag is a mutable pointer. `softprops/action-gh-release@v2` is whatever `v2` points at when the
 * run starts, and moving that tag is how tj-actions/changed-files (March 2025) turned thousands of
 * repositories into a credential dump — every workflow file still reading `@v35`, every run
 * executing new code. In `release.yml` the stake is concrete: `pnpm/action-setup` runs BEFORE the
 * build and can patch the tree, `softprops/action-gh-release` runs AFTER it and holds the token
 * that uploads the zip AND the SHA256SUMS that vouches for it.
 *
 * The trailing `# vX.Y.Z` is required too, and not decoration: a bare 40-hex string is unreviewable,
 * and it is the token Dependabot rewrites alongside the SHA (.github/dependabot.yml). No comment
 * means no version to compare against when the bot proposes a bump.
 *
 * WHERE THIS RUNS, stated because the coverage is uneven. `pnpm gate` and `pnpm gate:fast` (the
 * pre-push hook) run it; `pnpm verify` does NOT, and the hosted `ci.yml` calls `verify`, so a pull
 * request that unpins an action is caught on the contributor's push and by `release.yml` — which
 * runs the full `pnpm gate` before publishing anything — rather than by the PR check. Moving it
 * into `verify` means a new script entry in the root `package.json`; it lives here because this is
 * the file that already owns the pipeline's own hygiene.
 */
function checkWorkflowActionPins() {
  const dir = new URL('../.github/workflows/', import.meta.url)
  const problems = []
  let pinned = 0

  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = readFileSync(new URL(file, dir), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const use = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line)
      if (use === null) return
      const [, reference, rest] = use
      // A path reference is this repository's own code, already covered by review; a container
      // reference is pinned by its own digest syntax and is not GitHub's resolution path at all.
      if (reference.startsWith('./') || reference.startsWith('docker://')) return

      const where = `${file}:${index + 1}`
      if (!/@[0-9a-f]{40}$/.test(reference)) {
        problems.push(`${where}  ${reference} — not a commit SHA (a tag can be moved under you)`)
      } else if (!/#\s*v/.test(rest)) {
        problems.push(`${where}  ${reference} — no trailing \`# vX.Y.Z\` comment`)
      } else {
        pinned += 1
      }
    })
  }

  if (problems.length > 0) {
    console.error(
      '\n[ci] REFUSING TO RUN — a GitHub Action is not pinned to a commit SHA:\n\n' +
        `${problems.map((problem) => `    ${problem}`).join('\n')}\n\n` +
        '  Resolve the tag and pin it (the comment is what keeps the pin readable and what\n' +
        '  .github/dependabot.yml maintains):\n\n' +
        '    gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object.sha\n' +
        '    uses: <owner>/<action>@<40-hex>  # v1.2.3\n\n' +
        '  An annotated tag answers with a tag object; dereference it with\n' +
        '  `gh api repos/<owner>/<action>/git/tags/<sha> --jq .object.sha`.\n',
    )
    process.exit(1)
  }
  console.log(`  ${pinned} workflow actions pinned to commit SHAs`)
}

// `pnpm check:actions` — the pin check on its own, so the HOSTED pull-request job enforces it too.
//
// It used to run only inside `preflight()`, i.e. only under `pnpm gate` and the pre-push hook. Both
// are local, and neither is what guards a contribution: ci.yml runs `pnpm verify`, so a pull request
// that unpinned an action back to a mutable tag would have gone green. A check that cannot fail
// where the change actually arrives is decoration.
if (ONLY_ACTIONS) {
  checkWorkflowActionPins()
  process.exit(0)
}

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

  checkWorkflowActionPins()

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
//
// The jmap integration suites (B22) used to live here as a private `integration()` function. They
// now live in `scripts/integration.mjs` behind `pnpm verify:integration`, because a stage that only
// `pnpm gate` can reach is a stage the hosted pull-request job never runs — and `pnpm gate` is
// called by `release.yml` alone. `verify:e2e` runs it as one of its stages, so `ci.yml` picks it up
// without a line of YAML changing.
//
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
    if (NO_E2E) {
      // The integration suites on their own, because they are the half of the Docker work that is
      // not Playwright. `verify:e2e` runs the same script as one of its stages, so the full gate
      // must NOT also run it here or it would run twice.
      stage('jmap integration suites (B22)', ['verify:integration'])
      console.log('\n[ci] --no-e2e: skipping the Playwright suites.')
    } else {
      stage('e2e (Docker fixture + jmap integration + six Playwright suites)', ['verify:e2e'])
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

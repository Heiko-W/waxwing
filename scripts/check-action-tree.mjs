#!/usr/bin/env node
// Waxwing — the SECOND level of the action-pin check.
//
//   pnpm check:actions       offline: every `uses:` in .github/workflows/ is a 40-hex SHA
//   pnpm check:actions:deep  ← this file: and so is every `uses:` INSIDE those actions
//
// ── WHY A SECOND SCRIPT AND NOT A LONGER FIRST ONE ────────────────────────────────────────────
//
// `checkWorkflowActionPins()` in scripts/ci.mjs reads files off disk and finishes in milliseconds.
// It runs in `preflight()`, so it runs in `pnpm gate:fast`, so it runs in the pre-push hook. That
// is only defensible because it is hermetic: no network, no token, no rate limit, no flake.
// Folding an API call into it would make `git push` fail when GitHub is slow, which is how a
// useful check turns into one people disable.
//
// So this is deliberately a separate, NETWORK-BOUND stage. It is not in `pnpm verify` and not in
// preflight. It runs as its own step in ci.yml, where a token and connectivity are a given.
//
// ── WHAT IT CATCHES THAT THE FIRST ONE CANNOT ─────────────────────────────────────────────────
//
// Pinning `actions/upload-pages-artifact@56afc609` freezes THAT repository's tree. It does not
// freeze what the action then calls at RUN TIME. v3.0.1 is a composite action whose action.yml
// line 77 read:
//
//     uses: actions/upload-artifact@v4
//
// A 40-hex pin in pages.yml, and one `git tag -f v4` away from running someone else's code in a
// job holding `pages: write` + `id-token: write`. The first-level check reads only
// .github/workflows/, so it saw nothing wrong — and said so, in a comment that carefully lists
// where its coverage is uneven without listing this. Of the nine actions used here, seven are
// `node20` with no dependencies at all and two are composite; only that one carried a tag. It is
// gone as of upload-pages-artifact v5.0.0, which pins its own dependency. This stage is what
// keeps it gone.
//
// It RECURSES rather than descending one fixed level, because a composite action may call another.
//
// ── WHY IT MUST NOT FAIL OPEN ─────────────────────────────────────────────────────────────────
//
// Defect B22 is this project's standing lesson that a check which skips when its dependency is
// unreachable is indistinguishable from one that passed. So an unreachable API here is a FAILURE,
// not a skip. That is the right trade for a stage that only runs where the network is a given.
//
// Dependency-free: node: builtins and global fetch.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const SHA = /^[0-9a-f]{40}$/
const WORKFLOWS = new URL('../.github/workflows/', import.meta.url)

const bold = (s) => `[1m${s}[0m`

/** `gh` is not required, but it is the only token source that needs no setup on a dev machine. */
function token() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const AUTH = token()

/** Every `uses:` value in a YAML blob, without a YAML parser — the same shape ci.mjs matches. */
function usesIn(yaml) {
  return [...yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1])
}

/**
 * An action reference splits as `owner/repo[/sub/path]@ref`. The definition lives at
 * `sub/path/action.yml` INSIDE `owner/repo` — a subpath reference is a different action in the
 * same repository, so it has to be resolved as such rather than as the repository root.
 */
function parse(reference) {
  const at = reference.lastIndexOf('@')
  if (at === -1) return null
  const [owner, repo, ...rest] = reference.slice(0, at).split('/')
  if (!owner || !repo) return null
  return { owner, repo, sub: rest.join('/'), ref: reference.slice(at + 1) }
}

async function fetchDefinition({ owner, repo, sub, ref }) {
  for (const name of ['action.yml', 'action.yaml']) {
    const path = sub ? `${sub}/${name}` : name
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'waxwing-action-tree-check',
          ...(AUTH ? { Authorization: `Bearer ${AUTH}` } : {}),
        },
      },
    )
    if (response.status === 404) continue
    if (!response.ok) {
      // NOT a skip. See the header: an unreachable API is a failed check, not a passed one.
      throw new Error(
        `GitHub API ${response.status} for ${owner}/${repo}${sub ? `/${sub}` : ''}@${ref}` +
          (response.status === 403 || response.status === 429
            ? ' — rate limited; set GITHUB_TOKEN or run `gh auth login`'
            : ''),
      )
    }
    const body = await response.json()
    return Buffer.from(body.content, 'base64').toString('utf8')
  }
  // A JavaScript or Docker action has an action.yml too; reaching here means the path names
  // something this checker cannot resolve, which is worth saying rather than swallowing.
  return null
}

const problems = []
const visited = new Set()
let resolved = 0
let composites = 0

function chain(trail, leaf) {
  return [...trail, leaf].join('\n         └─ ')
}

async function walk(reference, trail) {
  if (visited.has(reference)) return
  visited.add(reference)

  const parsed = parse(reference)
  if (parsed === null) return
  const definition = await fetchDefinition(parsed)
  if (definition === null) return
  // Only a composite action can carry a `uses:` of its own. `node20`/`docker` actions cannot.
  if (!/^\s*using:\s*['"]?composite/m.test(definition)) return

  composites += 1
  for (const nested of usesIn(definition)) {
    // A local reference resolves inside the tree the outer SHA already pinned; a docker digest is
    // pinned by its own syntax. Neither is a mutable pointer.
    if (nested.startsWith('./') || nested.startsWith('../')) continue
    if (nested.startsWith('docker://')) {
      if (!nested.includes('@sha256:')) {
        problems.push(
          chain(trail, `${reference}\n         └─ ${bold(nested)} — docker tag, not a digest`),
        )
      }
      continue
    }
    resolved += 1
    const at = nested.lastIndexOf('@')
    if (at === -1 || !SHA.test(nested.slice(at + 1))) {
      problems.push(chain(trail, `${reference}\n         └─ ${bold(nested)} — not a commit SHA`))
      continue
    }
    await walk(nested, [...trail, reference])
  }
}

const roots = new Set()
for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
  for (const reference of usesIn(readFileSync(new URL(file, WORKFLOWS), 'utf8'))) {
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue
    roots.add(reference)
  }
}

try {
  for (const root of roots) {
    resolved += 1
    await walk(root, [])
  }
} catch (error) {
  console.error(
    `\n[ci] REFUSING TO PASS — the action tree could not be resolved:\n\n    ${error.message}\n\n` +
      '  This is not a skip on purpose (defect B22): a check that goes quiet when its dependency\n' +
      '  is unreachable cannot be told apart from one that passed.\n',
  )
  process.exit(1)
}

if (problems.length > 0) {
  console.error(
    `\n[ci] ${bold('A NESTED ACTION IS NOT PINNED')} — an outer pin does not freeze what it calls:\n\n` +
      `${problems.map((problem) => `    ${problem}`).join('\n\n')}\n\n` +
      '  That reference is resolved at RUN TIME, so moving the tag runs new code inside a job this\n' +
      '  repository has already granted a token to. The 40-hex pin in .github/workflows/ does not\n' +
      '  prevent it, and `pnpm check:actions` cannot see it.\n\n' +
      '  Fix: move the outer action to a version that pins its own dependencies, or replace it.\n',
  )
  process.exit(1)
}

console.log(
  `  ${resolved} action references resolved, ${composites} composite action(s) walked — all pinned`,
)

# 003 — Local verify scripts first, GitHub Actions CI later

- **Status:** accepted
- **Date:** 2026-07-05
- **Deciders:** project owner

## Context

`tech-stack.md` §6 names **GitHub Actions** as Waxwing's CI (typecheck, Biome,
unit/component tests, build, `size-limit` budget, Playwright E2E against the pinned
Stalwart image), and P0.5's "Done when" makes that CI the merge gate: *a PR that violates
the size budget or breaks a test cannot merge.*

For now the project stays **local**: there is no GitHub repository, no remote, and no
branch protection to enforce. Standing up GitHub Actions, secrets and required-status-check
rules before there is a repo to attach them to is premature — but the checks themselves
(the same ones a CI would run) are needed today, on every change, so the Definition of Done
and the NFR-PERF-01 size budget are actually verified rather than assumed.

The project owner therefore directed: realize verification as **local test scripts** now
and switch to GitHub Actions later, when the project is further along.

## Decision

Verification is realized as two root scripts — the "CI as a script" — that run the **same
checks** the future GitHub Actions workflow will run:

- **`pnpm verify`** — the fast, hermetic pre-merge gate (no Docker, no browser). Runs
  fail-fast, in sequence: `typecheck` → `lint` (Biome) → `test` (Vitest) → `size`
  (`size-limit`; `size` builds `apps/web` first, so the production build **and** the
  ≤ 300 KB gz critical-path budget are both exercised). Any failure or budget overrun exits
  non-zero.
- **`pnpm verify:e2e`** — the Docker + browser gate. A dependency-free Node runner
  (`scripts/verify-e2e.mjs`) that installs the pinned Playwright chromium, brings the
  Stalwart fixture up (`pnpm e2e:server`, which self-smokes per ADR-002: unauth 200-anon /
  invalid 401 / valid 200), runs the Playwright suite (`pnpm e2e`), and **always** tears the
  fixture down (`pnpm e2e:server:down`) via `try/finally` — a plain `&&` chain cannot
  guarantee teardown when an earlier step fails.
- **`pnpm verify:all`** = `pnpm verify && pnpm verify:e2e`.

This **defers** tech-stack §6's GitHub-Actions CI and the P0.5 "cannot merge" server-side
branch protection. The future GitHub Actions workflow is expected to be a thin wrapper that
simply calls these same scripts, so the checks do not diverge between local and CI.

Also deferred to the eventual CI (unchanged in scope, just not wired now): the scheduled
weekly compat job against the `main` profile (`stalwart:latest`) and README status badges.

## Consequences

- **No server-side enforcement yet.** Nothing mechanically blocks a change that skips the
  gate; correctness relies on contributors running `pnpm verify` (and `pnpm verify:e2e`
  where Docker is available) before committing. This is acceptable while the project is
  local and single-owner.
- **The size budget (NFR-PERF-01) *is* enforced locally.** `pnpm verify` fails on an
  overrun, so the budget is a real gate today, not an aspiration.
- **GitHub Actions + branch protection remain planned, not dropped** — this ADR defers
  them. When a repo exists, add a workflow that runs `pnpm verify` and `pnpm verify:e2e`
  and mark them required; tech-stack §6 stays the target design. Revisit/supersede this ADR
  at that point.
- `implementation-plan.md` P0.5 is re-scoped by the orchestrator to reflect local verify
  scripts instead of a GitHub Actions pipeline; no `.github/workflows` are added in this WP.

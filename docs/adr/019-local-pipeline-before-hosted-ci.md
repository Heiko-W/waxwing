# ADR-019 — A local pipeline now, the hosted workflow written but dormant; `act` rejected

- **Status:** accepted
- **Date:** 2026-08-16
- **Deciders:** project owner
- **Extends:** [ADR-003](003-local-verify-first-ci-later.md) (local verify scripts first, CI later)

## Context

ADR-003 deferred GitHub Actions and made the two `verify` scripts the gate, accepting in writing that
*"correctness relies on contributors running `pnpm verify`"*. That reliance has now cost something
measurable three times over:

- **The Node major is not checked anywhere.** `.nvmrc` pins 24, `engines` says `>=22`, and the
  machine's default is 26 — which defines a global `localStorage` that is `undefined` without
  `--localstorage-file` and shadows jsdom's. On 2026-08-16 that produced 22 test failures with
  nothing wrong in the code, and cost a debugging detour before the cause was found.
- **Defect B22 is still open.** The `@waxwing/jmap` integration suites run in neither `verify` nor
  `verify:e2e`, and they `describe.skipIf` themselves away when the fixture is unreachable. A skip is
  indistinguishable from a pass, so they have never failed — because they have never run.
- **Nothing runs unattended.**

The owner wants a gate now but not a hosted one yet, and asked whether pipelines can be run locally.

On cost, for the record, because it was the stated reason to wait: GitHub-hosted runners are **free
with no minute cap on public repositories**, on every plan, and that survived the January 2026
repricing. Waxwing is AGPL-3.0 and intended to be published, so the eventual CI is expected to cost
nothing; a private repository would draw on the plan's monthly free minutes (~5 minutes per full
run). The reason to defer is that no repository exists yet — not price.

## Decision

**1. A local pipeline: `scripts/ci.mjs`, run as `pnpm gate` / `pnpm gate:fast`.** It stays a thin
sequencer over the same pnpm scripts ADR-003 named, so local and hosted cannot diverge. It adds
exactly what a hand-run script cannot: a preflight that **refuses to run on the wrong Node major**, a
stage that runs the jmap integration suites against a live fixture and **asserts they were not
skipped** (closing B22), and a per-stage summary. `.githooks/pre-push` runs the hermetic half;
`git config core.hooksPath .githooks` enables it, `--no-verify` bypasses it.

**2. `.github/workflows/ci.yml` is written and dormant.** Two jobs — `verify`, then `e2e` — each
calling the same scripts, with `node-version-file: .nvmrc` so the hosted runner cannot repeat the
version trap. It activates the day a repository exists, with no design work left to do.

> **Update 2026-08-17 — it is live**, on github.com/Heiko-W/waxwing. The prediction held: activating
> it took a push, not a design. Two things about it have since changed and are recorded here rather
> than in a new ADR, because ADR-019's own closing section asks for that.
>
> **The jobs run in PARALLEL, not `verify` then `e2e` (2026-08-18).** The staggering was to fail
> cheap before paying for Docker. Measured against six months of runs it was the wrong trade: it
> cost 2:02 on every GREEN run, the common case, and saved the expensive job in 2 of 6 failures —
> free minutes on a public repository, and `.githooks/pre-push` already blocks that whole failure
> class locally. CI wall-clock went 9:20 → ~6:20. Stated cost, in `ci.yml`: a build error now also
> surfaces inside a Playwright webServer as `Rolldown failed to resolve import`.
>
> **One step is not a `pnpm verify` stage (2026-08-18).** `check:actions:deep` walks each pinned
> action's own `action.yml` and asserts a COMPOSITE action pins what IT calls — the gap that let
> `upload-pages-artifact` v3.0.1 reach `actions/upload-artifact@v4`, a movable tag, from a job
> holding `pages: write`. It needs the GitHub API, so folding it into `verify` would put a network
> call in the pre-push hook. It is a script (`scripts/check-action-tree.mjs`), not YAML logic, so
> ADR-003's rule holds: the workflow still only calls pnpm scripts.

**3. Running that workflow locally with `act` is rejected.** Not on taste — on a verified failure
mode. `act` does not nest a Docker daemon; it bind-mounts the host socket, so `docker compose up`
inside a job creates **sibling containers on the host daemon**. The fixture's `./config:/etc/stalwart:ro`
then resolves to `/github/workspace/e2e/stalwart/config`, a path that does not exist on the host —
and Docker does not error: it creates an empty root-owned directory and mounts that. Stalwart boots
with no `config.json` and no diagnostic. That is the same silent-failure class that already cost this
project a debugging session (B29). Secondary: the default runner images lack Chromium's system
libraries (`verify-e2e.mjs` installs without `--with-deps`), `/dev/shm` defaults to 64 MB, and `act`
ignores `timeout-minutes` — so a hung suite runs forever locally but is killed on GitHub, a
divergence in the painful direction. Earthly is frozen (company pivoted); Dagger does not execute
Actions YAML.

## Consequences

- **The gate can be trusted.** A wrong-Node run now stops in second zero with an explanation instead
  of producing 22 failures that look like real ones.
- **B22 is closed for the integration suites**, and closed in the only way that holds: by asserting
  they ran, not by running them. The second half of B22 (`apps/web` resolving `@waxwing/mail-html` to
  a stale `dist/` outside the gate) is untouched and stays open.
- **The pipeline is slower than `pnpm verify` and that is the point.** The full run is ~5 minutes; the
  pre-push hook deliberately runs only the hermetic half, so a push is not held hostage to Docker.
  Anyone touching sync, the fixture or the E2E suites is expected to run `pnpm gate` themselves.
- **Stage isolation had to be paid for.** The integration stage tears its fixture down before the E2E
  stage, because `up` is idempotent and the E2E suites would otherwise inherit a container seeded and
  configured for a different consumer — measured: leaving it up failed two offline specs that pass
  from a fresh fixture. Recreating it costs ~20 s per run, which is the correct price for a stage
  that cannot change the next stage's result.
- **`act` stays rejected until the fixture no longer needs bind mounts**, which is not a change worth
  making for a tool that would still not tell us whether a workflow passes on GitHub.
- ADR-003 is **not superseded**: its verify scripts remain the gate's content, and its statement that
  the hosted workflow will be a thin wrapper is now literally true — `ci.yml` calls the same scripts.

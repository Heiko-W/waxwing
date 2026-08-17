# Contributing to Waxwing

Thank you for considering it. This document is short on ceremony and specific about the two
things that will actually determine whether a change lands: **the gate has to be green**, and
**a test has to fail when the fix is removed**.

## Getting set up

```sh
pnpm install
pnpm --filter @waxwing/web dev      # http://localhost:5173
```

(There is no root `dev` script — the dev server belongs to the web app, and the root is the
workspace.)

Node **24** — `.nvmrc` pins it, and `pnpm gate` refuses to run on a different major rather
than producing a confusing failure. (This is not pedantry: Node 26 adds a global
`localStorage` that shadows jsdom's, and it cost an afternoon of 22 mysterious test failures
before the preflight existed.)

To run against a real server, `pnpm demo` brings up a Stalwart fixture in Docker with seeded
mail and points the dev server at it.

## The gate

```sh
pnpm verify         # typecheck, lint, unit tests, bundle budget, dist contract — hermetic, fast
pnpm gate           # …plus Docker fixture, JMAP integration suites and Playwright
pnpm gate:fast      # the hermetic half only (also wired to .githooks/pre-push)
```

`pnpm verify` is the inner loop and takes a couple of minutes. `pnpm gate` is what a change
must pass before it is proposed; it takes about ten.

Hosted CI runs on every pull request and every push to `main`, in two jobs that start together:

| Job | Runs | Takes |
| --- | --- | --- |
| `verify (typecheck, lint, tests, size)` | `pnpm verify` — the hermetic half | ~2 min |
| `e2e (Stalwart fixture + Playwright)` | `pnpm verify:e2e` — Docker, the JMAP integration suites, six Playwright suites | ~7 min |

Both call the same pnpm scripts the local gate does, which is ADR-003's rule: a workflow that
reimplements a script drifts from it. So there is nothing CI runs that you cannot run here, and
`pnpm gate` is still what a change should pass before it is proposed.

`verify` is a **required check** — a pull request cannot merge while it is red. `e2e` is not
required yet, and that is a deliberate, temporary asymmetry: it touches Docker, a real mail
server and a browser, so it is the job that flakes, and a required check that flakes teaches
people to ignore it. Read it anyway. It is the job that catches what the unit tests
structurally cannot.

## Proposing a change

1. **Fork** and branch from `main`. Branch names are free-form; the commit messages carry the
   meaning here.
2. Run `pnpm gate` (about ten minutes). If it cannot pass locally, say so in the pull request
   and why — a change that needs a second pair of eyes on a failure is welcome; a change that
   quietly hopes CI disagrees is not.
3. Open the pull request. **No approving review is required** — this is a one-maintainer
   project and a mandatory approval would only ever be theatre — but the required check is not
   optional, and a change that touches behaviour without a test that fails when it is reverted
   will be sent back.
4. Describe **what was wrong**, not what you changed. The diff already says what you changed.

For anything large or architectural, open an issue first. Not for permission — to find out
early whether a decision already exists in [`docs/adr/`](docs/adr/) that would send the change
in a different direction.

## What "done" means here

The [Definition of Done](docs/implementation-plan.md) applies to every change:

- TypeScript strict, including `exactOptionalPropertyTypes`. No `any`, no non-null assertions
  to get past a type error — if the type is wrong, fix the type.
- Biome clean. An `ignore` comment needs a stated reason on the line above it.
- **No hardcoded user-visible strings.** Everything goes through i18next, in **both** `en` and
  `de`. `locales.test.ts` will catch a missing key, an invented placeholder or an incomplete
  plural set.
- Keyboard and a11y basics. New interactive surfaces get an axe assertion; see
  [`accessibility.md`](docs/accessibility.md) for what is checked where.
- The bundle budget (≤ 300 KB gz initial JS) still met, with the ≥ 15 % headroom.

## Tests

This is the part worth reading twice.

**A test that cannot fail is worse than no test**, because it reports coverage it does not
have. Before proposing a test, break the thing it tests and watch it go red. If it stays
green, the test is measuring something else than you think.

That is not a slogan here — it is the routine, and it has caught real mistakes in this
codebase:

- A target-size suite that passed while every control was shrunk fourfold (the WCAG spacing
  exception exonerated them; the test now also asserts against the design token).
- A perf test that read 750 rendered rows mid-scroll and called it a leak, when the same page
  at rest held 50.
- A select-all assertion waiting for a button named `/Archive/` — which also matches the
  Archive *folder's* row menu, so it would have passed with nothing selected.

**Write down why a test exists**, not what it does. The code says what it does. The comment
should say which defect it would have caught, and ideally which one it did.

**Do not delete a failing test to make the gate green.** If a test is wrong, fix or remove it
*and say so*. If it is right, the code is wrong.

### Where tests live

| | Runner | Sees |
| --- | --- | --- |
| `*.test.tsx` next to the source | Vitest (jsdom) | components, hooks, stores |
| `*.test.ts` in `packages/*/src` | Vitest (node) | pure logic |
| `*.css.test.ts`, `*.shipped.test.ts` | Vitest (node) | files on disk — CSS, deployment files |
| `e2e/tests/*.spec.ts` | Playwright + live Stalwart | anything needing a real engine |

The split is not stylistic. **jsdom computes no layout and has no canvas**, so it cannot see a
contrast ratio, a button's size, or whether a scroll container is bounded — three defect
classes that have each shipped here behind a full green suite. If a claim is about geometry or
colour, it belongs in `e2e/`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Scopes: `web`, `jmap`,
`mail-html`, `jscontact`, `sync`, `e2e`, `docs`, `ci`.

Write the body for someone who will read it in a year while wondering why a line is the way it
is. What was wrong, what it cost, why this fix and not the obvious one. "Fix bug" is not a
commit message; neither is a restatement of the diff.

## Architecture decisions

A deviation from the spec, the tech stack or the plan is recorded as an ADR in
[`docs/adr/`](docs/adr/) — **never silently**. Copy an existing one for the shape. The ones
worth reading first, because they explain constraints that will otherwise look arbitrary:

- **ADR-003** — why verification is local before it is hosted.
- **ADR-018** — why the sync engine is keyed by account (short mailbox ids collide between
  accounts, which is the central correctness hazard in this codebase).
- **ADR-020** — why send-as from a delegated account is not offered (the server refuses it;
  probed live).
- **ADR-021** — why Undo is a chord plus a toast that does not expire.

## Reporting bugs

Include what you did, what happened, what you expected, plus your browser and mail server with
versions. For anything involving message rendering, **a `.eml` file is worth a thousand words**
— it is the only way to reproduce a sanitizer or layout problem exactly.

Security issues do **not** go in the issue tracker. See [`SECURITY.md`](SECURITY.md).

## Licence

App code is **AGPL-3.0-only**; `packages/jmap` and `packages/jscontact` are **MIT** so they can
be used by clients that are not themselves AGPL. Contributions are accepted under the licence
of the directory they touch. If a change belongs in a package, please put it there rather than
in the app — that boundary is what keeps the JMAP client reusable.

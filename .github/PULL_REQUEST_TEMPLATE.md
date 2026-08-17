## What this changes

<!-- What was wrong, and what this does about it. If it fixes an issue, link it. -->

## How it was verified

<!--
The house rule (CONTRIBUTING.md): a test has to FAIL when the fix is removed.

Please say which test covers this and what happens when you revert the fix while keeping the
test. "All tests pass" does not answer that question — a test that cannot fail is worse than
no test, because it reports coverage it does not have.

For anything about geometry, colour or layout: those belong in `e2e/`, because jsdom computes
no layout and has no canvas. It cannot see a contrast ratio or a button's size.
-->

- [ ] `pnpm verify` passes
- [ ] `pnpm gate` passes (needs Docker — say so if you could not run it)
- [ ] A test fails when the fix is removed
- [ ] User-visible strings go through i18next in **both** `en` and `de`

## Anything you are unsure about

<!--
Genuinely useful, and not a formality. An unresolved question here is much cheaper than one
found after merge — and "I could not run the Docker suite" or "I am not sure this is the right
layer" is exactly the kind of thing worth writing down.
-->

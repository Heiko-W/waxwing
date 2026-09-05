# 045 — A Tab walk has to be anchored, because `document.body.focus()` moves nothing

- **Status:** accepted
- **Date:** 2026-09-05
- **Work package:** the red e2e gate on the v0.23.0 release PR (#73), which changed only version
  numbers and prose
- **Relates to:** `e2e/tests/focus-visible.spec.ts` (`tabStops`, `sweep`),
  `e2e/tests/target-size.spec.ts` (the reading-pane test), `apps/web/src/ui/use-toolbar-roving.ts`,
  `apps/web/src/mail/MessageView.tsx` (`bodyReady`),
  `apps/web/src/settings/SettingsPage.tsx` ("focus follows the navigation"), B6, ADR-031

## Context

The release PR's `read` suite failed three tests that the previous content PR had passed on
identical application code. Two of them were the B6 focus sweep saying it "never reached" a control
that was plainly on the screen — `Reply` on the reading pane, `Offline & storage` in settings — and
failing all three retries for settings while passing them for reading. A second green run would have
proved nothing, so the walk itself was measured.

### `document.body.focus()` is a no-op

`tabStops` opened with `await page.evaluate(() => document.body.focus())`, standing for "go back to
the top and Tab from there". In Chromium `<body>` is not a focusable area, so `focus()` returns
having done nothing. Measured in the live fixture: `(document.body.focus(), document.activeElement
=== document.body)` is **`false`**, on every screen this suite visits.

Every sweep therefore began wherever the test's last click had left the focus and ran to the end of
the document. It had never once walked a whole Tab order:

| screen | stops recorded | stops the order has |
|---|---|---|
| list | 11 | 24 |
| reading | 5 | 28 |
| composer | 5 | 37 |
| dark | 11 | 24 |

The header, the account menu, the main navigation and the folder tree were unmeasured on every
screen whose test had already clicked past them. `MAX_TAB_STOPS = 60` was never the limit and the
"the order has wrapped" break never fired — the walk simply started three quarters of the way down
and stopped at the end.

### Why it failed on that run and not the one before

Chromium's *sequential focus navigation starting point* is not `document.activeElement`, and
re-renders the test does not control reset it. `SettingsPage` moves focus into the opened panel
(`sectionRef.current?.focus()`, "focus follows the navigation"); from there the first Tab went to
the **top of the document** on an idle machine and stayed **inside the panel** on a loaded one.
Reproduced deterministically by driving the unmodified test at
`Emulation.setCPUThrottlingRate: 8`: 27 stops beginning at "Skip to content" unthrottled, 3 stops
beginning inside the storage panel throttled — which is exactly the array the hosted runner printed,
`["button", "Free up space now", "7 days30 days…"]`.

So the assertion was reading a coin toss. It had been reading one since the file was written; the
extra folder and the 1 200-message batch the fixture gained for ADR-044 only pushed the runner far
enough for the coin to land the other way.

### The reading pane was a second, independent defect in the same file

`Reply`, `Reply all` and `Forward` carry the native `disabled` attribute until `bodyReady`
(`!loading && ready`) — the gate that stops a reply being seeded from an unsanitized body. A
natively disabled button is not a tab stop, and `useToolbarRoving` skips it on purpose
(`button:not(:disabled)`), so in that window the action bar's single tab stop is "Move to Trash".
Both tests waited for `toBeVisible`, which is true throughout it.

This is not the overflow menu and not the sidebar: `useActionOverflow` was showing all four primary
actions plus the `⋯` at 1440 px in both the failing and the passing runs, and a folder added to the
tree makes the sidebar longer, never wider. **There is no product defect here** — the disabled
window is deliberate, documented and correct.

`target-size.spec.ts` had the same hole with a sharper consequence: `targets()` skips anything
carrying `disabled`, and **every recorded CI run, green ones included**, reported the reading action
bar as "Details, Move to Trash, More actions". Three of the five controls that test names in its own
title had never been measured on the hosted runner, and the log said so for weeks.

## Decision

**1. The walk is anchored.** `<body>` is given `tabindex="-1"` for the length of the walk, focused,
and the attribute removed afterwards. A `tabindex` makes it a focusable area, and the same `focus()`
then does what the line always claimed. Deterministic on any machine, at any throttle.

**2. A sweep asserts where it started.** `sweep()` now requires the first stop to be `Skip to
content` — the one control whose entire purpose is to be first — beside the existing `mustReach`
guard that says it got far enough. By name rather than by count, for the reason `mustReach` already
gives: a count cannot tell "did not start at the top" from "one control fewer in this build".

**3. A cycle is detected by element identity, not by name.** The old break was "a `tag:name` we have
already seen", which a message list with six checkboxes called "Select message" satisfies at the
second row. A `WeakSet` in the page answers the question actually being asked.

**4. Both reading-pane tests wait for `toBeEnabled`, not `toBeVisible`.** The precondition is the
gate the product sets, so the sweep measures a screen that exists rather than one still loading.

## Consequences

- **The sweep now measures 2–7× more.** 24 stops on the list, 28 on reading, 37 in the composer, and
  24–27 in settings, whose rail carries capability-gated sections that come and go with what earlier
  tests left on the server. No new WCAG failure surfaced — the weakest ring across the newly covered chrome is
  4.68:1 against a 3:1 bar — so this closes a coverage hole rather than opening a defect list. The
  `EXEMPT` map stays empty and its staleness test stays green.
- **`target-size` now measures Reply, Reply all and Forward** on the reading pane; all three are
  34 × 34, as the rest of the bar is.
- **Mutation-proven, each half separately.** Removing the `tabindex` turns five of the six sweeps
  red with "did not start at the top of the document" (settings stays green on an idle machine —
  which is the timing-dependence, reproduced). Keying the cycle on the name instead of the element
  turns the composer red, because two of its controls share a name. Guarding the reading pane with
  `toBeVisible` while the body fetch is held back reproduces the CI failure verbatim: 27 stops
  ending "… Details | Move to Trash", `Reply` never reached; `toBeEnabled` reaches it.
- **A stray `tabindex` on `<body>` would be a finding of its own**, so the walk removes it in a
  `finally` rather than at the end of the loop.
- **Not changed:** the reading pane's `bodyReady` gate, `useActionOverflow`, and the fixture. The
  bulk folder is innocent; it made a latent defect likely enough to see.
- **Still open, and pre-existing:** `a11y.spec.ts`'s "reading pane" scan takes **39.1 s** on the
  hosted runner, in every run back to at least 2026-09-02, and **39.0 s on this machine** — light
  and dark alike, while every other screen in that file takes under two seconds. A duration that
  does not move with the hardware is a fixed internal wait, not load; the likeliest candidate is
  axe-core waiting out its frame timeout on the message body's sandboxed frame, which cannot run
  the script axe injects. On the failing run it exceeded the 180 s test timeout once and took the
  browser context with it (`browserContext.newPage: Protocol error (Target.createTarget)`), then
  passed on retry. Recorded here rather than fixed: it is neither this defect nor caused by it, and
  the margin is thin enough to be worth someone's afternoon.

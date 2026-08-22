# 029 — Safari cannot intercept clicks in a sandboxed frame, so the phishing gate decides before the click

- **Status:** accepted
- **Date:** 2026-08-22
- **Work package:** M5.15 — Safari/WebKit defects reported from production
- **Relates to:** tech-stack §4.5 step 3 (the interception this changes), FR-RD-08 (the deceptive-link
  interstitial), NFR-SEC-01 (the CSP/sandbox layering), ADR-008 (the shared replica whose `akw` index
  the second defect below reads)

## Context

Two defects were reported on 2026-08-22 from `mail.hcw-orange.media`, both Safari-only, both
invisible to the entire test suite. They share one cause behind them: **every automated test in this
repository runs on Chromium**, and Chromium and WebKit disagree in exactly the two places these
defects lived.

Everything below was measured on 2026-08-22 against Playwright's WebKit 2311 and Chromium side by
side, on the live fixture — not read off documentation.

### 1. No link in a message opened

Clicking a link in a message did nothing at all: no navigation, no new tab, no dialog. The app opens
links from a click listener the outer page installs on the frame's document (tech-stack §4.5 step 3).

> **A click inside a sandboxed frame is not observable from the outer page in WebKit — at all.**

Not on the frame's `document`, its `documentElement`, its `body`, its `defaultView`, nor on the
anchor itself; not bubbling and not capturing; not as `click`, `mousedown`, `pointerdown` or
`auxclick`. The identical frame with **no** `sandbox` attribute delivers every one of them, and
Chromium delivers all of them either way.

So the interception never ran on Safari, and neither did anything downstream of it — including the
FR-RD-08 interstitial. Reaching into the frame's DOM works in both engines; only *events* are
withheld.

Two further measurements bound what can replace it:

| route out of a sandboxed frame, WebKit | result |
| --- | --- |
| outer page calls `window.open` after the click | blocked |
| outer page clicks a synthetic `<a target="_blank">` | blocked |
| native `target="_blank"` navigation, sandbox without `allow-popups` | blocked |
| native `target="_blank"` navigation, sandbox with `allow-popups` | **opens** |
| …with `allow-popups` only | opens a tab that inherits the sandbox — no `allow-scripts`, destination renders blank |
| …with `allow-popups allow-popups-to-escape-sandbox` | opens an ordinary page |

### 2. The mail screen did not render at all for an empty mailbox

An admin login showed "part of the app could not be loaded" over the whole screen, folder tree
included. The error was not a chunk load at all — every asset was served, verified against the
deployment — but a `DexieError` out of the `<Labels>` component, which the route boundary reports
with the chunk wording whatever the cause.

`distinctKeywords` read the account's slice of the `akw` multiEntry index with Dexie's
`uniqueKeys()`, which opens the key cursor with direction `nextunique`:

| multiEntry index | direction | WebKit | Chromium |
| --- | --- | --- | --- |
| empty | `nextunique` | **`UnknownError: Unable to open cursor`** | ok, zero keys |
| empty | `next` | ok, zero keys | ok, zero keys |
| populated | `nextunique` | ok | ok |
| populated | `next` | ok | ok |

An empty slice is not an edge case: it is every account's first paint, before the first sync writes a
message — and a mailbox that never receives mail has one permanently. That is why the reporter saw
it on the admin account and not on their own.

## Decision

### 1. The gate decides which links the browser is handed, before any click

`mountMailFrame` gains `gateLink`, asked **once per link when the document loads**:

- **released** (`false`) — the frame rewrites the href to its absolute form, adds
  `target="_blank" rel="noopener noreferrer"`, and the browser opens it. The click listener steps
  aside for such a link in engines that do fire it, so both engines behave identically.
- **kept** (`true`, and a missing callback) — no `target` is written, and the click is intercepted
  exactly as before.

The app releases a link only when `classifyLink` says the text claims no host or the host it claims
is honoured. `mailto:`/`tel:` are never released — they have no web URL to hand the browser — so the
app still opens them itself.

The sandbox becomes `allow-same-origin allow-popups allow-popups-to-escape-sandbox`. Neither popup
token grants the *message* anything: no script runs in the frame, so nothing can open a window the
reader did not click. `allow-scripts`, `allow-top-navigation` and `allow-forms` remain absent, and
the inner CSP is unchanged.

**Why a decision and not a veto.** A veto is a `preventDefault()` in a listener WebKit never calls.
It would pass every test here and protect nobody on Safari — which is precisely the failure mode
this ADR exists to end, so it is not enough for the gate to be correct on the engine we test.

**What this deliberately places in the frame's DOM rather than the sanitizer's output.** The `target`
is written by the same code path that installs the listener, so a link the browser can open by itself
never exists without the gate having seen it. In a runtime where `contentDocument` is unreachable,
neither happens and every link keeps the old interception.

### 2. `distinctKeywords` deduplicates in JS

`keys()` (direction `next`) plus a `Set`, instead of `uniqueKeys()`. The cost is one key per
(message × keyword) pair over the account's replica window rather than one per distinct keyword —
a key cursor with no row loads, over a windowed subset.

### 3. A WebKit smoke suite exists, and stays small

`e2e/playwright.webkit.config.ts` + `tests/webkit.spec.ts`, on the read suite's fixture and corpus:
the mail screen renders, an honest link opens a tab, a deceptive link opens nothing. Anything that
behaves identically in both engines belongs in the Chromium suites, which are faster and already own
it.

## Consequences

**A deceptive link on Safari does nothing, and says nothing.** The interstitial needs a click event
to raise it, which is what WebKit withholds. The reader is not sent to the attacker — the safe
outcome, and an improvement on the previous state where *no* link worked — but they are also not told
why this one link is inert. Closing that gap means moving the warning into the frame's own DOM, where
it can be rendered without a click; that is a UI decision with its own trade-offs and is deliberately
not taken here.

**A released link cannot be recalled.** Once the browser owns the navigation there is no afterwards.
That moves the whole weight of FR-RD-08 onto `classifyLink` running at load time on text that cannot
subsequently change (the frame runs no script), which is why `gateLink` is documented as
irreversible at its definition.

**tech-stack §4.5 step 3 no longer describes what happens.** Links are not "intercepted and
re-dispatched with `noopener`" in general; they are classified at load, and only the kept ones are
intercepted. The `noopener`/`noreferrer` isolation is unchanged — it moved from the `window.open`
call to the anchor's `rel`.

**One test-suite assumption is now explicit.** "It passes CI" has meant "it passes on Chromium" for
the whole life of this project. The smoke suite makes the second engine visible but does not make it
covered; a Safari-only defect outside those three tests would still ship.

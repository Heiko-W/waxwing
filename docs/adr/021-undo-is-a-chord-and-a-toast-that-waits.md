# ADR-021 — Undo is a chord (`z`) plus a toast that does not expire

- **Status:** accepted
- **Date:** 2026-08-16
- **Work package:** M4.7 (Accessibility hardening) — WCAG 2.1.1 Keyboard, 2.2.1 Timing Adjustable
- **Method:** read Bulwark's behaviour, then decided against it; user chose between two options

## Context

Triage (archive / junk / trash / move) raises a toast that offers **Undo**. Two things made that
offer keyboard-inaccessible:

1. The toast region is portalled to the **end of the document**. Reaching the Undo button by <kbd>Tab</kbd>
   means traversing the entire shell — sidebar, list, reading pane.
2. The toast auto-dismissed after the 5 s default. Nobody completes (1) in five seconds.

Together: Undo was a **pointer-only** affordance. That fails WCAG 2.1.1 (Keyboard) outright, and the
timer fails 2.2.1 (Timing Adjustable), which requires a time limit to be turn-off-able, adjustable,
or extendable before it expires.

**What Bulwark does** does not resolve it. Bulwark's snackbar is a `MudBlazor` snackbar with the same
structural problem — appended late in the DOM, timed out — and it offers no undo chord at all. The
reference answered `?account=` (ADR-018's routing question) but has nothing to teach here.

## Options considered

1. **Focus the toast on appearance.** Rejected: stealing focus mid-triage is worse than the bug. The
   user is working through a list; yanking focus out of it breaks the very flow triage exists to
   support, and moves focus without user intent (a 3.2.x smell).
2. **Move the toast region to the top of the DOM.** Rejected: it fixes tab distance but not the
   5 s timer, and the region's position is load-bearing for screen-reader announcement order.
3. **Undo chord + persistent toast** — chosen by the user.

## Decision

- <kbd>z</kbd> runs the action of the **newest action-bearing toast**. `ToastProvider` exposes
  `runNewestAction(): boolean` for this; the registry's `triage.undo` entry calls it and, on `false`,
  notifies `shortcuts.unavailable.undo` ("Nothing to undo.") rather than failing silently.
- A toast that **carries an action** is raised with `duration: 0` — it stays until it is used or
  dismissed. A toast with nothing to act on keeps the 5 s default; there is nothing to miss.

`z` is deliberately **always enabled**. Whether an undo is pending is not knowable from the shortcut
context (the toasts live in their own provider), and a chord that appeared and vanished on a timer
would be worse than one that occasionally reports "nothing to undo".

`runNewestAction` skips over toasts that carry no action rather than giving up at the newest one —
otherwise a status message pushed on top of an undo offer would swallow the chord exactly when it is
needed.

## Consequences

- `ShortcutContext` gains `runNewestToastAction()`. Like `notify`, it is **passed in** by
  `ShortcutProvider` (which sits inside `ToastProvider`) rather than read via `useToast()` in
  `use-shortcut-context.ts` — that file is a pure reader and must not throw where no toast host is
  mounted.
- Undo offers now accumulate on screen until acted on or dismissed. Acceptable: triage raises at most
  one per action and each carries its own Dismiss.
- Verified by mutation: eight mutations (oldest-first, ignore-action, always-true, no-dismiss, no
  `duration: 0`, always `duration: 0`, silent failure, wrong key) each turn a test red.

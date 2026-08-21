# 025 — Reordering filter rules uses pointer events, and has a keyboard path that is not a fallback

- **Status:** accepted
- **Date:** 2026-08-21
- **Work package:** JMAP gap analysis wave 1 — B-4
- **Relates to:** ADR-012 (HTML5 DnD for the message/folder drag), ADR-013 (the row swipe),
  ADR-023 (foreign Sieve is preserved, never parsed)

## Context

In Sieve, **the order of the rules is part of what they mean.** A rule carrying `stop` ends
processing and everything below it never runs; two rules filing into different folders are decided
by whichever comes first. The rule builder shipped in M5.2 could append and delete, and nothing
else — so the only way to correct an order was to delete rules and type them in again, and the
first `stop` in a list quietly disabled everything after it with no way to move it.

Two mechanisms were available, and ADR-012 already picked one for the *other* drag in this app.

## Decision

**The grabber is dragged with pointer events, not HTML5 drag & drop — and the same operation is
reachable from the keyboard without dragging anything.**

Concretely (`RuleList.tsx`):

- Each row carries one grabber at its trailing edge, the position an iOS list puts it in. It is the
  only drag surface on the row: pressing the rule name is still just pressing the rule name.
- `pointerdown` on the grabber begins the reorder, `pointermove` on `window` reorders the list live
  by comparing the pointer against the rows' mid-heights, `pointerup` commits. `pointercancel` —
  the browser taking the gesture — abandons it, exactly as the row swipe treats it (ADR-013).
- `touch-action: none` is set on the grabber and nowhere else. It is the load-bearing declaration:
  once the compositor has claimed a touch as a scroll, no `preventDefault()` in any handler can
  take it back. Scoping it to the grabber keeps a rule list taller than the screen scrollable.
- No `setPointerCapture`: it does not exist in this jsdom (ADR-013 records what that cost
  `SplitPane`), and listeners on `window` removed on every exit path do the same job.
- **The keyboard path is a peer, not a courtesy.** Focus the grabber, Space picks the rule up
  (`aria-pressed`), Up/Down move it, Space drops it, Escape puts it back. A polite live region
  announces "*Name*, rule 2 of 4" after every move, because a grabber announces nothing by itself.
- One save per drop. A drag across four rows writes the script once.

## Why not HTML5 DnD, which ADR-012 chose

ADR-012's decision was **use HTML5 DnD and add no pointer-events drag**, for two reasons, and
neither of them exists here:

1. *A pointer drag on a message row would collide with the swipe, and the only signal that could
   separate them (`pointerType`) is unavailable to the drag side.* There is no swipe in Settings,
   and the drag starts from a dedicated 44 px control rather than from the row.
2. *Touch already reaches the same capability by other paths* — the swipe, the `v` chord, the
   "Move to…" dialogs. Here there is no other path at all: without this, order cannot be changed on
   any device, by any means.

And ADR-012's own correction records the fact that decides it: **Firefox for Android initiates no
drag from touch whatsoever** (Bugzilla 1764177, open), and Chrome-Android and iOS Safari need a
long-press. For a message move that is tolerable, because three non-pointer equivalents exist. For
the only way to express Sieve's evaluation order it is not: phone and tablet are first-class
targets, and "reorder your filters on a desktop" is not an answer.

This ADR therefore does not supersede ADR-012. Both stand: the mechanism follows from what else is
on the element and from whether a non-pointer path already exists.

## Consequences

- **WCAG 2.2 SC 2.5.7 (Dragging Movements) is met by construction**, not by a separate feature: the
  keyboard path performs the identical operation through the identical function.
- **The drag itself is not unit-testable.** jsdom has no layout engine, so every
  `getBoundingClientRect()` there is zero and the geometry cannot be exercised. What is testable is
  split out and tested: `moveItem` (the reorder) and `dropIndex` (the pointer arithmetic) are pure
  functions in `rule-model.ts`, and the keyboard path runs end to end in `filters.test.tsx`. The
  drag proper is covered in `e2e/tests/settings.spec.ts`, in a real engine, with a mouse.
- **A 4 px slop before the first move.** Without it a plain click reorders: `dropIndex` answers with
  a real index on the first `pointermove`, and a mouse moves a pixel or two between press and
  release.
- **The rows swap under the finger; the dragged row does not float.** There is no absolutely
  positioned ghost. It is less showy than a lifting card and it needs no second geometry model, and
  the row under the pointer is marked with elevation so the eye can follow it.
- ADR-023 is untouched and is pinned by a test that says so: reordering rewrites the whole script,
  and a foreign script has to come back byte for byte, in its original position, afterwards.

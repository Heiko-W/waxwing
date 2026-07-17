# 012 — Drag & drop (FR-MBX-03) ships desktop-only; touch is served by swipe + the non-pointer paths

- **Status:** accepted
- **Date:** 2026-07-17
- **Deciders:** M3.9 implementer. Forced by a platform fact (HTML5 DnD does not fire from touch),
  not an owner trade-off — the alternative (a pointer-events drag) is ruled out by the same
  document that requires the swipe, and the touch capability it would add already exists via other
  paths.

## Context

FR-MBX-03 (**Should**) asks for two drag gestures:

> **FR-MBX-03 (Should)** — Drag & drop messages onto folders; drag folders to re-parent.
> — functional-specification §155

Neither the spec nor the plan carries a platform qualifier. The plan (§M3.9, 5b) prescribes the
mechanism — **HTML5 drag & drop**, not pointer events — with this justification:

> HTML5 DnD (not pointer events — they would fight the swipe below; the two are separated by
> `pointerType`).

Two things about that sentence are load-bearing here, and one of them is wrong.

**The mechanism choice is right, the stated reason is imprecise.** A `DragEvent` extends
`MouseEvent`, not `PointerEvent` (`lib.dom.d.ts`), and `pointerType` is declared **only** on
`PointerEvent`. A `dragstart`/`dragover`/`drop` handler has no `pointerType` to read. The
separation between the drag (5b) and the swipe (M3.9 step 5) is therefore **one-directional**: only
the swipe can filter `pointerType !== 'touch'`; the drag cannot check anything and relies on the
browser not initiating a drag from touch in the first place.

**And it does not.** HTML5 drag & drop does not fire from a touch on iOS Safari (and is
unreliable-to-absent from touch on Android browsers) without a pointer-events polyfill. So the
message-drag and folder-re-parent-drag are, by the nature of the API chosen, **desktop/mouse
gestures**. This was not written down anywhere in the repo, and shipping a *Should* as
platform-restricted without a record is exactly the silent drift `CLAUDE.md` forbids.

## Decision

**5b ships desktop-only, deliberately, and this ADR is the record.** We do not add a pointer-events
drag to reach touch.

The touch story is covered without it:

- **Moving a message on touch** is the swipe (M3.9 step 5, FR-LST-06) — swipe-to-archive/trash,
  Apple-Mail parity — plus the `v` chord and the bulk-bar "Move to…", both of which work under a
  touch keyboard / tap.
- **Re-parenting a folder on touch** is the folder "Move to…" dialog (5a), reachable by tap.

WCAG 2.2 **SC 2.5.7 Dragging Movements** is satisfied regardless of platform: 5a delivered three
non-pointer equivalents — the `v` chord (`registry.ts` `triage.move`), the bulk-bar Move
(`MessageList`), and the folder "Move to…" action (`FolderTreeView`). SC 2.5.7 requires every drag
to have a non-pointer equivalent, **not** the reverse, so a desktop-only drag on top of complete
non-pointer paths is conformant.

## Alternatives rejected

- **A pointer-events drag, to make the gesture work on touch too.** Rejected on the plan's own
  reasoning: pointer events on a message row would collide with the swipe (step 5), which is itself
  a pointer gesture on the same element — the two would have to be told apart, and the only signal
  that separates them (`pointerType`) is unavailable to the drag side. It would also add a second,
  parallel move path for a capability touch users already have via swipe and the dialogs. More
  surface, more collision, no new user capability.
- **A drag-and-drop polyfill for touch.** A dependency (bytes against the 300 KB budget) to add a
  redundant gesture. Not worth it for a *Should* whose intent is already met on touch.

## Consequences

- Drag & drop is a mouse affordance. The E2E for it run under Chromium with a mouse; there is no
  touch-drag test because there is no touch-drag behaviour to assert.
- **Open probe for step 5, noted here so it is not forgotten:** whether Chrome-on-Android initiates
  a drag from a long-press on `draggable="true"` decides whether a touch long-press could enter
  *both* a drag and a swipe once the swipe lands — a genuine two-gesture collision on one device
  class. This project live-probes exactly this kind of assumption (see the M3.9 step-0 header
  probe); probe it before step 5, not before 5b.
- If touch drag is ever genuinely wanted, it is a new WP with its own ADR superseding this one, not
  a quiet addition.

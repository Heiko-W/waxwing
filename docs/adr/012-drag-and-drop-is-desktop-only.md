# 012 — Drag & drop (FR-MBX-03) uses HTML5 DnD, not pointer events; touch is served by swipe + the non-pointer paths

- **Status:** accepted — **amended 2026-07-19, and the original title was wrong** (it read
  "ships desktop-only"). The decision below stands; the platform claim it rested on does not.
  See **Correction (2026-07-19)**.
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

> ⚠️ **The next paragraph is FALSE.** It is kept verbatim so the correction below has something to
> point at. Do not cite it. See **Correction (2026-07-19)**.

**And it does not.** HTML5 drag & drop does not fire from a touch on iOS Safari (and is
unreliable-to-absent from touch on Android browsers) without a pointer-events polyfill. So the
message-drag and folder-re-parent-drag are, by the nature of the API chosen, **desktop/mouse
gestures**. This was not written down anywhere in the repo, and shipping a *Should* as
platform-restricted without a record is exactly the silent drift `CLAUDE.md` forbids.

## Decision

~~**5b ships desktop-only, deliberately, and this ADR is the record.**~~ — the *platform* half of that
sentence is false (see **Correction (2026-07-19)**): 5b has been live on touch since it shipped. What
survives, and is the actual decision, is: **we use HTML5 DnD and do not add a pointer-events drag or a
polyfill to reach touch.**

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

- The E2E for the drag run under Chromium with a mouse. ~~There is no touch-drag test because there
  is no touch-drag behaviour to assert.~~ — see the correction below: there *is* touch-drag
  behaviour on two of the three engines, it is simply not covered by our tests.
- If a *pointer-events* drag is ever genuinely wanted (the only thing that would reach Firefox for
  Android), it is a new WP with its own ADR superseding this one, not a quiet addition.

## Correction (2026-07-19) — the platform claim above is false

The Context section asserts:

> **And it does not.** HTML5 drag & drop does not fire from a touch on iOS Safari (and is
> unreliable-to-absent from touch on Android browsers) without a pointer-events polyfill.

**That is wrong on both counts.** It was written from memory, never probed, and the open probe this
ADR itself scheduled for step 5 is what caught it. Established from engine source and vendor
announcements while preparing M3.9 step 5:

- **Chrome on Android starts a drag from a long-press on `draggable="true"`, by default, since
  Chrome 100 (June 2022).** Two features gate it, both `FEATURE_ENABLED_BY_DEFAULT` on Android:
  `kTouchDragAndDrop` (`ui/base/ui_base_features.cc`) and `kTouchDragAndContextMenu`
  (`content/public/common/content_features.cc`). Blink's own setting comment says it outright:
  "If enabled, the user can initiate drag using long press" (`core/frame/settings.json5`). The old
  `--enable-touch-drag-drop` switch was *removed* — there is no flag to turn it off.
  Entry point: `GestureManager::HandleGestureLongPress` (`core/input/gesture_manager.cc`).
  On phones the drag is suppressed for links, images and media in favour of the context menu; on
  tablets everything drags and `contextmenu` fires *alongside* `dragstart` (a known, unfixed
  Chromium wart).
- **iOS/iPadOS Safari does it too**, via a `UIDragInteraction` long-press lift routed through
  `EventHandler::tryToBeginDragAtPoint` — iPad since iOS 11, iPhone since iOS 15.
- **Firefox for Android is the sole engine with no touch-initiated drag at all** (Bugzilla 1764177,
  still open). Gecko synthesizes a touch-drag only on Windows, and only from a double-tap.
- Neither `touch-action` nor `user-select` can prevent a touch drag. The one thing that does is
  `preventDefault()` on `touchstart` — which we must therefore never do on a row.

So the drag shipped in 5b (`770182b`) has been **live on Chrome-Android and iOS Safari all along**,
untested, rather than desktop-only.

**A local probe under Playwright's touch emulation found no `dragstart`** — not at 800 ms hold, not
on a tablet viewport, not with `--enable-features=TouchDragAndDrop,TouchDragAndContextMenu`, not via
`Input.synthesizeTapGesture`, while a mouse-drag positive control fired reliably. That result is
recorded here as **a limitation of the emulation, not evidence about Android**: the Android path is
entered from a synthesized `kGestureLongPress` in a gesture pipeline that desktop Linux Chromium does
not run. Emulated touch cannot answer this question; only a real device can.

### What follows from the correction

The decision is unchanged — we still use HTML5 DnD and still add no polyfill — but the *reason* the
drag and the swipe do not collide is now a mechanism rather than an absence:

1. **The two gestures separate themselves.** A long press without movement enters the drag; movement
   past the tap slop cancels the pending long-press and arms the swipe instead.
2. **`pointercancel` is the hand-off.** Pointer Events L4 §5.1.3.3 *requires* a `pointercancel` on
   the pointer that started a drag, and Blink implements it for touch (`SuppressPointerStreamAfterDrag`,
   stable). Live-verified locally: a mouse drag emits `pointerdown > pointermove > dragstart >
   pointercancel > drag … > dragend`. The swipe treats `pointercancel` as "abandon", so a drag taking
   over cannot leave a row stranded mid-swipe.
3. **A guard makes it explicit anyway**, rather than relying on (1) and (2) holding on every engine:
   `onDragStart` in `MessageList.tsx` begins with
   `if (swipe.isSwipeActive()) { event.preventDefault(); return }`.

   The predicate is the load-bearing part. `isSwipeActive()` is `gestureRef.current?.direction != null`
   (`use-swipe.ts`) — **a swipe that has locked an axis**, deliberately *not* "a finger is down".
   A long press without movement never locks an axis, because it never moves; that press is exactly
   how Chrome-Android and iOS Safari enter a drag. A guard on "a pointer is down" would therefore
   return `true` from the first `pointerdown` on every row and cancel **every** touch drag in the app —
   the precise opposite of the coexistence decided above. The two gestures divide by what the finger
   DOES: hold still and the drag takes it, move sideways past the slop and the swipe does.

   `preventDefault()` rather than a bare `return`: without it the browser leaves a drag running whose
   `dataTransfer` was never populated.

   This is unit-testable in jsdom — `use-swipe.test.tsx` asserts `isSwipeActive()` is `false` at
   `pointerdown` and after a vertical (scroller-won) move, and `true` only once the axis locks — which
   discharges the open probe **in code**, the thing we can actually verify, instead of in a browser we
   cannot run here.

Owner decision (2026-07-19): **coexistence, plus the guard** — touch drag is left working rather than
switched off. On a tablet the folder tree is on screen and the drag is genuinely useful; switching it
off would need a `matchMedia('(pointer: fine)')` gate, which is untestable under this jsdom
(`matchMedia` is undefined) and would be exactly the unverifiable-environment-logic that gap **B5**
already tracks.

**Still unverified, and honestly so:** nobody has run this on real Android or iOS hardware. The
engine-source evidence is strong and the guard is defensive, but the *behaviour* on a device remains
untested. That is a coverage gap, not a resolved question.

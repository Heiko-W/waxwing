# 013 — Row swipe uses pointer events, commits only on a full swipe, and never destroys

- **Status:** accepted
- **Date:** 2026-07-19
- **Deciders:** M3.9 step 5 implementer; owner decisions of 2026-07-16 (Apple parity, per-direction
  configuration) and 2026-07-19 (commit-only; drag/swipe coexistence — see ADR-012 as amended).

## Context

FR-LST-06 (**Should**) asks for swipe gestures on touch with configurable archive / delete / read
actions. The plan (§M3.9 step 5) fixes the defaults by Apple-Mail parity — right = mark read,
left = archive — and requires the gesture to route through `use-triage.ts` so that a swipe, a button
and a keystroke are one code path.

Several mechanism choices were **forced by the platform rather than chosen**, and are recorded here
because a future reader would otherwise reasonably try the obvious alternative and fail slowly.

## Decision

### Pointer events, never touch events

React 19 registers `touchstart`/`touchmove`/`wheel` as **passive** listeners
(`react-dom-client.development.js`), so an `onTouchMove` handler can never call `preventDefault()`.
Pointer events are not in that list. `pointerType` is also the only touch/mouse discriminator that
needs no stub under this jsdom — `matchMedia` and `navigator.maxTouchPoints` are both `undefined`
there, and gating on either would have made every list test carry an environment stub.

### No `setPointerCapture`, ever

It does not exist in this jsdom — which is why `SplitPane`'s pointer drag is tested only through its
keyboard path: `fireEvent.pointerDown` on it throws. Using capture would have made the swipe equally
untestable. `pointermove`/`pointerup`/`pointercancel` are attached to `window` for the life of the
gesture instead, and removed on every exit path.

### Two independent mechanisms separate a swipe from a scroll

1. **`touch-action: pan-y` on the row wrapper.** This is the *only* thing that actually prevents
   scrolling in a browser; once the compositor has claimed the gesture, `preventDefault()` on a
   `pointermove` does nothing. When the browser takes the scroll it fires `pointercancel` at us,
   which the swipe treats as "abandon".
2. **A JS axis lock** (`SWIPE_SLOP_PX = 10`) for the first few pixels — and the whole mechanism under
   jsdom, where `touch-action` means nothing. A tie goes to the scroller, and a gesture judged
   vertical is dead for good rather than able to become a swipe halfway down a fling.

### Commit-only: no iOS "peek"

A short swipe rubber-bands; only a swipe past `SWIPE_COMMIT_PX = 96` commits, on lift. A parked,
tappable state was rejected: each direction carries exactly **one** configured action, so a peek
would present nothing to choose between, while costing 44 px targets (SC 2.5.5) inside a 54 px
compact row, a focus story for the parked controls, a dismissal rule colliding with two existing
document-level capture-phase `pointerdown` dismissers, and a definition of what a row click means
while parked. It can be added later on top of this without rework.

### Zero React state while the finger is down

A `setState` per `pointermove` would re-render the list and every virtual row at 60 Hz (FR-LST-01,
NFR-PERF-02). The gesture is driven imperatively — one `--swipe-x` custom property, two `data-`
flags and one class on the wrapper. React's style diff only writes the keys present in its own style
object, so all four survive a re-render; and `transform` changes no layout box, so nothing the swipe
does can feed back into the virtualiser (which measures nothing today — a comment at the `.row`
transform says so, because adding `measureElement` later would break exactly this).

### A swipe can never destroy, and never self-moves

`destroy` is not a member of `Triage` at all, so routing through `use-triage.ts` makes permanent
deletion **structurally unreachable** from a swipe. The plan's requirement that "swipe-to-trash
inside Trash must never mean destroy" is therefore satisfied by construction rather than by a check.

The hazard that *was* real is a **self-move**, and it existed before this WP: `moveWithUndo` had no
`to === from` guard, and with `from === to` the outbox patch writes `{"mailboxIds/<x>": true}` and
then `{"mailboxIds/<x>": null}` **on the same key** — the second wins, and the server is asked to
remove the message from the only mailbox it is in (RFC 8621 requires ≥ 1). Optimistically it is
worse: `updateWindows` receives the same predicate as both `left` and `entered`, tests `left` first,
and prunes the row out of the window it is still in. The bulk bar reached this today: it renders a
Trash button while viewing Trash. **Fixed at the seam** (`use-triage.ts`), so the bulk bar, the
chords and the swipe are all covered by one guard, and the swipe's own suppression is
defence-in-depth rather than the only line.

A direction whose resolved target is the mailbox on screen is **inert**: no layer, no follow, no
commit. That generalises (Archive-in-Archive is the same shape as Trash-in-Trash) and avoids
promising an action that would not be performed.

### The archive → trash fallback must not be driven off the boolean

`triage.archive()` returns `false` both when the account has no Archive mailbox **and when its
liveQuery has not resolved yet** (`use-triage.ts` documents this; it is the ~7 % silent-no-op M3.9
step 1 fixed). So `if (!triage.archive(…)) triage.trash(…)` would **trash mail on the first render
tick of an account that does have an Archive folder**. The fallback is resolved instead from a single
`useMailboxes()` query — one resolution point for both roles — and the move directions stay inert
until it resolves.

### Coexistence with drag & drop

See **ADR-012 (amended 2026-07-19)**. Touch drag is real on Chrome-Android and iOS Safari, and is
kept. The two gestures divide by what the finger does: hold still and the drag takes it; move
sideways and the swipe does. `onDragStart` bails only when a swipe has **locked an axis** —
guarding on "a finger is down" would cancel the very press that starts a drag, silently disabling
touch DnD app-wide.

## Consequences

- **WCAG 2.2 SC 2.5.7 (Dragging Movements)** applies to the swipe, and asks for a **single-pointer,
  non-dragging** alternative to *each* action the swipe performs. Two of the three already had one:
  tick the row checkbox, then Archive or Trash in the bulk bar.

  **Mark-as-unread did not, and this WP is what exposed it.** Swipe-right **toggles** `$seen`
  (resolved against the row's current state), while the bulk bar's read button was hard-wired to
  `triage.setSeen(ids, true)` — so *clearing* `$seen` was reachable from the `u` chord and from
  nothing else. `u` is a keyboard path: it satisfies **SC 2.1.1 (Keyboard)**, which is a different
  criterion, and it is no help at all to the pointer user on the touchscreen this gesture is for.
  Closed by making the **bulk-bar read button a toggle** — it marks the selection read unless every
  selected message already is, in which case it marks them unread — which is the same shape the flag
  button and the `s` chord already share.

  Worth recording *why* the hole existed, because the mechanism is more general than the bug:
  read/unread had drifted into **three different behaviours across its three entry points** — the
  button SET `$seen`, `u` CLEARS it, the swipe TOGGLES it. That is the exact drift `useTriage` exists
  to prevent, and both warnings were already written down before this WP: `registry.ts` at
  `triage.flag` ("A key that can only ever set a flag, next to a button that toggles it, is exactly
  the drift `useTriage` exists to prevent") and `MessageList.tsx` at the bulk bar ("The SAME seam the
  `e`/`#`/`!` chords use — so a click and a keystroke are one action"). A shared seam makes the
  **write** one code path; it does not make the **intent** one. Routing every caller through
  `use-triage.ts` is necessary and was never sufficient.

  `u` stays one-way, and that is not the same defect: it is a *named* action ("Mark as unread"), not
  a second opinion about what a read control means. A chord that silently flips is worse at the
  keyboard, where the user cannot see the state they are about to invert.
- **`design-system.md`: "Components must not encode meaning in motion alone."** The reveal layer
  carries an icon **and** a visible text label, and the two moves raise the existing Undo toast in a
  polite live region. The armed cue is an icon scale rather than a dim, so no contrast is traded.
- Snap-back is a CSS transition; `global.css` already collapses `transition-duration` under
  `prefers-reduced-motion: reduce`, so it is honoured with no JS and no new preference. **Nothing
  listens for `transitionend`** — under reduced motion that would mean depending on a 0.01 ms event.
- Prefs are **per-account** `localPrefs` (`swipe.left`, `swipe.right`), two independent scalar keys
  rather than one compound object, so no read-modify-write transaction is needed. The effective
  behaviour is account-shaped anyway: whether the archive fallback engages depends on *this*
  account's folders.
- `flag` is deliberately **not** an option yet. It is a two-line addition via `triage.setFlagged`
  when someone asks for it.
- **Defect B1 becomes user-visible in the commonest touch flow**: `setKeywords` never prunes
  keyword-filtered windows, so a swiped-read row stays in a `?q=is:unread` view until the server
  echoes — offline, until reconnect. Accepted for this WP and tracked in §13; no test asserts the
  row leaves, because it correctly does not.

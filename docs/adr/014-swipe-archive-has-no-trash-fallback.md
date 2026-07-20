# 014 — A swipe configured "Archive" never falls back to Trash

- **Status:** accepted
- **Date:** 2026-07-20
- **Deciders:** owner (G2 gap B3 decision round). **Supersedes** the M3.9 decision recorded in
  the doc-comment at `apps/web/src/mail/swipe-prefs.ts` and implemented at
  `apps/web/src/mail/MessageList.tsx` (`resolveSwipe`).

## Context

M3.9 (FR-LST-06) shipped row swipe gestures with per-direction preferences. A direction set to
`archive` resolved to the Archive role mailbox, and — deliberately, and documented as such —
**fell back to Trash on an account that has no Archive role**. JMAP does not mandate an archive
role, so this is a real account shape, not a hypothetical.

The fallback was introduced with care: it is explicitly *not* driven off `triage.archive()`'s
return value, because that boolean is also `false` while the role liveQuery is merely
unresolved, and a boolean-driven fallback would trash mail on the first render tick of an
account that *does* have an Archive folder. That reasoning was sound. The premise underneath it
was not.

G2 gap B3 made the contradiction visible. B3 fixes the keyboard's silence: `e` on an
Archive-less account used to do nothing and say nothing, and now announces *"This account has no
Archive folder. Press V to pick a folder instead."* On the same list, on the same account, the
swipe would have gone on quietly moving mail to Trash. Two entry points to one user intent
would have disagreed — and the gesture's answer was the destructive one.

Three properties made the gesture the wrong place for a substitution:

- **There is no confirmation under a thumb.** The whole interaction is one motion; nothing
  stands between the finger lifting and the mail moving.
- **The reveal layer had already said "Archive".** The strip the finger uncovers is built from
  the same `resolveSwipe` call that commits, so the user was shown one word and given another
  action.
- **Trash is not a near-miss for Archive.** They are the two poles of triage — keep and
  discard. Substituting one for the other silently is not a graceful degradation.

## Decision

Drop the fallback. On an account with no Archive role, a direction configured `archive`
resolves to `null` — the gesture's existing, well-designed inert path: the row does not follow
the finger, no strip is revealed, nothing commits.

This reuses machinery that already existed for a neighbouring case rather than adding any: a
direction whose target *is* the mailbox on screen (Trash inside Trash, Archive inside Archive)
has been inert since M3.9. "The target does not exist" and "the target is where you already
are" now give the same honest answer.

The settings hint (`settings.swipe.left.hint`, `en` + `de`) is updated in the same change; it
promised the fallback, and shipping the reversal without it would have left the settings screen
lying about what the gesture does.

## Consequences

- On an Archive-less account the configured direction does nothing. This is **visible before
  commit** — the row refuses to move under the finger — rather than a silent no-op on lift, so
  the gesture reports its own unavailability the moment it is attempted.
- A gesture the user labelled "Archive" can no longer be the thing that puts mail in the bin.
- The swipe and the keyboard now give one answer for one account shape. The keyboard's is
  spoken (a toast naming `v` as the way forward); the gesture's is felt (the row does not
  move). Neither substitutes an action the user did not choose.
- `MessageList.test.tsx`'s case *"falls back to Trash on an account with no Archive folder"* is
  inverted into a safety assertion: the direction **is inert and must never fall back to
  Trash**. The test now guards the decision rather than the behaviour it replaced.
- Not covered, by the same owner decision: the self-move case and the transient
  "roles not yet resolved" case stay inert-and-silent on both surfaces. The mechanism
  generalises per-action at no extra cost if that ever changes.
- **This ADR exists because a documented decision was reversed.** CLAUDE.md requires that
  deviations are recorded rather than made silently; the superseded reasoning is preserved
  above, and in the amended doc-comment at `swipe-prefs.ts`, so the next reader sees what was
  believed and why it changed — not just the current answer.

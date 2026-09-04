# 040 — The IME rule lives in `ui/`, because `ui/` is the only directory that depends on nothing

- **Status:** accepted
- **Date:** 2026-09-04
- **Work package:** code review 2026-09-01, finding N-07
- **Relates to:** `apps/web/src/ui/internal/composition.ts` (`isComposingKey`),
  `apps/web/src/ui/index.ts` (the barrel), `apps/web/src/shortcuts/keys.ts`,
  `apps/web/src/shortcuts/ShortcutProvider.tsx`,
  [ADR-035](035-one-mailbox-subscription-for-the-whole-app.md) (the same "one statement, one owner"
  move, for a subscription)

## Context

"A keystroke that belongs to an input method belongs to nobody else" was written out **three**
times in `apps/web/src`:

| Where | Spelling |
| --- | --- |
| `ui/internal/composition.ts` | `isComposingKey`, `isComposing === true \|\| keyCode === 229` |
| `shortcuts/keys.ts` (`matchesChord`) | `event.isComposing === true \|\| event.keyCode === 229` |
| `shortcuts/ShortcutProvider.tsx` (the global listener) | `event.isComposing \|\| event.keyCode === 229` |

The finding named two; the third turned up on the way. All three were correct, and all three were
tested. That is what makes the shape dangerous rather than merely untidy: a correction to one of
them reaches neither of the others, and nothing anywhere goes red.

And this rule in particular is built to rot. The browsers disagree about what they even send.
Firefox (≥ 65) reports the COMMITTED key with `isComposing: true` — the committed `Escape` or
`Enter` — so only the flag distinguishes it from a real press. Chromium reports `key: 'Process'`
with the legacy `keyCode 229`; Safari sends the `keyCode` too. A copy written and verified against
one engine passes its tests and drops half the rule in the other. The cost of getting it wrong is
not cosmetic: a Japanese or Chinese writer presses Enter to commit a candidate, some surface takes
the press for itself, and what they were typing is gone — or a `confirmDiscard` dialog asks them
whether to throw it away.

The finding framed the merge as a choice between "make `shortcuts` depend on `ui`, a NEW dependency
between two areas that are independent today" and "lift the rule into a third, neutral file". The
first half of that framing does not survive contact with the imports:

- `shortcuts/` already imports from `../ui` in six places — including `isComposingKey` itself, in
  `CommandPalette.tsx`.
- `ui/` imports from **no** other area of `apps/web/src` at all (only `../test`, in its own tests).
  It is the single leaf of this source tree.

So the direction exists, and the only real question is where a rule that belongs to no feature
should live.

## Decision

**`ui/` is that place, and `isComposingKey` stays there. No new directory.** The two remaining
copies are deleted; `shortcuts/keys.ts` and `ShortcutProvider.tsx` call the one function, and
`ChordEvent` now EXTENDS `CompositionKeyEvent` instead of restating its two members.

The reasoning, in the order it decided the question:

1. **The neutral directory already exists, and it is `ui/`.** "Neutral" here means one thing:
   depends on nothing, so anyone may depend on it without creating a cycle or a surprise. Exactly
   one directory in this app has that property. Inventing `lib/` or `platform/` to hold a single
   function would create a second leaf with the same rule and a worse name — and every future
   argument about which of the two a given browser fact belongs in.
2. **It is already published.** `ui/index.ts` has exported `isComposingKey` since R-40, with a
   comment saying it is for "every surface that reads `event.key` itself, inside this directory
   and out". Two of those surfaces then did not use it. This ADR changes no surface area at all;
   it makes the code match what the barrel already promised.
3. **The barrel, not a deep import.** `shortcuts/keys.ts` imports from `../ui`, not from
   `../ui/internal/composition`. `ui/index.ts` states that convention about itself, and it costs
   nothing: `ui` is in the entry chunk already, on every screen.
4. **A source test, not a behavioural one.** Three behavioural tests passed happily against three
   copies — that was the state being repaired. The property that has to hold is "one definition",
   and only a source-level assertion can express it. `composition.source.test.ts` counts
   `keyCode === 229` across the shipped source and requires exactly one file, and forbids any other
   file from reading `event.isComposing` on its own.

## Consequences

- One place to correct when an engine changes its mind about what it sends during a composition,
  and a test that fails the moment a second place appears.
- `shortcuts` is confirmed as a consumer of `ui` rather than a peer of it. That was already true in
  six files; it is now stated somewhere, instead of being a fact one has to grep for.
- `ui/` keeps its one distinguishing property — it imports from no other area — and that is now
  load-bearing rather than incidental: it is the reason this ADR could answer the question
  without inventing a directory.
- If a future browser fact needs a home and genuinely does NOT belong to the design system (a
  `navigator` probe, a storage quirk), this ADR is what it argues with. The bar it sets is: show
  that `ui/` is the wrong owner, not merely an odd-sounding one — and if a second leaf is created,
  it takes `isComposingKey` with it rather than sitting beside it.

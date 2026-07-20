# 015 — CSS gets two static checks, and the focus one is the load-bearing half

- **Status:** accepted
- **Date:** 2026-07-20
- **Deciders:** owner (G2 gap B5 decision round). Widens the scope the implementation plan
  proposed for B5, deliberately and on evidence.

## Context

CSS is the one layer nothing in this repo verified. §13 gap B5 tracked the *class*, not any one
defect, because the toolchain is structurally blind to it: CSS custom properties are not
typechecked, Biome and `tsc` do not read CSS semantics, `size-limit` weighs bytes, and
`expectNoA11yViolations` runs under jsdom — **which computes no CSS at all**. Every instance so
far was found by a human reading a stylesheet, and each was valid CSS that no linter could have
objected to.

Four instances by the time B5 was scheduled:

1. **M1.6 — the message list had no selection or open-row highlight for eight milestones.**
   `message-list.module.css` referenced `--waxwing-surface-hover` and
   `--waxwing-surface-selected`; neither was ever *defined*. An undefined custom property is
   invalid at computed-value time, so every one of those rules computed to `transparent`.
2. **M1.8 — the move picker had no focus indicator** (WCAG **2.4.7, Level A**): `outline: none`
   paired with `box-shadow: var(--waxwing-focus-ring)`, where that token is a bare colour.
   `box-shadow` requires offsets, so the declaration was dropped and nothing replaced the
   outline it had just removed.
3. **M3.9 — `touch-action: pan-y` silently disabled pinch-zoom across the whole message list**
   (WCAG **1.4.4**). The grammar is `[ pan-x || pan-y || pinch-zoom ]` and whatever is not named
   is disabled.
4. **Found by B5's own mapping, and this is the finding that decided the ADR — two *more* focus
   defects, both of which shipped *after* the M3.9 fix of the same class:**
   `compose/recipient-field.module.css` (the primary To/Cc/Bcc entry had no focus indicator at
   all, since M2.4) and `mail/labels/labels.module.css` (keyboard focus signalled only by a fill
   identical to hover — measured 1.19:1 in light, 1.23:1 in dark, i.e. invisible).

The plan proposed exactly one remedy: a token-reference lint, "cheap, and would have caught (1)
on the day it landed". That is true. It is also, on the evidence, aimed at the *rarer* half of
the problem — and the token lint's headline finding is that it finds **nothing**: zero live
undefined-token references exist today.

## Decision

**Two static checks, not one.** Both run in `pnpm verify`; both read the shipped stylesheets
from disk.

1. **Token reference lint** (`apps/web/src/ui/tokens.references.css.test.ts`) — every
   `var(--waxwing-*)` across all CSS and TSX resolves to a token actually defined in
   `tokens.css`. Handles `var(--x, fallback)`, and cross-checks the dynamically constructed
   label-colour token names against `LABEL_COLORS` rather than reporting them as undefined. It
   also pins the three token names `public/theme.css` documents to hosters by example, which
   nothing checked before. Folded in: **theme-block symmetry** — all override blocks carry the
   same keys as `:root`, so a token cannot be valid in one theme and invalid in another. The
   dark block's selector is `:root:not([data-theme="light"])` inside a media query and there is
   a fifth `:root {` block under `@media (pointer: coarse)`; a naive `:root` regex matches the
   wrong block and the symmetry assertion passes **vacuously**, so a mutation proves it is not.

2. **Focus indicator guard** (`apps/web/src/ui/focus-indicator.css.test.ts`) — a rule may switch
   the focus outline off only if it scopes the suppression away from keyboard focus
   (`:not(:focus-visible)`), supplies a replacement indicator on a sibling `:focus-visible` rule
   for the same selector base, **or** carries a `/* waxwing-focus-exempt: <reason> */` comment
   directly above it. The reason is mandatory and length-checked, so an exemption cannot be
   added without stating why; a companion assertion deletes exemptions that have stopped
   suppressing anything, so the licence cannot outlive its use. Exactly one exemption exists
   today (`reading.module.css`, a programmatic `tabindex=-1` target that is never tab-reachable).

**Dead tokens warn, never fail.** Failing punishes the legitimate workflow of adding a token in
one commit and using it in the next, and the entire live cost is two tokens (~60 bytes), both
of which complete their scales and should stay.

**The generic browser-side focus sweep is explicitly deferred** to its own work package, not
dropped. See below.

## Consequences

- The focus guard would have caught **three of the four** known instances — M3.9's
  `box-shadow: var(<bare colour>)` and both defects found here — and it needs no browser. The
  token lint would have caught one, and catches none today. Recording this plainly matters more
  than the checks themselves: the plan's proposed remedy was aimed at the wrong half, and it was
  the *mapping* for B5, not the plan, that produced the evidence to see that.
- Both new defects were fixed in the same change, each in the shape its own specificity forced.
  `recipient-field`'s ring goes on `.input:focus-visible`, **not** on `.field:focus-within` as
  first proposed: the wrapper rule is also (0,2,0) and would not have removed
  `.input:focus { outline: none }`, so the wrapper would have ringed while the input still
  suppressed its own — and suppressing it again is precisely the construct that created the
  defect.
- **Neither check can see rendered output.** They prove the stylesheet no longer *says* the
  wrong thing; they cannot prove anything *looks* right. A ring that exists but is invisible
  against its background passes both.
- **Known limit of the focus guard:** it matches sibling `:focus-visible` rules by selector-base
  prefix within the same file. An indicator supplied by an ancestor (`.wrapper:focus-within`) or
  from another stylesheet is invisible to it and would be reported as a finding. No such case
  exists today; the first one needs either a guard extension or an exemption with a reason.
- **Deferred, and filed so it is not lost:** a browser-side computed-style focus sweep — for
  every element reachable by Tab on the main screens, assert `getComputedStyle` yields a
  non-`none` `outlineStyle` or a `box-shadow`, and that the focused appearance differs
  measurably from the unfocused one. The seam exists (`page.evaluate` is already used in
  `keyboard.spec.ts` and `swipe.spec.ts`). It is not mechanical: it needs a false-positive
  budget, a "differs measurably" threshold, and an opt-out story that lines up with the
  `waxwing-focus-exempt:` convention established here. It is the only check that catches this
  class *generically* rather than one rule at a time.
- **B5's class stays open even so.** These two checks cover the two shapes that have actually
  fired. `touch-action` (instance 3) is covered by one E2E assertion on one element, not by a
  rule. The honest summary is that the repo went from *nothing* verifying CSS to *two shapes*
  verified — not that CSS is now verified.
- Test routing: `apps/web/src/ui/**/*.css.test.ts` runs in the root Node `unit` project, not the
  jsdom `web` project, because these tests read stylesheets from disk and vitest stubs `.css`
  imports to empty under jsdom — the same reason `*.contrast.test.ts` already lives there. Both
  `vitest.config.ts` files must be edited together (the include *and* the exclude) or the files
  are collected twice.

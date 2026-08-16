# Accessibility — conformance statement and known limitations

**Target:** WCAG 2.2 Level AA (FR-A11Y-01).
**Status:** self-assessed. Last reviewed 2026-08-16 (M4.7).
**Scope:** the Waxwing web client at every route it ships — sign-in, mail list, reading
pane, composer, contacts, settings, and the command palette — in both the light and the
dark theme, in English and German.

This document is written to be useful rather than reassuring. What is verified says how.
What is not verified says so plainly, and says what would be needed to verify it.

## What is verified, and by what

| Area | How it is checked | Where |
| --- | --- | --- |
| Structure, roles, names, ARIA | axe-core (WCAG 2.x A/AA rule set), 57 component suites | `apps/web/src/**/*.test.tsx` |
| The same, on the **assembled** app | axe-core in Chromium, 6 screens + sign-in × 2 themes | `e2e/tests/a11y.spec.ts` |
| Colour contrast (1.4.3, 1.4.11) | axe in a real engine; plus a static token matrix | `e2e/tests/a11y.spec.ts`, `apps/web/src/ui/tokens.contrast.test.ts` |
| Accent palettes, all six | contrast as text AND as fill, both themes, four surfaces | `apps/web/src/app/accent.test.ts` |
| Target size (2.5.8) | rendered geometry in Chromium, five screens | `e2e/tests/target-size.spec.ts` |
| Reduced motion (2.3.3) | static: the universal reset, and no JS-driven motion | `apps/web/src/ui/reduced-motion.css.test.ts` |
| Focus indicators (2.4.7) | static: no `outline: none` without a replacement | `apps/web/src/ui/focus-indicator.css.test.ts` |
| Keyboard operation (2.1.1) | a full triage session with no pointer, against a live server | `e2e/tests/keyboard.spec.ts` |

The two browser-based suites exist because jsdom has no layout engine and no canvas: it
cannot compute a contrast ratio or the size of a button, so no component test — however
many there are — can see a defect of either kind. Both suites found real defects on their
first run (see the changelog at the end).

## Where Waxwing exceeds AA

- **Target size.** AA (SC 2.5.8) asks for 24 × 24 CSS px. Controls are 34 px on pointer
  devices and **44 px on touch** (`--waxwing-control-min`), which meets the Level **AAA**
  SC 2.5.5 figure on the devices where it matters most.
- **Contrast.** No shipped token pair sits at exactly 4.5:1; the accent palettes carry
  margin on every surface they can land on.

## Known limitations

These are honest gaps, not oversights we intend to leave forever. Each says what it would
take to close it.

### 1. No screen-reader testing with a real screen reader

**This is the largest gap.** Everything above is automated. Automated tools catch roughly
a third of WCAG issues by count, and essentially none of the "is this announcement
actually useful?" class. Waxwing has **not** been walked through with VoiceOver, NVDA or
JAWS by a person.

What that means concretely: the roles and names are correct as far as axe can tell, and
the two most announcement-sensitive flows (triage with undo, and the command palette) were
designed around what a reader would hear — but nobody has listened.

*To close it:* manual passes of the three core flows (list triage, reading, composing) on
VoiceOver (macOS + iOS) and NVDA (Windows), with findings filed and fixed. This is a
planned M4.7 task that has not been done.

### 2. Message bodies are foreign HTML

A message body is HTML written by someone else. Waxwing sanitizes it (`packages/mail-html`)
and renders it in an isolated frame, but it cannot make it accessible: an email with images
that carry no `alt`, a table used for layout, or text at 2.1:1 contrast renders as its
author wrote it. Rewriting sender content would be its own accessibility problem — it would
mean silently changing what a message says.

*Mitigation:* the plain-text alternative is always reachable, and the reading pane's own
chrome (headers, actions, attachments) is fully in scope and verified.

### 3. Contrast is verified for tokens, not for every composed pair

`tokens.contrast.test.ts` checks a hand-maintained matrix of foreground/background pairs,
and the browser sweep checks what is actually on screen in six screens. A colour
combination that appears only in a state none of those reach — a rare error banner over a
selected row, say — is not covered by either.

*To close it:* a computed-style sweep over every rendered element, which is a materially
more expensive check than axe's and is not currently run.

### 4. `role="toolbar"` uses arrow keys, which some readers intercept

The reading-pane action bar and the composer's formatting bar implement the APG toolbar
model (one tab stop, arrows inside). In some screen-reader browse modes, arrow keys are
captured by the reader before they reach the page. This is inherent to the pattern rather
than specific to Waxwing, and every toolbar action also has a global chord (`?` lists them)
and a menu equivalent.

### 5. The spacing exception carries the list checkboxes

Row checkboxes render at 18.4 px — below the 24 px minimum — and conform through SC 2.5.8's
spacing exception, which the automated check implements rather than skips. The exception is
real and correctly applied (verified at both densities), but a 24 px checkbox would be
better than a conforming 18.4 px one.

### 6. Not audited by a third party

This is a self-assessment. No external accessibility audit has been commissioned, and no
formal VPAT/ACR exists.

## Reporting a problem

Accessibility defects are bugs. Please open an issue describing what you were trying to do,
what you heard or saw, and your browser and assistive technology — that last detail is
usually what makes a report reproducible.

## Changelog of substantive fixes

Recorded because "we fixed some a11y issues" is not a claim anyone can check.

**M4.7 (2026-08-16)**

- Undo was pointer-only: the toast region is portalled to the end of the document and
  expired after 5 s. Now `z` runs it and action-bearing toasts do not expire (ADR-021).
- The accent colour failed 1.4.3 **as text** — 3.95:1 for the selected folder. The token
  contrast matrix had never put the accent on a surface. Accent, success and danger raised;
  all six palettes now checked as text on four surfaces.
- Contacts search carried `aria-controls` pointing at a listbox that does not exist while
  the list is empty — a dangling IDREF on every new account.
- Attachment and row-menu buttons carried no distinguishing name (N identical "Preview",
  "Folder actions", "Label actions").
- The command palette claimed `aria-expanded={true}` with no options and announced nothing
  when a query matched nothing.
- A rejected label name left focus on the submit button and explained itself only through
  `aria-describedby`, which is read when the input has focus.
- The search chip strip shared the search field's name and was read out in full as its
  description.
- Four description lists in the server panel had no accessible name.
- Two landmarks were called "Notifications"; every dialog contributed a second `banner`;
  the sign-in screen had no `<main>`.
- The reading-pane action bar declared `role="toolbar"` with none of the keyboard model.
- The folder and label sidebars rendered nothing at all while loading.

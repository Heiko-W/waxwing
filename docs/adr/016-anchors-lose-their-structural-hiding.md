# 016 — Inside an anchor, an inline style is filtered against a property allowlist

- **Status:** accepted
- **Date:** 2026-07-22
- **Deciders:** owner (M3.10 phishing-gate review, waves 2, 3, 4 and 5). Partially reverses a position
  stated in `packages/mail-html/src/link-host.ts` since M3.9 and reaffirmed in the G2 review.
- **Supersedes its own wave-2 text.** The title used to read "the sanitizer strips structural
  hiding". It was a denylist of four declarations, and it was walked past four ways.

## The one-sentence version, before any of the detail

**This gate is a best-effort heuristic against an attacker who controls the markup and the CSS. It
is friction, not verification.** Hiding text inside a link is *not* a closed class, the enumeration
of techniques defeated below is *not* exhaustive, **and no absence of a warning may be read as a
statement that a link is safe.** No sentence in this document, in `link-host.ts` or in `sanitize.ts`
may be read as saying otherwise. Where one did, it was wrong — **four times now, in four consecutive
waves**, which is the reason this paragraph is first. Two of them stated a general property ("no
placement, quantity or hiding technique", "never sees fewer declaration boundaries than the
browser"); one named a residual and thereby implied the rest were shut; one denied a hole outright.
Every one of those shapes has since been disproved by a single input. **If a sentence anywhere in
this gate reads as a guarantee, the prior is that it is wrong.**

## Context

`link-host.ts` decides whether a mail link goes where its text says. It has been through five
rounds, and this ADR exists because each of the first four shipped a comment that claimed more
than the code delivered.

**M3.9 — tokenising.** The gate used to be anchored over the whole link text, so `bank.test.` or
`Login at bank.test` claimed nothing and opened in silence. Fixed by treating any host-shaped
*word* as a claim.

**G2 — the quantifier.** Tokenising opened the mirror direction: hidden text could *add* a claim
that was already satisfied, and under "if ANY claim covers the target, the link is `ok`" that was
an off switch. Fixed by inverting the quantifier — **every** claim must be honoured. The header
then asserted, in as many words, that "there is no placement, quantity or hiding technique that
turns the mismatch back into silence". **That sentence was false, and one character disproved it:**

```html
<a href="https://evil.tld/steal"><span style="display:none">evil.tld/</span>bank.test</a>
```

`textContent` concatenates text nodes with **no separator**, so this arrives as the single word
`evil.tld/bank.test`, whose path group swallows the visible host. Every claim is honoured; the
verdict is `ok`; the non-disableable interstitial never appears. All 106 tests that shipped with
the G2 fix used a whitespace-separated fixture, including the ones named for the general property.

**Wave 2 — the two renderings, and a denylist.** The union fix (part 1 below) was correct and
stands. Beside it went a sanitizer rule stripping four named hiding declarations inside an anchor,
and this document then stated that "the two named families are closed for every hiding technique".
A fresh checker ran 74 attacks and broke the sanitizer half **four ways**:

| what was claimed | what actually happened |
| --- | --- |
| `display:none` is removed inside an anchor | `display:none!important` was **kept** — the value was anchored `\s*$` immediately after the keyword. So were `display:none !important`, `display:none!IMPORTANT`, `display : none ! important`, and a CSS comment on either side of the keyword. `!important` is the spelling real HTML mail overwhelmingly uses: the rule did not implement its own headline case. |
| the four structural spellings are "forced into view" | every **geometric** vector was untouched and never enumerated: `position:absolute;left:-9999px`, `position:absolute;clip:rect(0,0,0,0)`, `position:fixed;left:-100vw`, `text-indent:-9999px`, `clip-path:inset(100%)`, `transform:scale(0)`, `max-height:0;overflow:hidden`, `height:0;overflow:hidden`, `opacity:0`, `filter:opacity(0)`. |
| a zero `font-size` is removed | the clause matched **exactly** zero, so `font-size:0.0001px` walked past it. |
| chromatic hiding is "the only residual" | it was not, as the two rows above show. Naming one residual implied the rest were shut. |

**Wave 3.** Two further holes were found that neither half touched: an anchor labelled only by an
`<img alt>` claimed nothing at all, and U+2800 BRAILLE PATTERN BLANK de-shaped a host with no CSS
and no markup whatever.

**Wave 4 — the current text.** The property allowlist itself held (126 probes against it, none
through). Four things did not, and the pattern in three of them is the same one this document has
now recorded four times: *a rule that hunts for what it knows loses to an attacker who picks the
spelling.*

| what was claimed | what actually happened |
| --- | --- |
| an unreadable `font-size` is dropped | the check read the **first literal number** in the value, so `font-size:calc(100px * 0)`, `calc(1em*0)`, `min(100px,0px)`, `calc(16px * 0.0001)`, `calc(100px/100000)`, `var(--u,calc(9px*0))` and the same family on `line-height` were all **kept** — the wave-2 denylist defect, one level down, inside the fix for it. |
| an attribute-borne label is read (wave 3) | it was read for `<img>`/`<area>` only. `<input type="image" alt>` renders its alt as the button's label under exactly the same remote-`src`-stripping guarantee, and `<input value>` paints a label; both were invisible to the walk. |
| the invisible-character strip removes what renders as nothing | it also removed U+202E RIGHT-TO-LEFT OVERRIDE, which renders as nothing **itself** and reverses everything after it. `&#x202E;nigol/tset.knab` reads as `bank.test/login`; the classifier read `nigol/tset.knab`, found no claim, and opened in silence. No CSS, no elements. |
| — | and a regression this work introduced: `filterAnchorStyle` split declarations on every `;`, truncating a legitimate `background:url(data:…;base64,…)` mid-string and swallowing every declaration after it. |

**Wave 5 — no code changed; the RECORD was wrong.** An independent checker judged the residual
documentation "understated": three live holes were absent from it, and one of them was affirmatively
**denied** by a comment. That denial is the worst of the three, because the next reviewer reads a
denial as a closed class and stops looking. The pattern this time is not "a rule loses to a
spelling" but the one this document warns about in its first paragraph and then kept committing:
*a comment that states a property the code does not have.*

| what was claimed | what is actually true |
| --- | --- |
| `splitDeclarations` "never sees *fewer* declaration boundaries than the browser"; the failure direction is "never 'a rejected one is applied'" | a CSS string also ends at a **newline** (CSS Syntax L3 §4.3.5, after §3.3 folds CR/CRLF/FF to LF), and this splitter closes one only on the matching quote — so `font-family:'x⏎;display:none` is one kept declaration here and two to the browser, the second of which is applied |
| the size rule now "rejects every value that is not a plain literal number with a unit" | a **CSS comment** is not a paren: `font-size:/*9*/1px` reads magnitude 9 and is kept while the browser renders 1px. And `CSS_NUMBER` reads `5e-10px` as magnitude 5 with unit `e`, so **scientific notation** clears the floor and is rejected only incidentally, by `NEGATIVE_VALUE` |
| descendants-only is sound because "an `<a>` hiding *itself* deceives nobody" | true of hiding, false of **reordering**: the anchor's own `style` is never filtered, so `<a style="direction:rtl;unicode-bidi:bidi-override">` renders reversed while remaining visible and clickable — the CSS spelling of the very class part 3a defends against on the character side |
| closing the `<bdo dir="rtl">` bypass "would mean making the walk bidi-aware — a rendering question in a module that is deliberately DOM-free" | `frame.ts`'s walk is not DOM-free and already reads `nodeName` and `getAttribute`; a `<bdo>` check is within reach. The real cost is a false-positive judgement on right-to-left mail and a widened interface, not infeasibility |

All four are verified — the first three end-to-end through `sanitize`, the newline case additionally
against a spec CSS tokenizer — and all are filed as **open**, not fixed. Nothing in this wave touched
behaviour, so no mutation row below changes.

## Decision

### 1. The claim set is the union of TWO renderings of the anchor's text (wave 2, unchanged)

`frame.ts` walks the anchor's subtree once on a click and produces both:

- **RAW** — the text nodes concatenated with no separator (`textContent`), **plus** the text
  descendants render out of an attribute rather than a text node (part 3).
- **SEPARATED** — the same runs joined with a space at every **element** boundary, and only there.

`classifyLink` takes the pair and its claim set is the **union**. Every claim in the union must
still cover the target.

Union is the right shape because the every-claim rule is **monotone**: an added claim can only move
a verdict from `ok` toward `mismatch`, never back, so adding a rendering can never turn a
`mismatch` into an `ok`. Note the precise scope of that statement — it is about *renderings*, and
it is **not** the claim that hidden markup can only add claims. Spliced without whitespace, hidden
markup demonstrably *replaces*. Conflating the two is exactly the error the G2 header made.

Both renderings are needed; neither dominates:

| anchor | RAW | SEPARATED | union verdict |
| --- | --- | --- | --- |
| `<span hidden>evil.tld/</span>bank.test` → `evil.tld` | `{evil.tld}` | `{evil.tld, bank.test}` | mismatch |
| `bank.test<span hidden>x9</span>` → `evil.tld` | `{}` | `{bank.test}` | mismatch |
| `<b>bank</b>.test` → `bank.test` | `{bank.test}` | `{}` | ok |
| `<b>bank</b>.test` → `evil.tld` | `{bank.test}` | `{}` | **mismatch — RAW only** |
| `Click <b>here</b>` | `{}` | `{}` | ok |

SEPARATED separates at **element** boundaries and nowhere else. A comment is not an element, so
`bank.test<!--c-->x9` is one run in *both* renderings. That is deliberate and it is not a hole: a
comment renders nothing, so the reader sees the same fusion the classifier does — there is no gap
between what is shown and what is read, which is the only property this pair is for.

### 2. Inside an anchor, an inline style is filtered against a property ALLOWLIST

**This is the reversal, and wave 3 changes its shape.** `link-host.ts` has said since M3.9 that
"`sanitize` keeps `display:none` and `hidden` deliberately … the fix belongs where the claim is
READ, not in a sanitizer". That stays true *outside* links and is false *inside* them.

Wave 2 implemented it as a denylist of four declarations. A denylist over CSS values loses that
race by construction: the value grammar is large, the attacker picks the spelling, and any property
invented after the file was written is allowed by default. The four bypasses in the table above are
that construction failing, not four separate oversights.

So the test moved to the **property name**, where the grammar is a fixed vocabulary and the default
is *no*. On **descendants** of an `<a>`, and nowhere else, each declaration survives only if its
property is on `ANCHOR_STYLE_ALLOWLIST` in `sanitize.ts`. `!important` lives in the value and can
never reach the *property-name* decision; nor can a comment in the value; nor can a property nobody
has heard of. Note the scope of that sentence: it says the property-name lookup is unaffected by
what the value contains. It says nothing about the two **value** constraints below, where a comment
very much does reach the decision — see the residual list.

The list was chosen from what real mail needs *inside a link*: text styling (`color`, the `font-*`
family, `line-height`, `letter-spacing`, `word-spacing`, `text-align`, `text-decoration*`,
`text-transform`, `vertical-align`, `white-space`, `word-break`, `overflow-wrap`, `hyphens`), the
`background*` paint family, and the box chrome of a call-to-action button (`border*`,
`border-radius`, `padding*`, `margin*`). The positioning, clipping, transform, overflow, sizing and
opacity families are excluded wholesale.

Two value constraints sit on top, because an allowed property can still collapse or displace a box:

- **A provably readable size**, on `font-size` and `line-height` — **rewritten in wave 4, and this is
  the important change.** The rule is no longer "reject a value that looks small"; the INTENT is
  "reject every value that is not a plain literal number with a unit". Read that as the intent and
  not as a description — the code implements it for functions only, and the gap is stated below.
  Any value containing `(` — `calc()`,
  `var()`, `min()`, `max()`, `clamp()`, `env()`, or a function nobody has heard of — is rejected
  without being read. Evaluating CSS arithmetic was the alternative and it is a losing game: `calc()`
  nests, mixes units and composes with `var()`. A value with no paren and no number is a keyword
  (`medium`, `larger`, `inherit`, `normal`), none of which is zero, and is kept. Where a literal
  number *is* present the floor is deliberately *above* zero — below 4px, below 0.5×, below 50% —
  because wave 2 tested for exactly zero and `font-size:0.0001px` walked past it.
  **The paren rejection is not the same thing as tokenising, and two residuals survive it** — a CSS
  comment carrying a digit, and scientific notation. Both are listed below; neither is closed.
- **No negative number**, on **every** allowed property rather than a curated subset.
  `margin-left:-9999px` is the same off-screen displacement as the `text-indent:-9999px` the
  allowlist already excludes; negative values elsewhere are either meaningless or purely cosmetic
  (tight tracking, an icon nudged a pixel); and a blanket rule cannot be forgotten the next time a
  property is added.

**Declarations are split respecting `url()` and quoted strings (wave 4).** Splitting on every `;`
was a regression this rule introduced in ordinary mail: `sanitizeStyle` re-quotes every kept `url()`,
so a legitimate inline background arrives here carrying a `data:` URI, and
`background:url(data:image/png;base64,…) no-repeat;color:#000` was emitted truncated at
`url('data:image/png` — an unterminated CSS string that then swallowed `color:#000` and everything
after it. The splitter tracks quotes, parentheses and backslash escapes. It is still not a CSS
parser. For the malformed inputs it was tested against (unclosed `(`, unterminated string *with no
newline in it*, stray `)`) the CSS tokenizer fuses exactly where this fuses and the fused declaration
is invalid, so it applies nothing.

**It does NOT hold in general, and the earlier text here claimed it did.** That text said the
splitter "never sees *fewer* declaration boundaries than the browser". It does, on one input shape,
and the shape is not exotic — see the newline residual under *What is NOT closed*. Read this
paragraph as "the three shapes that were checked came out right", never as a property of the
splitter.

Three scope limits, all unchanged from wave 2:

- **Descendants only** — the `<a>`'s own `style` is never filtered. The wave-2 justification was that
  an `<a>` which hides *itself* cannot be clicked, so there is no promise to break. That is true of
  hiding and **false of reordering**, and the anchor's own `style` is a live hole for the second; it
  is listed below rather than defended here.
- **Anchors only.** Preheaders — the reason the sanitizer keeps `display:none` at all — live at
  body level, never inside a link. There is a regression test.
- **The `hidden` attribute** is dropped on the same scope.

**What is deliberately kept, and what that costs.** `color` and the whole `background` family are
on the allowlist **on purpose**. Dropping them would be the worse bug: the classic marketing button
is white text on a coloured background, and a rule that took the background away while keeping the
text colour would render **white-on-white** — legitimate text made invisible by the very rule meant
to force text into view. Both halves stay, together.

The direct consequence is that **this rule cannot close hiding, and does not claim to.** The frame
paints a known white canvas, so `color:#fff` inside an anchor remains an always-available hide. A
large *positive* `padding-left` displaces a following run out of the visible column as well as a
negative one does, and any per-declaration ceiling composes away under nesting, so none is
attempted.

What the rule buys is narrower than the wave-4 text said, and the difference matters. That text read
"every spelling which hides *without a colour trick* stops working" — another general property, and
it is false three ways: the splitter's newline divergence carries a `display:none` straight through
the allowlist; a leading CSS comment carries a 1px `font-size` through the size floor; and the
anchor's own `style` is not filtered at all. What is actually true is the modest version: **the set
of allowed properties is a list a reviewer can read rather than a race against CSS, and every hiding
spelling that reaches the property-name test loses to it.** The residual list is where the ways in
that do not reach it are enumerated, and that list is not closed either.

`display` is off the list even though `display:inline-block` is how a padded button is built.
Admitting it would mean allowlisting its *values* (`none` out, `table-column` out, …), i.e. a
second value grammar to get right, for a cosmetic gain: without it such a button renders tight
rather than illegible.

### 3. A label that lives in an ATTRIBUTE is text the reader reads, so `linkTextOf` emits it

```html
<a href="https://evil.tld/steal"><img src="https://cdn.evil.tld/l.png" alt="Sign in to bank.test"></a>
<a href="https://evil.tld/steal"><input type="image" src="https://cdn.evil.tld/l.png"
   alt="Sign in to bank.test"></a>
```

`textContent` ignores attributes, so both renderings were empty, the empty-claims rule returned
`ok`, and this — the shortest phishing link in the corpus — opened with no dialog. What makes it
reliable rather than incidental is **our own privacy default**: `sanitize` strips the remote `src`,
which is exactly what guarantees the browser falls back to rendering the `alt` string. The reader
literally sees the words `bank.test`. That is the default rendering of every image-only link in this
client.

Wave 3 fixed the first line and left the second — the same defect under a different tag, since per
the HTML spec an image button whose image is unavailable renders its `alt` as the button's label.
Wave 4 therefore stopped adding cases and enumerated the whole set against what `sanitize` actually
permits. `frame.ts`'s `attrTextOf` carries the table; in summary:

| read, because the control paints it | not read, because nothing paints it |
| --- | --- |
| `<img alt>`, `<area alt>` | `<button value>` — the label is its content, already read |
| `<input type=image alt>` | `<li value>` — a list marker, digits only |
| `<input value>`, except the types below | `<data value>`, `<table summary>`, `<td abbr>` |
| `<input placeholder>`, `<textarea placeholder>` | `<meter value>`, `<progress value>` |
| `<option label>`, `<optgroup label>` | `title`, on every element — see below |

`<input>` types whose `value` is **not** read: `hidden` (renders nothing, and carries a value in
essentially all real markup), `checkbox`/`radio` (submission data, never painted), `image` (its
label is the `alt`), `file`/`color`/`range` (a chooser, a swatch, a slider), `password` (painted as
bullets, so no host in it is legible). Everything else — including an absent or unknown `type`,
which is `text` per the spec — is read.

The direction of error is deliberate: reading text the reader did *not* see can only **add** a
claim, and an added claim can only move a verdict toward `mismatch`. Not reading text the reader
*did* see is the defect. Where a case was genuinely ambiguous it was read.

Each is emitted into **both** renderings, fenced by the same element boundaries as any other
content, so it forms its own word in SEPARATED and cannot be spliced against a neighbouring text
node.

**`title` is deliberately NOT emitted, on any element.** A title surfaces on hover only and never on
touch, so a host named in one is text the reader most likely never read, while
`title="shop.example.com"` on a tracked link is an ordinary newsletter shape that would start
warning. It is a false-positive judgement with a real cost, listed as a residual below.

Wave 4 also **moved the test that pins it.** Wave 3 asserted the decision on `<a title>` and
`<span title>` — elements `attrTextOf` returns `''` for unconditionally — so the fixtures passed
whether or not the decision held; adding `title` to the return value kept all 427 tests green. It is
now pinned on `<img>`, `<input type=image>`, `<input type=submit>` and `<option>`, the elements the
function actually inspects, which is the only place the decision could drift.

### 3a. An explicit bidi OVERRIDE means we cannot know what the reader saw

```html
<a href="https://evil.tld/steal">&#x202E;nigol/tset.knab</a>   <!-- renders as bank.test/login -->
```

U+202E RIGHT-TO-LEFT OVERRIDE draws no glyph, so the invisible-character strip removed it and the
classifier read `nigol/tset.knab`, which is host-shaped in no way at all: no claim, and silence.
No CSS and no elements — the assumption the whole allowlist in part 2 rests on, defeated by a
character that is invisible by definition.

**The decision is to fail closed, not to reconstruct the rendering.** If a link's text contains
U+202D LRO or U+202E RLO, `classifyLink` returns a `mismatch` unconditionally and the interstitial
names the real target. The Unicode Bidirectional Algorithm is context-sensitive — a U+202C can end
the override's scope mid-word, and the paragraph direction is a property of the rendering, not of
the string — so emulating it would be the same losing game as evaluating `calc()`.

**Narrowness is the whole job**, because the ordinary controls are common in legitimate right-to-left
mail. The line is drawn on what the algorithm does:

- **U+202E RLO and U+202D LRO are OVERRIDES**, and only they trigger it. An override assigns a strong
  direction to every character in scope, *discarding* the character's own class, so the run is laid
  out in reverse. These two can change the sequence the reader perceives.
- **U+202A LRE and U+202B RLE are EMBEDDINGS** and do not. They set the surrounding level; each
  character keeps its class, so a Latin run inside an RLE still reads left to right.
- **U+2066–U+2069 (LRI/RLI/FSI/PDI) are ISOLATES** and do not, for the same reason — and these are
  the forms Unicode actively recommends, so they are what well-formed multilingual mail contains.
- **U+200E LRM, U+200F RLM, U+061C ALM** do not: they affect the placement of neighbouring *neutrals*
  only, and are ordinary punctuation-fixing marks in real Arabic and Hebrew mail.
- **U+202C PDF** does not: it pops a scope rather than starting one.

The app ships German and English today, but the sanitizer is shared and RTL readiness is a tracked
M4 concern, so a blanket "any bidi control warns" rule would become a tax on every Arabic and Hebrew
message the day it arrives. All ten of the non-triggering controls are pinned as `ok`.

Separately and **only** to decide *which host the dialog names*, a word carrying an override is also
read reversed (by code point, so a surrogate pair is moved rather than broken), which recovers
`bank.test` from `nigol/tset.knab`. That reading is best-effort and cannot change any verdict: the
rule above has already produced the mismatch, and an added claim is monotone.

**This closes ONE SPELLING of reordering, not reordering.** A bidi override can be written three
ways, and only the first is a character:

| spelling | status |
| --- | --- |
| U+202D/U+202E in the text | detected here, unconditional `mismatch` |
| `<bdo dir="rtl">` — markup | **open**, listed below |
| `style="direction:rtl;unicode-bidi:bidi-override"` **on the `<a>` itself** — CSS | **open**, listed below (on a descendant it is stripped, because neither property is allowlisted) |

Two of the three are open, so nothing in this part may be read as saying reordering is handled. And
three known spellings is not evidence that there is no fourth.

### 4. A character that renders as a blank ADVANCE is a word separator; one that renders as NOTHING is stripped

```html
<a href="https://evil.tld/steal">bank.test⠀Login</a>       <!-- U+2800 between -->
```

U+2800 BRAILLE PATTERN BLANK draws as an empty cell, is not `\s` (so the `/\S+/gu` tokeniser did not
split on it) and is not `\p{Cf}` (so the strip did not remove it). One word, not host-shaped, no
claim, silence — with **no CSS and no elements involved**, which is why neither the two renderings
nor the allowlist above touches it.

The two possible treatments differ and **both are taken**, because each closes an attack the other
leaves open:

- Only **splitting** catches a fusion whose result covers the target: text `bank.test⠀x` over a link
  to `https://bank.testx/` reads, stripped, as `bank.testx` — which *is* the target, is honoured,
  and opens in silence.
- Only **stripping** catches de-shaping: text `bank⠀.test` splits into `bank` and `.test`, neither
  host-shaped, so nothing is claimed at all.

Union is sound for the same monotonicity reason as part 1. The split pieces are read first so the
dialog names the host the reader saw rather than the fused artefact.

Separately, the invisible-character strip was widened from `\p{Cf}` to `\p{Cf}` ∪
`\p{Default_Ignorable_Code_Point}`. Neither set contains the other: 4036 code points are
default-ignorable and not `\p{Cf}` — U+034F COMBINING GRAPHEME JOINER, the variation selectors, the
Hangul fillers, the U+E0000 tag block. Enumerated against the engine's own property data, not
recalled. The placement matters and was got wrong first: one of these *before* the dot leaves the
word host-shaped anyway and IDNA deletes it, so such a fixture warns with or without the fix;
*inside* the last label the shape test itself fails, no claim is produced, and the link opens in
silence. The tests use the second placement and keep the first as a labelled control.

**Drawing no glyph is not the same as having no effect on what is drawn**, and this part's second
half conflated the two until wave 4. The strip removes `\p{Cf}`, which includes the bidi overrides —
characters that draw nothing *themselves* and reverse everything after them. Part 3a is the answer:
the strip is unchanged, and the override is detected on the word *before* it runs.

**This is not a closed enumeration.** "Renders blank" is a font fact, not a Unicode property —
unassigned code points, private-use areas and font fallback can all draw as something blank-ish, and
nothing here would know.

## Consequences

### What real mail loses

- **Nothing on the classic call-to-action button.** White text on a coloured background, with
  padding, border-radius, font family/weight/size and `text-decoration:none`, passes through
  untouched. Asserted as a test, not as a claim.
- **A padded `display:inline-block` button renders tight**, because `display` is dropped. Every
  character stays legible.
- **An image's own `style="width:…;height:…;display:block"` is dropped.** The frame's reset
  (`img{max-width:100%;height:auto}`) still bounds it, and the `width`/`height` **attributes** that
  most mail actually uses are not touched by this rule at all — it only filters `style`.
- **`margin:0` resets survive; negative margins and `calc()` containing a subtraction do not.**
  Spacing shifts, never legibility.
- **A spacer cell inside a button (`font-size:0;line-height:0`) grows to its default height.** That
  is the same cost wave 2 already accepted for `font-size:0`, now also applying below 4px.
- **Any `font-size`/`line-height` written as a function is dropped**, including a perfectly
  legitimate `font-size:calc(1rem + 2px)` or `clamp(…)`. The text then inherits the anchor's size: it
  is visible, merely not the author's size. That is the accepted cost of the wave-4 rewrite, and it
  is the direction the rule should fail in.
- **Absolute units are measured against a px floor, so `font-size:1cm` is dropped** — 1cm is 37.8px
  and perfectly legible. The same applies to `mm`, `in`, `pc`, `q` and a `pt` value below about 3.
  Fail-closed and harmless (the text inherits the anchor's size), but it is a real loss and it
  belongs on this list rather than in nobody's head.
- **A new false positive from part 4:** a legitimate `bank.test⠀Login` linked to `bank.test` warns,
  because the stripped reading claims `bank.testlogin`. It needs a braille blank *and* a host name
  in one link's text.
- **Two new false positives from parts 3 and 3a.** An `<input value>`/`placeholder`/`<option label>`
  that names a host the link does not reach now warns, on the same terms as the `<img alt>` above.
  And *any* link text containing U+202D/U+202E warns whatever it says — narrow, since those two are
  close to unused in real mail, but unconditional.
- Verified by reading the allowlist against the standard responsive-email idioms and by the
  fixtures in `sanitize.test.ts`; **not** verified in a real rendering engine — no browser runs in
  this environment. Layout claims here are reasoned, not measured, and are labelled as such.

### What is NOT closed — a list that is itself not closed

**Read the first paragraph of this document again before adding anything here.** This gate is a
best-effort heuristic against an attacker who controls the markup *and* the CSS; the enumeration
below is what is known today, six reviews have each added to it, and **no absence of a warning is a
statement that a link is safe.** The wave-5 review added three entries without a line of code
changing — which is the point: the list was short because nobody had looked, not because the classes
were shut.

- **Hiding text inside an anchor, in general.** `color:#fff` on the frame's known-white canvas
  remains — kept deliberately, because dropping `background` while keeping `color` would render
  legitimate white-on-coloured button text invisible, which is the very outcome the rule exists to
  prevent. A large positive `padding-left`/`border-left-width` displaces a run out of the visible
  column just as well as a negative one, and any per-declaration ceiling composes away under
  nesting. Both are pinned as `ok`/`kept` tests on purpose.
- **Chromatic hiding of a SPLIT host**, which is the case where hiding is actually load-bearing:

  ```html
  <a href="https://evil.tld/steal"><b>bank</b>.test<span style="color:#fff">x9</span></a>
  ```

  RAW fuses `bank` + `.test` + `x9` into `bank.testx9` (not host-shaped); SEPARATED splits them into
  `bank`, `.test`, `x9` (none host-shaped). Both renderings are empty and the classifier is silent.
  Closing it needs the RENDERED text, which needs computed style against a real background — not
  available to a script-free frame — and a partial visibility oracle is worse than none because it
  reads as a closure.
- **A `title` naming a host** (part 3), by decision.
- **A CSS string ended by a NEWLINE gives the browser a declaration boundary `splitDeclarations` does
  not see — so a declaration we believe we rejected is applied.** Per CSS Syntax Level 3 §4.3.5 a
  string ends at an unescaped newline as well as at its quote (emitting a `<bad-string-token>`), and
  §3.3 has already folded CR, CRLF and FF to LF. The splitter closes a string only on the matching
  quote:

  ```html
  <a href="https://evil.tld/steal"><span style="font-family:'x
  ;display:none">evil.tld/</span>bank.test</a>
  ```

  One declaration here — `font-family` is allowlisted, its value is not inspected, and the whole run
  is kept verbatim. Two declarations to the browser: an invalid `font-family`, then `display:none`,
  **applied**. Confirmed with a spec tokenizer (`@csstools/css-tokenizer`: `bad-string-token |
  whitespace-token | semicolon-token | ident("display")…`) and end-to-end through `sanitize`. This is
  the exact divergence direction the wave-4 text asserted did not exist, in two sentences that have
  now been deleted; it is filed as an open row rather than fixed here because this pass was words
  only. Teaching the splitter that LF/CR/FF terminates a string is a small, well-bounded change.
- **A CSS COMMENT carrying a digit is read as the size.** `isUnreadableSize` rejects any value with a
  `(` and then reads the first literal number, but a comment is not a paren and the tokenizer strips
  it before anything is computed. `font-size:/*9*/1px` reads as magnitude 9 and is **kept**, while
  the browser renders 1px; plain `font-size:1px` is correctly dropped. Verified end-to-end. It also
  misfires the other way (`/*0*/9px` drops a legitimate 9px), which is harmless and is the same
  defect. Closing it means stripping comments before the read, or rejecting `/*` the way `(` is
  rejected.
- **Scientific notation is not parsed by the size rule.** `CSS_NUMBER` stops the mantissa at the
  first non-digit, so `font-size:5e-10px` is read as magnitude **5**, unit **`e`** — above the 4px
  floor — while the browser computes ~0. Nothing shows it through today only because shrinking needs
  a *negative* exponent and `NEGATIVE_VALUE` trips on the `-1`. That is a coincidence of two rules,
  not a property of this one, and it comes apart if `NEGATIVE_VALUE` is ever narrowed. Neither
  comment said so before this wave.
- **The anchor's OWN inline style is never filtered, and for REORDERING that is a hole.**
  `filterAnchorStyle` runs only where `isInsideAnchor(node)` is true, which is false for the `<a>`
  element itself. The wave-2 justification — "an `<a>` hiding *itself* deceives nobody" — holds for
  hiding and not for reordering:

  ```html
  <a href="https://evil.tld/steal" style="direction:rtl;unicode-bidi:bidi-override">nigol/tset.knab</a>
  ```

  Fully visible, fully clickable, renders as `bank.test/login`; `link-host.ts` reads the written
  order, nothing is host-shaped, nothing is claimed, silence. Neither property is on
  `ANCHOR_STYLE_ALLOWLIST`, so the *same two declarations on a `<span>` one level down are stripped* —
  verified both ways. This is the CSS spelling of exactly the class part 3a added a character-level
  defence for, and a third spelling alongside U+202E and `<bdo>`. Widening the scope by one element
  is one line, but the suite objects to it as a mutation (the row "the anchor scope … widened to
  include the `<a>` itself (2)"): the fixture it breaks is the deliberate *hiding* half. So a fix has
  to separate the two classes rather than widen wholesale. Open.
- **`<bdo dir="rtl">`, the MARKUP spelling of the bidi override in part 3a.** `sanitize` keeps
  `<bdo>` and its `dir`, and part 3a is a character-level rule that does not see markup. The reader
  is shown a reversed run, `link-host.ts` reads the written order, and a text whose *reversal* is
  host-shaped claims nothing. Asserted as the `ok` it is. **The earlier wording here — that closing
  it "would mean making the walk bidi-aware, a rendering question in a module that is deliberately
  DOM-free" — over-claimed.** `frame.ts`'s walk is not DOM-free and already inspects tag names and
  attributes (that is exactly how `attrTextOf` works), so a `<bdo dir>` check is well within reach:
  it could mark the run the way part 3a marks a U+202E, at the same place attribute text is read.
  What it costs is the honest objection: `dir` is an ordinary, correct attribute in real
  right-to-left mail, so the check has to fire on the *override* (`<bdo>`, whose entire purpose is
  overriding) and not on `dir` generally, and it makes `link-host.ts`'s pure-string interface carry
  a flag the walk computes. That is a design decision worth a wave; it is not infeasible, and this
  document should not have implied it was.
- **The dialog agrees with itself when an override names no host.** Part 3a warns unconditionally,
  but `LinkVerdict.mismatch` must carry an ASCII host, and where no reading of the text names one
  there is nothing honest to put there but the target. The reader is stopped and shown the real
  destination; the "the link says X / it actually opens X" wording is wrong. Pinned as a test. A
  proper fix needs a verdict shape the app can render without a claimed host, i.e. a change in
  `use-link-opener.ts` and the interstitial's copy, which is outside this ADR.
- **A bare IP claim.** `192.168.1.1` has no alphabetic last label, so it names nothing.
- **`https://bank.test@evil.tld` userinfo in the TEXT.** Silent on purpose: the text and the target
  agree, and deceptive URL text is the browser's problem, not a host mismatch.
- **`bank。test` with U+3002 IDEOGRAPHIC FULL STOP.** NFKC does not fold it to `.`, so the word is not
  host-shaped and claims nothing — while the URL parser treats U+3002 as a label separator, i.e. a
  browser really would go to `bank.test`. Asserted in both halves.
- **RAW fusing across a `<br>`** — `<a>Bank AG<br>bank.test</a>` yields `AGbank.test` and warns.
  A false *positive*, pre-existing, and monotonicity means the union cannot delete it.
- **The no-Public-Suffix-List family** (`co.uk` over-breadth, filename-shaped text, ASCII-only bare
  hosts), unchanged and documented in `link-host.ts`.
- **The character sets themselves are not closed, and cannot be.** "Renders blank" is a *font* fact,
  not a Unicode property: unassigned code points, private-use areas and font fallback can all draw as
  something blank-ish, and nothing here would know. "Renders reversed" is a *rendering* fact for the
  same reason — the bidi algorithm depends on context a string does not record. Every hole cited
  through wave 4 is plugged; the three cited in wave 5 are **not**, and are the entries above. Neither
  class is shut, and a future review should expect to find another member of both.
- **The absence of a dialog is not a statement of safety, and no user-visible string says it is.**
  The interstitial's copy describes only the mismatch it found; there is no "this link is verified"
  string anywhere. That was checked. A reader will nonetheless read silence as approval, which is
  the standing argument for spending the false-positive budget carefully rather than for claiming
  coverage.

### Rejected alternatives

- **Claims from every contiguous run of boundary-separated segments.** Closes the split-host
  residual (`bank` + `.test` recombines whatever is glued after it), but it is O(n²) in the number
  of elements inside one anchor, on attacker-authored input, on a click — and `link-host.ts` refuses
  to clamp the text for well-argued reasons, so an unclamped quadratic scan is not available.
- **A magnitude ceiling on positive lengths.** Composes away under nesting: ten nested spans at just
  under the ceiling each add up to the same displacement, and elements are free for an attacker.
- **Making the classifier visibility-aware.** It could not live in `link-host.ts` (pure, DOM-free)
  and it would be a partial oracle: it would kill `display:none` and `font-size:0` and it would not
  touch `color:#fff`, `opacity:0` or `transform:scale(0)`.

### Interface note

`MailLinkInfo.text` is not a display string — it carries both renderings when the anchor has element
children. `MailLinkInfo.raw` is the field to show a human, and since wave 3 it is `textContent`
**plus** the text descendants render out of attributes, not `textContent`. Its doc comment said
"Empty for an image-only link or an `<area>`" until wave 4 — describing the state of affairs *before*
wave 3 made exactly those two cases non-empty — and now says what the code does. The doc comment on
`apps/web/src/mail/MailBodyFrame.tsx`'s `onOpenLink` still describes `info.text` as "what the reader
saw" and should be corrected when that file is next touched.

### Mutation record

Every guard added or changed here was deleted and the suite required to object.

Waves 2–3, in summary and superseded by nothing below: the allowlist made a no-op (85 failures), its
visually-zero constraint deleted (27), that constraint's floor lowered back to exactly zero (10), its
negative-value constraint deleted (8), the hiding families put back on the allowlist (43), the anchor
scope removed (19) and widened to include the `<a>` itself (2), the `hidden` clause removed (2), the
empty-style cleanup removed (56), the `alt` emission deleted (7), the `alt`'s element fences deleted
(2), `title` added to the emission (2 — see the caveat below), the `Default_Ignorable_Code_Point`
strip reverted to `\p{Cf}` alone (4), the U+2800 branch deleted (4), its split reading deleted (2),
its stripped reading deleted (2), and `linkTextOf` made recursive (1, a `RangeError` inside the
walk).

**The wave-3 `title` row was not the proof it read as.** The checker re-ran it against wave 3's own
fixtures and the suite stayed green at 427/427, because those fixtures put `title` on elements the
function never inspects. It is re-run below against the moved fixtures.

Wave 4, each mutation applied alone unless marked, against `packages/mail-html`'s 493 tests:

| mutation | failures |
| --- | --- |
| the `(`-rejection in `isUnreadableSize` deleted | 13 |
| its `!Number.isFinite` early return deleted | 1 |
| `splitDeclarations` replaced by `css.split(';')` | 3 |
| its quote tracking deleted | 2 |
| its paren-depth tracking deleted | 1 |
| its backslash-escape branch deleted | 1 |
| **composite:** quote *and* paren tracking deleted together | 4 |
| the property-name `trim` deleted | 2 |
| the property-name `toLowerCase` deleted | 2 |
| the property-name `cssUnescape` deleted | 2 |
| **composite:** all three property-name normalisations deleted together | 4 |
| the value-side `cssUnescape` before `NEGATIVE_VALUE` deleted | 1 |
| `title` added to `attrTextOf`'s `<img>` return | 1 |
| `title` added to `attrTextOf`'s `<input>` return | 1 |
| the image-button `alt` branch deleted | 3 |
| the `<input value>` read deleted | 4 |
| the `placeholder` reads deleted | 1 |
| the `<option>`/`<optgroup>` `label` read deleted | 2 |
| the unpainted-`<input type>` skip deleted | 7 |
| **composite:** `attrTextOf` reverted to wave 3 (`<img>`/`<area>` `alt` only) | 7 |
| the unconditional bidi-override mismatch deleted | 1 |
| the reversed reading deleted | 3 |
| **composite:** both bidi terms deleted together | 5 |
| `BIDI_OVERRIDE` widened to every bidi control (the narrowness guard) | 10 |
| `reverseCodePoints` replaced by a UTF-16-unit reverse | 1 |

Two terms were found to survive their own deletion during this wave and were dealt with rather than
left: the `magnitude === 0` early return in the old `isVisuallyZero` was **dead** (every unit's floor
is above zero, so the branch below it already returned `true`) and has been **deleted**; the
paren-depth term in the splitter survived until a fixture was written that shows it refusing to lift
a declaration out of a rejected one's parentheses, and it is the row above. No guard now survives its
own deletion.

**Wave 5 added no guard and changed no behaviour**, so it has no rows. It changed only sentences, and
the table in *Context* records what each of them had claimed. Note what that means for the table
above: the numbers are unchanged and still valid, and they say nothing about the three residuals wave
5 documented — a mutation record proves that the guards which exist are load-bearing, never that the
guards which exist are enough. It has read as the second at least twice in this file's history.

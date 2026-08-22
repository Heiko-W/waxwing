/**
 * Does a mail link go where its text says? (FR-RD-08, M3.9 step 3 — phishing friction.)
 *
 * Pure and DOM-free. The check CANNOT live inside the frame: `frame.ts` mounts the body under
 * `sandbox="allow-same-origin"` with no `allow-scripts` and an inner `script-src 'none'`, so nothing
 * executes in there, by design. This runs in the app instead, on the click the frame already
 * intercepts (tech-stack §4.5 step 3: "re-dispatched with `noopener` + visible target host").
 *
 * ## Everything here is a false-positive budget
 * A warning readers learn to click through is worse than no warning: it trains exactly the reflex
 * phishing needs. So a link's text only "claims a host" when it plausibly NAMES one — an `http(s)`
 * URL, or a conservative bare-host shape. "Click here", "Rechnung ansehen", an email address,
 * `invoice.pdf` and empty text are all {@link LinkVerdict} `ok`: not suspicious, just silent.
 *
 * ## The href is resolved against a base, because the browser resolves it too
 * {@link classifyLink} and {@link displayHost} take an optional `base` and parse with
 * `new URL(href, base)`; the app passes `window.location.href`. Without one, `//evil.tld/steal` does
 * not parse at all, and "does not parse" here means `unparsable`, which the caller reads as "not a
 * web link — open it normally". It is very much a web link: the browser resolves the
 * protocol-relative form against the app's own origin and lands on `https://evil.tld/steal` with no
 * dialog, while the byte-identical destination written `https://evil.tld/steal` warns. `\\evil.tld`,
 * a leading-space variant, and the single-slash `https:/evil.tld/x` are the same family — and that
 * last one is worse than silence, because unbased parsing NAMES `evil.tld` in the dialog when the
 * browser will actually go to the app's own origin. Whatever `new URL` resolves against the app's
 * base is where the click lands, so it is the only honest thing to classify.
 *
 * With a base, `unparsable` narrows to what it always meant: a non-`http(s)` scheme (`mailto:`,
 * `tel:`). A relative href now resolves to the app's own host and is compared like any other — a
 * link labelled `bank.test` that opens the webmail app is worth the same interruption.
 *
 * ## The text is normalised the way the reader's eye normalises it
 * `bank<U+200B>.test` renders pixel-identical to `bank.test` and is a different string; so does the
 * full-width `ｂａｎｋ.test`. Both used to pass as "not host-shaped" and open in silence. The text is
 * therefore NFKC-normalised — folding the full-width and compatibility forms a reader cannot tell
 * apart — and stripped of every character that DRAWS NO GLYPH: `\p{Cf}` (U+200B ZWSP, U+00AD SOFT
 * HYPHEN, U+200C ZWNJ, U+2060 WORD JOINER …) and `\p{Default_Ignorable_Code_Point}`, which is not the
 * same set — 4036 code points are default-ignorable and NOT `\p{Cf}`, U+034F COMBINING GRAPHEME
 * JOINER and the Hangul fillers among them. NOT ONE of either family is removed by
 * `String.prototype.trim`, which cuts `\s` — a zero-width character is not whitespace. That is
 * precisely how they got through.
 *
 * Stripping a character that draws no glyph is right only when it also has no effect on what IS
 * drawn, and two of the characters in that strip fail that test. U+202E RIGHT-TO-LEFT OVERRIDE and
 * U+202D LEFT-TO-RIGHT OVERRIDE draw nothing themselves and REVERSE the visual order of everything
 * after them, so `&#x202E;nigol/tset.knab` reads to the reader as `bank.test/login` while the strip
 * handed the classifier `nigol/tset.knab` — no claim, and silence. Their presence is now a mismatch
 * on its own: we cannot know what was seen, so we warn. {@link BIDI_OVERRIDE} sets out which
 * characters reverse order and which merely set direction, and why the latter — the marks, the
 * embeddings and the isolates that fill legitimate right-to-left mail — must NOT trigger it.
 *
 * A character that renders as a blank ADVANCE is a different problem and gets the opposite treatment.
 * U+2800 BRAILLE PATTERN BLANK is neither `\s` nor invisible: `bank.test⠀Login` was ONE word to the
 * tokeniser, host-shaped in no way at all, and so claimed nothing and opened in silence — with no CSS
 * and no elements involved, which is why neither the two renderings below nor the sanitizer touched
 * it. Such a word is read BOTH ways, split and stripped, and the union of the claims is taken. See
 * {@link BLANK_ADVANCE} for why both and what it costs.
 *
 * This normalises the CLAIM only. The target host is never touched: `URL.hostname` has already put
 * it through IDNA, and confusing the two normalisations would undo the punycode defence below.
 *
 * ## Any host-shaped WORD is a claim — a deliberate reversal (M3.9 review)
 * The gate used to be anchored over the WHOLE text, on the theory that a host mentioned inside prose
 * is not offered as a destination and so claims nothing. That was wrong twice.
 *
 * Wrong in principle: text that NAMES a host while the link goes elsewhere is deceptive whether or
 * not prose surrounds it. "Login at bank.test" points the reader's eye at `bank.test` exactly as
 * hard as `bank.test` alone does.
 *
 * Wrong in practice, and this is the fatal half: the attacker writes the string, so a single
 * character bought them out of the check completely. `bank.test.`, `bank.test!`, `Login at
 * bank.test` — each one anchored-unshaped, each one silently opened. A gate you can leave with one
 * keystroke is not a gate.
 *
 * So: split the normalised text on whitespace, strip surrounding punctuation from each word, and
 * treat ANY host-shaped word as a claim. Tokenising closes hidden markup in the same move —
 * `<a href="https://evil.tld/"><span style="display:none">!</span>bank.test</a>` arrives here as the
 * text `!bank.test`, which the reader sees as `bank.test` and an anchored gate saw as prose.
 *
 * ## EVERY claim must be honoured, not merely one of them (G2 review)
 * Tokenising fixed the direction in which hidden text DESTROYS a claim, and opened the opposite one,
 * in which hidden text ADDS a claim that is already satisfied. The rule used to be "if ANY claim
 * covers the target, the link is `ok`", justified with benign prose — "bank.test's help centre lives
 * at help.bank.test". That is a benign-AUTHOR rationale applied to attacker-authored input, and the
 * attacker writes the text:
 *
 *     <a href="https://evil.tld/steal"><span style="display:none">evil.tld </span>bank.test</a>
 *
 * The reader sees `bank.test`. The claims are `['evil.tld', 'bank.test']`, the first one covers the
 * target, and the link opened with no dialog at all — the interstitial `use-link-opener.ts`
 * deliberately made non-disableable simply never appeared. Reproduced with `display:none`, the
 * `hidden` attribute, `font-size:0` and `color:#fff`, with the hidden word on either side of the
 * visible one, and against a subdomain of the hidden claim. (Of those four, only `color:#fff` still
 * survives `sanitize` inside an anchor — see the two sections below and ADR-016. The verdict does not
 * depend on which was used, which is the point of reading the claim here rather than guessing there.)
 *
 * So the quantifier is inverted: `ok` requires EVERY claim in the text to cover the target, and the
 * dialog reports the first claim that does NOT. That is what makes the rule MONOTONE: adding a claim
 * can only move a verdict from `ok` toward `mismatch`, never back. Monotonicity is the property the
 * rest of this file leans on, and it is worth stating carefully, because the first version of this
 * comment overstated it. Inverting the quantifier does NOT by itself mean "no hiding technique can
 * restore silence" — it means that *given the same claim set plus extras*, silence cannot be restored.
 * Whether the visible host is IN the claim set at all is a separate question, and it is the one the
 * next section exists to answer.
 *
 * Do NOT instead make the text visibility-aware, i.e. walk the anchor's descendants and skip what is
 * not rendered. It is the obvious move and it is a trap: it would kill `display:none`, `hidden`,
 * `visibility:hidden` and `font-size:0`, and it would not touch `color:#fff`, `opacity:0`,
 * `position:absolute;left:-9999px`, `transform:scale(0)` or `text-indent`. A partial visibility
 * oracle is worse than none, because it reads as a closure — and it could not live in this module in
 * any case: this is pure and DOM-free, and is handed a string.
 *
 * ADR-016 does not contradict this. It has `sanitize` filter a descendant's inline style inside an
 * anchor against a property ALLOWLIST, so that the commonest hiding spellings do not render; it never
 * SKIPS text, and no verdict here depends on it. Nothing in this file has an opinion about what is
 * visible, and that independence is the point: the sanitizer's rule cannot close hiding (it keeps
 * `color` on purpose), and the verdicts here do not need it to.
 *
 * ## The claim set is read from TWO renderings, because `textContent` has no separators (wave-2 fix)
 * Inverting the quantifier was necessary and is not sufficient, because a claim is tokenised out of a
 * string that has ALREADY lost the DOM boundaries. Whitespace is the only separator `claimedHosts`
 * knows, and the attacker simply does not use whitespace. Two families follow, and they are one bug:
 *
 *     <a href="https://evil.tld/steal"><span style="display:none">evil.tld/</span>bank.test</a>
 *     textContent === 'evil.tld/bank.test'   — ONE word: text nodes concatenate with NO separator
 *
 * {@link BARE_HOST}'s optional path group swallows `/bank.test`, so the claim set is `['evil.tld']`:
 * the visible claim was not merely joined by a hidden one, it was REPLACED by it, and every claim is
 * honoured. The mirror image glues junk AFTER the visible host so that no claim is produced at all:
 *
 *     <a href="https://evil.tld/steal">bank.test<span hidden>x9</span></a>
 *     textContent === 'bank.testx9'          — last label `testx9` is not ≥2 LETTERS, so: no claim
 *
 * Both returned `ok` and opened with no dialog. The fix is to stop pretending one string is the whole
 * story. `frame.ts` produces TWO renderings of an anchor's text and {@link classifyLink} takes both
 * (see {@link LinkText}):
 *
 *  - **RAW** — the text nodes concatenated with no separator (`textContent`), plus the text a
 *    descendant renders out of an ATTRIBUTE rather than a text node — an `<img>`/`<area>`/image-button
 *    `alt`, an `<input>` `value`/`placeholder`, an `<option>` `label` — which `textContent` omits and
 *    a reader reads. `frame.ts`'s `attrTextOf` enumerates the set.
 *  - **SEPARATED** — the same runs joined with a space at every ELEMENT boundary, and only there. A
 *    comment is not an element, so `bank.test<!--c-->x9` is ONE run in both renderings. That gap is
 *    deliberate and is not a hole: a comment renders nothing, so the reader sees the same fusion.
 *
 * The claim set is the UNION of the claims of each, and — unchanged — every claim in the union must
 * cover the target. Union is the right shape precisely BECAUSE of the monotonicity above: another
 * rendering can only add claims, and an added claim can only make the verdict stricter, so adding a
 * rendering can never turn a `mismatch` into an `ok`. That statement is about renderings only, and it
 * is true as written.
 *
 *  - FORGE: raw `{evil.tld}` ∪ separated `{evil.tld, bank.test}` → `bank.test` fails → mismatch.
 *  - DESTROY: raw `{}` ∪ separated `{bank.test}` → mismatch.
 *  - A legitimately styled host, `<b>bank</b>.test` over `https://bank.test/`: raw `{bank.test}` ∪
 *    separated `{}` → covered → `ok`. The RAW rendering is not redundant: over `https://evil.tld/`
 *    it is the ONLY one of the two that names `bank.test` at all.
 *  - Prose, "Click <b>here</b>": both empty → `ok`.
 *
 * ## What this does NOT close — and the list itself is not closed
 * **This gate is a best-effort heuristic against an attacker who writes both the markup and the CSS.
 * It is friction, not a verification.** Everything below is a residual that is known TODAY; five
 * successive reviews each found a family the review before it had not imagined, so the honest
 * statement is that the enumeration is open and that ABSENCE OF A WARNING IS NOT A SAFETY GUARANTEE.
 * No sentence in this file, in `sanitize.ts` or in ADR-016 may be read as "the class is shut" — where
 * one used to, it was wrong.
 *
 * **Chromatic hiding of a SPLIT host.** `<span style="color:#fff">` inside an anchor is text the
 * reader cannot see and this classifier can, and no amount of tokenising changes that. So long as the
 * visible host is ONE text node it is harmless — that host survives as its own word in the separated
 * rendering and still has to be honoured — but an attacker who BOTH splits the visible host across
 * elements AND glues colour-hidden junk to it defeats both renderings at once:
 *
 *     <a href="https://evil.tld/steal"><b>bank</b>.test<span style="color:#fff">x9</span></a>
 *     raw {} (`bank.testx9` is not host-shaped) ∪ separated {} (`bank`, `.test`, `x9`) → ok
 *
 * That returns `ok` today, and this module cannot close it. Closing it needs the RENDERED text, which
 * needs computed style against a real background — not available to a script-free frame, and a partial
 * visibility oracle is worse than none because it reads as a closure.
 *
 * What narrows it is not here but in `sanitize`: inside an `<a>` (and only there) a descendant's
 * inline style is filtered against a property ALLOWLIST, so `display:none`, `visibility:hidden`, an
 * unreadable `font-size` (including one that COMPUTES to zero out of a `calc()`), `opacity:0`,
 * `position:absolute;left:-9999px`, `clip-path:inset(100%)`, `transform:scale(0)` and every property
 * nobody there thought of are all dropped — whatever their spelling, `!important` included. It
 * narrows the attack; it does not close it. `color` and `background` stay on that allowlist ON
 * PURPOSE (white-on-coloured button text inside an anchor is ordinary mail, and dropping the
 * background alone would render legitimate text white-on-white), the frame paints a known white
 * canvas, and a large POSITIVE `padding-left` or `border-left-width` displaces a run just as well as
 * a negative one. So hiding text inside a link remains available to an attacker who wants it, and the
 * sanitizer's contribution is to make the cheap spellings stop working. ADR-016 records that, and the
 * reversal of this file's former position ("the fix belongs where the claim is READ, not in a
 * sanitizer").
 *
 * **A `title` that names a host.** `<a href="https://evil.tld/" title="bank.test">Click here</a>`
 * claims nothing here: `frame.ts` does not put `title` into either rendering, because a title
 * surfaces on hover only and never on touch, so it is text the reader most likely never read, while
 * `title="shop.example.com"` on a tracked link is an ordinary newsletter shape. A deliberate
 * false-positive judgement with a cost, pinned by tests on the elements `frame.ts` actually reads
 * attributes off — which is where wave 3's pin was NOT, so it proved nothing until wave 4 moved it.
 *
 * **`<bdo dir="rtl">`, the MARKUP spelling of a bidi override.** The character-level rule below
 * catches U+202D/U+202E; `sanitize` keeps `<bdo>` and its `dir`, and nothing here sees markup. The
 * reader is shown a reversed run, this module reads the written order, and a text whose reversal is
 * host-shaped claims nothing. Asserted as the `ok` it is.
 *
 * **The rest, each pinned by a test rather than left to prose:** a bare IP claim (`192.168.1.1` is
 * not host-shaped, so it names nothing); `https://bank.test@evil.tld` userinfo in the TEXT, silent on
 * purpose — the text and the target agree, and deceptive URL text is the browser's problem;
 * `bank。test` written with U+3002 IDEOGRAPHIC FULL STOP; RAW fusing across a `<br>`, which is a false
 * POSITIVE and not a bypass; and the whole no-Public-Suffix-List family further down.
 *
 * **And the shape of the whole list.** "Renders blank" and "renders reversed" are FONT and RENDERING
 * facts, not Unicode properties: unassigned code points, private-use areas and font fallback can all
 * draw as something blank-ish, and the bidi algorithm is context-sensitive in ways a string does not
 * record. Each cited hole below is plugged; none of the classes is shut.
 *
 * ## The cost, in full
 * Seven shapes now warn where an anchored, any-claim-clears, single-rendering, text-nodes-only gate
 * stayed quiet. All seven are the same trade: false-positive budget spent so that the check has no
 * opt-out. Seven is the count TODAY, not a bound — each of the five reviews so far has added to it.
 *
 *  - **A tracked link** — text `shop.example.com`, href `links.mailer.test/c/abc`. The newsletter
 *    shape, warned about since the tokenising reversal. That click genuinely IS a redirect through a
 *    third party the text does not name, so the reader is not being told a lie.
 *  - **An anchor whose text names more hosts than the link honours.** Wrapping a run of prose in one
 *    `<a>` is the usual way in: a footer reading "Sent by example.com on behalf of partner.test", or
 *    a body naming both a host and its child ("bank.test and status.bank.test") while linking to only
 *    one. Note what does NOT hit: the subdomain rule means a claim on `bank.test` covers a target of
 *    `help.bank.test`, so the old comment's own example — "bank.test's help centre lives at
 *    help.bank.test", linked to the help centre — is still silent. What warns is text that named a
 *    host the click does not reach, which is exactly what the dialog then says.
 *  - **A host-shaped FRAGMENT that only the separated rendering can see.** Splitting a word can only
 *    ADD claims, and a split-off piece is occasionally host-shaped on its own: `bank.test` followed by
 *    `<span>/partner.test</span>`, linked to `bank.test`, now warns because the separated rendering
 *    reads `/partner.test` as a word and trims it to a claim on `partner.test`. Narrow, and the text
 *    did put a second host name in front of the reader.
 *  - **An attribute-borne label that names a host the link does not reach.** Reading an `<img alt>`
 *    (wave 3) and an image-button `alt`, an `<input value>`/`placeholder` and an `<option label>`
 *    (wave 4) makes a link claim what those say, so a logo alt-texted `bank.test` inside a link to a
 *    tracking redirector now warns. The reader really is shown that host — the remote `src` is
 *    stripped by default, so the alt is what renders — and a logo alt-texted with its OWN link's host
 *    stays silent, which is the common case.
 *  - **Text that uses U+2800 as a spacer beside a host name.** `bank.test⠀Login` linked to
 *    `bank.test` warns, because the stripped reading of that word claims `bank.testlogin`. It needs a
 *    braille blank AND a host name in one link's text; see {@link BLANK_ADVANCE} for why the reading
 *    that costs this is also the one that catches the de-shaping attack.
 *  - **Any link text containing U+202D or U+202E, whatever it says.** The override makes the written
 *    order and the shown order two different strings, so the honest answer is that we do not know what
 *    was read — see {@link BIDI_OVERRIDE}. Narrow by construction: the marks, embeddings and isolates
 *    that fill legitimate right-to-left mail do NOT trigger it, and Unicode itself recommends the
 *    isolates over the overrides, so what remains is close to unused in real mail.
 *  - **A link whose text names no host at all but carries an override.** The same rule, in the corner
 *    where it reads worst: with no claim to print, the dialog names the target on both lines and so
 *    agrees with itself. Pinned as a test, listed in ADR-016, and the price of failing closed.
 *
 * And one false positive that is NOT new and is not fixed here: the raw rendering fuses across
 * boundaries, so `<a>Bank AG<br>bank.test</a>` yields the word `AGbank.test` and warns. The separated
 * rendering adds the correct `bank.test` claim beside it, but monotonicity cuts both ways — an added
 * claim cannot delete the fused one.
 *
 * Paying that beats the alternative, which was an attacker switching the whole check off with one
 * invisible word.
 *
 * ## Punycode is the point — never render the Unicode form
 * `URL.hostname` yields the ASCII/punycode (`xn--`) form, and BOTH the comparison and the display
 * use it. `https://аpple.com` (Cyrillic а) becomes `xn--pple-43d.com`, which no longer equals
 * `apple.com` — the IDN-homograph defence, for free. Mapping it back for display would undo it: a
 * reader shown `xn--pple-43d.com` has been told the truth; a reader shown `аpple.com` has been lied
 * to by their own renderer.
 *
 * ## Known limits — no Public Suffix List (~30 KB for a heuristic)
 * The comparison is "the same host, or a subdomain of the claimed one", so `mail.google.com` under a
 * text of `google.com` is not phishing, while `bank.com.evil.com` under a text of `bank.com` is
 * caught. Three weaknesses follow, and none is fixable without a list:
 *
 *  - **Over-broad at the top of the tree.** A text of `co.uk` would accept any `*.co.uk` target. The
 *    "must contain a dot and a ≥2-char alphabetic last label" gate mitigates this (`com` alone is not
 *    a claim) but does not eliminate it.
 *  - **Filename-shaped text needs a denylist.** `invoice.pdf` is a host shape, and only a real TLD
 *    list could say otherwise. {@link FILE_EXTENSIONS} is the cheap approximation.
 *  - **Only ASCII bare hosts are claims.** A bare Cyrillic `аpple.com` is not host-shaped to
 *    {@link BARE_HOST}, so it claims nothing. Written with a scheme it is punycoded and compared like
 *    anything else.
 */

/**
 * THE LINK TEXT IS NOT CLAMPED, AND MUST NOT BE. This constant is gone on purpose; do not bring it
 * back as a "defensive bound".
 *
 * A clamp looks free — a link's subtree can be megabytes, the host it claims cannot be — and it was
 * safe under the old gate, where a claim had to start at character 0. Tokenising a claim out of
 * anywhere in the text inverts that, and the attacker writes the text:
 *
 *     <a href="https://evil.tld/"><span style="display:none">AAAA…2100 chars…</span>bank.test</a>
 *
 * The reader sees `bank.test`. A head clamp sees only padding, finds no claim, and opens `evil.tld`
 * without a word. Proved against this module: 3 of 4 padding placements returned `ok`. And no clamp
 * shape survives — clamp the head and the padding goes in front, clamp head AND tail and it goes in
 * the middle. The padding hides behind `display:none`, which the sanitizer keeps for good reasons and
 * which nothing here can see (the frame is script-free, so there is no computed style to consult).
 *
 * So the whole text is scanned, always. The cost is one O(n) pass per CLICK — not per render — over a
 * string the browser is already holding, and it is bounded by the mail body itself. That is the price
 * of the check meaning anything.
 */

export type LinkVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'mismatch'; readonly claimedHost: string; readonly targetHost: string }
  | { readonly kind: 'unparsable' }

/**
 * The two renderings of one anchor's text (see the header). `frame.ts` produces both; nothing else
 * can, because both are DOM facts and this module is DOM-free.
 */
export interface LinkText {
  /** The text nodes concatenated with NO separator, plus any descendant `<img>`/`<area>` `alt`. */
  readonly raw: string
  /** The same runs, joined with a space at every ELEMENT boundary — and only there. */
  readonly separated: string
}

/**
 * Flatten a {@link LinkText} to the single string {@link classifyLink} tokenises.
 *
 * A newline, and not some marker, because {@link claimedHosts} splits on whitespace: the words of
 * `separated + '\n' + raw` are exactly the words of `separated` plus the words of `raw`, so the claim
 * set of the join IS the union of the two claim sets. No word can straddle the seam, so the join
 * cannot invent a claim that neither rendering names.
 *
 * The two are joined rather than passed separately so that there is ONE tokenising pass and one
 * claim-ordering rule — the dialog reports the first FAILING claim, so "first" has to mean something
 * stable. SEPARATED comes first, and that is a UX choice with no effect on the verdict: its words are
 * contiguous runs of the DOM, so a host-shaped word in it is very likely text the reader actually
 * read, whereas RAW fuses across element boundaries and can name hosts nobody wrote (`<span>x9</span>`
 * glued to `bank.test` gives raw the word `x9bank.test`). Both orders warn on exactly the same links;
 * this one warns with the reader's own host in the sentence more often.
 *
 * When the renderings are identical — an anchor with no element children, which is most of them —
 * the join is skipped. That is an optimisation with no effect on the verdict: `claimedHosts` would
 * simply see every claim twice, and a claim repeated is still covered or still not.
 */
export function joinLinkText(text: LinkText): string {
  return text.raw === text.separated ? text.raw : `${text.separated}\n${text.raw}`
}

/**
 * A bare host, optionally followed by a path: host characters, at least one dot, and a last label of
 * ≥2 letters. Anchored — but over one punctuation-stripped WORD, not over the whole text (see the
 * reversal note in the file header).
 *
 * **Unicode letters, not `[a-z]`, and that is the homograph defence doing its job.** An ASCII-only
 * gate means a bare `аpple.com` (Cyrillic а) is not host-shaped, claims nothing, and opens `evil.tld`
 * with no warning — i.e. the defence would only work against attackers who politely write `https://`
 * first. Accepting the word lets the URL parser below punycode it to `xn--pple-43d.com`, which no
 * longer equals `apple.com` and is what the reader is then shown.
 *
 * The excluded characters are the ones that mean a word is NOT a bare host: `/@:?#` (a path, an email
 * address, a scheme, a query, a fragment) — each is handled by another branch or is not a claim at
 * all. The last label must be letters, so `192.168.1.1` and `19.99` name nothing.
 */
const BARE_HOST = /^[^\s/@:?#]+\.\p{L}{2,}(\/.*)?$/u

/**
 * Characters that draw no glyph of their own, and are therefore stripped from a word before its shape
 * is tested, so that what we gate on is the string the reader saw.
 *
 * **Drawing no glyph is not the same as having no effect on what is drawn, and this constant used to
 * conflate the two** — it said these "render as NOTHING", and the bidi controls it strips include two
 * that reorder every character after them. That is what {@link BIDI_OVERRIDE} exists for: the strip
 * below stays as it is, and the override is detected on the word BEFORE the strip runs.
 *
 * `\p{Cf}` is the format characters: U+200B ZWSP, U+00AD SOFT HYPHEN, U+200C ZWNJ, U+2060 WORD
 * JOINER, U+FEFF, U+180E and the rest of that family. Not one of them is removed by
 * `String.prototype.trim`, which cuts `\s`, and a zero-width character is not whitespace — which is
 * precisely how they got through in the first place.
 *
 * `\p{Default_Ignorable_Code_Point}` is the wave-3 addition and is not a superset of the first: 4036
 * code points are default-ignorable, NOT `\p{Cf}` and NOT `\s`, so they were reaching the shape test
 * intact. U+034F COMBINING GRAPHEME JOINER, the Hangul fillers U+115F/U+1160/U+3164/U+FFA0, the
 * variation selectors U+FE00–U+FE0F and the U+E0000 tag block are all in that gap. (Enumerated
 * against the engine's own property data rather than recalled: `\p{Cf}` and default-ignorable
 * overlap, neither contains the other.)
 *
 * Both are STRIPPED rather than treated as separators, and the direction matters. A character that
 * renders as nothing leaves the reader looking at one fused word, so the tokeniser must see one
 * fused word too. Splitting on them instead would DE-SHAPE a claim the reader can plainly read:
 * `bank<U+034F>.test` renders pixel-identically to `bank.test`, and split into `bank` + `.test` it
 * names no host at all and opens in silence.
 */
const INVISIBLE_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

/**
 * The two bidi controls that make the reader see the characters after them in a DIFFERENT ORDER from
 * the one they are written in. Their presence in a link's text is, on its own, a mismatch (A4c).
 *
 *     <a href="https://evil.tld/steal">&#x202E;nigol/tset.knab</a>
 *
 * renders to the reader as `bank.test/login`. U+202E draws nothing itself, so {@link INVISIBLE_CHARS}
 * removed it and the classifier then read `nigol/tset.knab`, which is host-shaped in no way at all —
 * no claim, and the link opened in silence. No CSS and no elements: the assumption the property
 * allowlist in `sanitize.ts` rests on, defeated by a character that is invisible by definition.
 *
 * ## Which characters reverse rendered order, and which merely set direction
 * Getting this narrow is the whole job, because the ordinary controls are common in legitimate
 * right-to-left mail and warning on them would be a false-positive tax on every such message. The app
 * ships German and English today, but this module is shared and RTL readiness is a tracked M4
 * concern, so the line is drawn on what the Unicode Bidirectional Algorithm actually does:
 *
 *  - **U+202E RLO and U+202D LRO are OVERRIDES, and only they are matched here.** An override assigns
 *    a strong direction to every character in its scope, DISCARDING the character's own class. Under
 *    RLO the whole run is laid out right-to-left, so what is displayed is the reverse of what is
 *    written; under LRO the same happens to Hebrew/Arabic text, which is then laid out in logical
 *    order, i.e. reversed from how it normally reads. These two can change the SEQUENCE the reader
 *    perceives.
 *  - **U+202A LRE and U+202B RLE are EMBEDDINGS and are NOT matched.** They set the direction of the
 *    surrounding level; each character keeps its own class, so a Latin run inside an RLE still reads
 *    left to right. They reorder runs and neutrals, never the letters inside a run.
 *  - **U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI are ISOLATES and are NOT matched.** Embeddings
 *    plus isolation from the surrounding context; the same argument applies, and these are the forms
 *    Unicode actively recommends, so they are what well-formed multilingual mail contains.
 *  - **U+200E LRM, U+200F RLM and U+061C ALM are NOT matched.** They are invisible characters with a
 *    direction of their own and affect the placement of neighbouring NEUTRALS only. They are ordinary
 *    punctuation-fixing marks in real Arabic and Hebrew mail.
 *  - **U+202C PDF is NOT matched.** It pops an embedding or an override rather than starting one.
 *
 * ## The verdict does not depend on reconstructing the rendering
 * Two separate things happen when an override is present, and only the first one decides anything:
 *
 *  1. **{@link classifyLink} returns a mismatch, unconditionally.** We cannot know what the reader
 *     saw — the algorithm is context-sensitive, a U+202C can end the override's scope mid-word, and
 *     the surrounding paragraph direction is a property of the rendering, not of this string. So we
 *     fail closed and let the interstitial name the real target.
 *  2. **{@link claimedHosts} additionally reads such a word REVERSED**, and that is best-effort and
 *     affects only WHICH host the dialog names. For a pure RLO run the display order is the reverse
 *     of the logical order, so this recovers `bank.test` from `nigol/tset.knab` and the dialog then
 *     reads "the link says bank.test / it actually opens evil.tld", which is what the reader needs.
 *     It is sound to be approximate here precisely because it cannot change the verdict: an added
 *     claim can only move a verdict toward `mismatch`, and step 1 has already produced one.
 *
 * **What this does not cover.** `<bdo dir="rtl">` is the markup spelling of the same override and
 * survives `sanitize`; this is a character-level rule and does not see it. Recorded in ADR-016.
 */
const BIDI_OVERRIDE = /[\u202D\u202E]/u

/** Reverse by CODE POINT, so a surrogate pair is moved rather than split into two broken halves. */
function reverseCodePoints(value: string): string {
  return [...value].reverse().join('')
}

/**
 * Characters that render as a BLANK ADVANCE — a gap the reader reads as a word break — while being
 * neither `\s` (so {@link WORDS} does not split on them) nor invisible (so the strip above does not
 * remove them). U+2800 BRAILLE PATTERN BLANK is the one known member: a braille cell with no dots
 * raised, category `So`, not default-ignorable, and drawn as empty space at the width of a cell.
 *
 *     <a href="https://evil.tld/steal">bank.test⠀Login</a>       (U+2800 between)
 *
 * The reader sees `bank.test Login`. The tokeniser saw the single word `bank.test⠀Login`, whose last
 * label is not two-or-more letters, so no claim was produced at all and the empty-claims rule
 * returned `ok`. No CSS and no elements are needed — which is why neither the two renderings nor the
 * sanitizer's anchor allowlist touches it.
 *
 * **Both readings are taken — the word is SPLIT on it and also read with it STRIPPED.** That is a
 * decision, not a hedge: the two claim sets differ, and each catches an attack the other misses.
 *
 *  - Only SPLIT catches a fusion whose result covers the target. Text `bank.test⠀x` over a link to
 *    `https://bank.testx/`: stripped reads `bank.testx`, which IS the target, so it is honoured and
 *    the link opens in silence — while the reader was shown `bank.test` and a stray `x`. Split reads
 *    `bank.test`, which does not cover `bank.testx`, and warns.
 *  - Only STRIPPED catches de-shaping. Text `bank⠀.test`: split reads `bank` and `.test`, neither of
 *    them host-shaped, so no claim is produced and any target opens in silence. Stripped reads
 *    `bank.test` and warns. Whether a reader perceives that string as one host depends on how wide
 *    the cell draws — which is exactly why the gate should not have to guess.
 *
 * Taking both is sound because the every-claim rule is monotone: an added claim can only move a
 * verdict toward `mismatch`. The split pieces are pushed FIRST so the dialog reports the host the
 * reader actually saw rather than the fused artefact. The cost is a real false positive, and it is
 * stated in the header: a legitimate `bank.test⠀Login` linked to `bank.test` now warns, because the
 * stripped reading claims `bank.testlogin`, which does not cover `bank.test`.
 *
 * This is not a closed enumeration. "Renders blank" is a font fact and not a Unicode property —
 * unassigned code points, private-use areas and font fallback can all draw as something blank-ish,
 * and nothing here would know. One known, cited hole is plugged; the class is not shut.
 */
const BLANK_ADVANCE = /[\u2800]/u
const BLANK_ADVANCE_ALL = /[\u2800]/gu

/**
 * Surrounding punctuation on a word. Trimmed to letters/numbers at both ends so that `bank.test.`,
 * `bank.test!`, `(bank.test)` and `!bank.test` all read as the host the reader saw. Deliberately
 * `\p{L}\p{N}` and not `[a-z0-9]`: an ASCII-only trim would eat the leading Cyrillic а off
 * `аpple.com` and leave the claim `pple.com`, inventing a host nobody wrote.
 */
const TOKEN_TRIM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/**
 * Last labels that are a file extension far more often than they are a TLD. `invoice.pdf` over
 * `https://cdn.example.test/invoice.pdf` is the commonest shape in real mail that a host-shaped gate
 * gets wrong — `Rechnung.docx`, `photo.jpg`, `report.xlsx` right behind it — and each such dialog
 * spends budget the real lies need.
 *
 * `.zip` and `.mov` are deliberately ABSENT: both are registrable TLDs, so `update.zip` really can be
 * a host, and that ambiguity is the whole reason they were criticised on the day they launched. Where
 * an extension is also a TLD, this resolves toward warning.
 *
 * Applies to BARE words only. `https://invoice.pdf` keeps its claim: a scheme is the author saying
 * "this is a destination", and we take them at their word.
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'txt',
  'rtf',
  'odt',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'htm',
  'html',
  'eml',
  'json',
  'xml',
])

const OK: LinkVerdict = { kind: 'ok' }
const UNPARSABLE: LinkVerdict = { kind: 'unparsable' }

/**
 * The ASCII/punycode host an `http(s)` href opens, or `null` for anything else — `mailto:`, `tel:`,
 * garbage. (`javascript:` never reaches here: DOMPurify's `ALLOWED_URI_REGEXP` drops it during
 * sanitize, long before a click.)
 *
 * `base` is what a relative or protocol-relative href resolves against, and callers in a browser
 * should always pass `window.location.href` — see the file header on why omitting it is a hole and
 * not merely a limitation.
 */
export function displayHost(href: string, base?: string): string | null {
  const url = parseHttpUrl(href, base)
  return url === null ? null : canonicalHost(url.hostname)
}

/**
 * The ABSOLUTE `http(s)` URL an href opens, or `null` for anything else — the same test
 * {@link displayHost} applies, returning the whole URL rather than just its host.
 *
 * `frame.ts` needs the resolved form, not merely a yes/no. A message body is rendered inside an
 * `about:srcdoc` document, so a relative `/help` or a protocol-relative `//bank.test/x` resolves
 * against `about:srcdoc` there and goes nowhere — while the app's own `window.open` resolved it
 * against the app's URL. Rewriting the href to this absolute form before the browser is allowed to
 * navigate keeps the two paths landing in the same place, which is also what makes the phishing
 * gate's verdict and the browser's destination the same URL rather than two hopefully-equal ones.
 */
export function webUrl(href: string, base?: string): string | null {
  const url = parseHttpUrl(href, base)
  return url === null ? null : url.href
}

/**
 * Compare where a link SAYS it goes against where it actually goes.
 *
 * `unparsable` means "not a web link" (`mailto:`, `tel:`, malformed) — the caller opens it normally.
 * `ok` means either the text claims no host at all, or EVERY host it claims is honoured. Only
 * `mismatch` is worth interrupting a reader for; both of its hosts are ASCII/punycode and safe to
 * display verbatim.
 *
 * `text` is a {@link LinkText} whenever the caller has the anchor's DOM — that is the form that
 * closes the no-whitespace attacks in the header, and it is what `frame.ts` hands the app. A plain
 * string is accepted for callers that only ever have one rendering (and for the tests that pin the
 * tokeniser directly); it is classified as-is, so passing ONLY `textContent` reopens both families.
 */
export function classifyLink(href: string, text: string | LinkText, base?: string): LinkVerdict {
  const targetHost = displayHost(href, base)
  if (targetHost === null) return UNPARSABLE
  const claimText = typeof text === 'string' ? text : joinLinkText(text)
  // EVERY claim must be honoured — see the header. One unhonoured claim is a broken promise however
  // many honoured ones sit beside it, so an ADDED claim can only make the verdict stricter. Note what
  // that does and does not say: it is why unioning a second rendering is safe, and it is NOT a claim
  // that hidden markup can only add. Spliced without whitespace, hidden markup REPLACES the visible
  // claim (`evil.tld/` + `bank.test` tokenises to the single word `evil.tld/bank.test`) — which is
  // exactly why `text` should be a LinkText and not one string.
  //
  // The dialog reports the first FAILING claim, never `claims[0]`. Under the hidden-word attack
  // `claims[0]` is the attacker's own host, which would print "claimed: evil.tld / actually:
  // evil.tld" — a warning that agrees with itself and tells the reader nothing.
  const claims = claimedHosts(claimText)
  for (const claim of claims) {
    if (!covers(claim, targetHost)) return { kind: 'mismatch', claimedHost: claim, targetHost }
  }
  // FAIL CLOSED on an explicit bidi override. It draws nothing itself but reverses the order of
  // everything after it, so the string above is not the string the reader saw and we have no sound
  // way to work out what was — see BIDI_OVERRIDE. Warning is the only honest answer left.
  //
  // Reached only when every claim was honoured, which for the reversed reading of the attack means
  // it is not reached at all: the loop above has already reported `bank.test` against `evil.tld`.
  // What lands here is an override whose readings name no uncovered host, and the dialog then has no
  // better claim to print than `claims[0]` — or, when the text names no host in any reading, the
  // target itself, which makes the dialog agree with itself. That wording defect is the price of
  // failing closed on a case we cannot decode, and it is recorded in ADR-016 rather than hidden.
  if (BIDI_OVERRIDE.test(claimText)) {
    return { kind: 'mismatch', claimedHost: claims[0] ?? targetHost, targetHost }
  }
  // Either no word named a host — nothing was promised, so nothing can be broken — or every word
  // that named one named this one.
  return OK
}

/**
 * Every host the text names, in reading order, ASCII/punycode and `www.`-stripped.
 *
 * The whole text is walked — see the header on why clamping it is a bypass, not a bound. Words are
 * matched with a lazy `matchAll` and normalised ONE AT A TIME rather than normalising the whole
 * string up front: that keeps this a single O(n) scan with no megabyte-sized intermediates, whatever
 * a hostile body puts inside an anchor.
 */
function claimedHosts(text: string): string[] {
  const out: string[] = []
  for (const [word] of text.matchAll(WORDS)) {
    if (PLAIN_WORD.test(word)) continue
    // NFKC folds the full-width lookalikes (`ｂａｎｋ.test`); INVISIBLE_CHARS removes what draws no
    // glyph, so `bank<ZWSP>.test` is the string the reader saw. Both must happen before the shape
    // test, and both are cheap per word.
    const folded = word.normalize('NFKC').replace(INVISIBLE_CHARS, '').toLowerCase()
    // An explicit bidi override reverses the run after it, so read the word backwards TOO — pushed
    // first, so the dialog names the host the reader saw rather than the written-order artefact. The
    // ORIGINAL word is tested, because INVISIBLE_CHARS has already removed the control from `folded`.
    // This is best-effort and cannot change any verdict: `classifyLink` warns on the override itself,
    // and an added claim is monotone. See BIDI_OVERRIDE.
    if (BIDI_OVERRIDE.test(word)) pushClaim(out, reverseCodePoints(folded))
    if (BLANK_ADVANCE.test(folded)) {
      // A blank-rendering, non-whitespace, non-invisible character: both readings, split first (see
      // BLANK_ADVANCE). Union is safe because every claim must be honoured.
      for (const piece of folded.split(BLANK_ADVANCE_ALL)) pushClaim(out, piece)
      pushClaim(out, folded.replace(BLANK_ADVANCE_ALL, ''))
      continue
    }
    pushClaim(out, folded)
  }
  return out
}

/** Append the host `word` names, if it names one. */
function pushClaim(out: string[], word: string): void {
  const host = claimFromWord(word)
  if (host !== null) out.push(host)
}

/**
 * Words, i.e. runs of non-whitespace. `\s` is narrower than "looks like a gap", and both directions
 * of that are handled after this split rather than by widening it:
 *
 *  - a zero-width space is `\p{Cf}`, not whitespace, so `bank<ZWSP>.test` stays ONE word here and is
 *    repaired by {@link INVISIBLE_CHARS} — which is the point; splitting on it would DESTROY a claim
 *    the reader can plainly read;
 *  - U+2800 BRAILLE PATTERN BLANK renders as a gap and is not `\s`, so it too stays one word here and
 *    is handled per-word by {@link BLANK_ADVANCE}, which reads such a word both ways.
 */
const WORDS = /\S+/gu

/**
 * A word that provably cannot name a host, skipped before the per-word normalisation. This is a
 * PERFORMANCE gate, and it is sound rather than merely conservative: a word of ASCII letters and
 * digits alone has no dot, so {@link BARE_HOST} could never accept it; it has no `:`, so it is not a
 * URL; and NFKC leaves ASCII alphanumerics untouched, so nothing it could become has a dot either
 * (the 31 code points whose NFKC form contains one are all outside this class — checked, not assumed).
 *
 * It exists because the scan is unclamped by design: without it, 2 MB of ordinary prose costs ~430k
 * pointless normalise+replace+lowercase allocations (measured: 1.5 s). With it, prose is a regex test
 * per word.
 */
const PLAIN_WORD = /^[a-zA-Z0-9]+$/

/** The host one word names, or `null` when it names none. */
function claimFromWord(word: string): string | null {
  const candidate = word.replace(TOKEN_TRIM, '')
  if (candidate === '') return null

  // A word carrying its own http(s) scheme is a destination on its face — no shape heuristics, and
  // no FILE_EXTENSIONS opt-out, apply to it.
  const asUrl = parseHttpUrl(candidate)
  if (asUrl !== null) return canonicalHost(stripWww(asUrl.hostname))

  // Strip `www.` BEFORE the gate, not after: otherwise `www.bank` reads as a claim on the host
  // "www.bank" — `bank` satisfies the TLD shape — when it names no host at all.
  const bare = stripWww(candidate)
  if (!BARE_HOST.test(bare)) return null
  if (isFilename(bare)) return null
  // Re-parse rather than split by hand: the URL parser owns the authority/path boundary and the
  // IDNA/lowercase normalisation, and it is the same code that produced `targetHost`.
  const url = parseHttpUrl(`https://${bare}`)
  return url === null ? null : canonicalHost(url.hostname)
}

/** Whether a bare word's last host label is a document/image extension rather than a TLD. */
function isFilename(bare: string): boolean {
  const host = bare.split('/')[0] ?? bare
  return FILE_EXTENSIONS.has(host.slice(host.lastIndexOf('.') + 1))
}

function parseHttpUrl(raw: string, base?: string): URL | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.hostname === '' ? null : url
}

/**
 * `bank.test.` and `bank.test` are the same host — the trailing dot is the root-anchored FQDN form,
 * and every browser resolves the two identically. `URL.hostname` keeps it, so without this a link to
 * `https://bank.test./login` labelled `bank.test` is a mismatch against itself.
 *
 * Canonicalised at the source rather than inside {@link covers}, so the DISPLAYED host matches the
 * compared one. That costs no honesty: unlike the punycode form, the two spellings do not name
 * different places, so showing the shorter one tells the reader nothing untrue.
 */
function canonicalHost(hostname: string): string {
  return hostname.length > 1 && hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
}

/**
 * `www.` is a rendering convention, not a destination: text of `www.paypal.com` over a link to
 * `paypal.com` is the same site, and warning about it would spend the false-positive budget on the
 * single most common benign shape there is. Only the CLAIM is stripped — the target host is always
 * shown exactly as the browser will resolve it.
 */
function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host
}

/** The claim is honoured when the target IS the claimed host, or sits underneath it. */
function covers(claimedHost: string, targetHost: string): boolean {
  return targetHost === claimedHost || targetHost.endsWith(`.${claimedHost}`)
}

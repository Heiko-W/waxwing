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
 * apart — and stripped of every `\p{Cf}` format character: U+200B ZWSP, U+00AD SOFT HYPHEN, U+200C
 * ZWNJ, U+2060 WORD JOINER and the rest of that family are all `\p{Cf}`, and NOT ONE of them is
 * removed by `String.prototype.trim`, which cuts `\s` — a zero-width character is not whitespace.
 * That is precisely how they got through.
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
 * treat ANY host-shaped word as a claim. If ANY claim covers the target the link is `ok`; otherwise
 * the FIRST claim is what the dialog reports. Tokenising closes hidden markup in the same move —
 * `<a href="https://evil.tld/"><span style="display:none">!</span>bank.test</a>` arrives here as the
 * text `!bank.test`, which the reader sees as `bank.test` and an anchored gate saw as prose.
 * (`sanitize` keeps `display:none` and `hidden` deliberately: real mail leans on them constantly,
 * preheaders above all. The fix belongs where the claim is READ, not in a sanitizer that would have
 * to start guessing what is visible.)
 *
 * The cost is real, and accepted: a newsletter whose link text names a domain but routes through a
 * click-tracker (text `shop.example.com`, href `links.mailer.test/c/abc`) now warns where it used to
 * stay quiet. That shape genuinely IS a redirect through a third party the text does not name, so
 * the reader is not being told a lie — and paying budget there beats the alternative we had, which
 * was letting every attacker opt out of the check with a full stop.
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
 * Format characters (`\p{Cf}`) — zero-width and invisible to a reader, load-bearing to a string
 * comparison. Stripped from the claim so that what we gate on is what was seen. `\p{Cf}` already
 * covers U+00AD SOFT HYPHEN, so it needs no clause of its own.
 */
const FORMAT_CHARS = /\p{Cf}/gu

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
 * Compare where a link SAYS it goes against where it actually goes.
 *
 * `unparsable` means "not a web link" (`mailto:`, `tel:`, malformed) — the caller opens it normally.
 * `ok` means either the text claims no host at all, or some claim in it is honoured. Only `mismatch`
 * is worth interrupting a reader for; both of its hosts are ASCII/punycode and safe to display
 * verbatim.
 */
export function classifyLink(href: string, text: string, base?: string): LinkVerdict {
  const targetHost = displayHost(href, base)
  if (targetHost === null) return UNPARSABLE
  const claims = claimedHosts(text)
  const first = claims[0]
  // No word in the text names a host: nothing was promised, so nothing can be broken.
  if (first === undefined) return OK
  // Any honoured claim clears the link. A text may legitimately name several hosts ("bank.test's
  // help centre lives at help.bank.test"); the reader is deceived only if NONE of them is where the
  // click goes.
  for (const claim of claims) if (covers(claim, targetHost)) return OK
  return { kind: 'mismatch', claimedHost: first, targetHost }
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
    // NFKC folds the full-width lookalikes (`ｂａｎｋ.test`); FORMAT_CHARS removes the invisibles that
    // make `bank<ZWSP>.test` a different string from what the reader saw. Both must happen before the
    // shape test, and both are cheap per word.
    const host = claimFromWord(word.normalize('NFKC').replace(FORMAT_CHARS, '').toLowerCase())
    if (host !== null) out.push(host)
  }
  return out
}

/**
 * Words, i.e. runs of non-whitespace. Note a zero-width space is `\p{Cf}`, not whitespace, so
 * `bank<ZWSP>.test` stays ONE word here and is repaired by the strip above — which is the point.
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

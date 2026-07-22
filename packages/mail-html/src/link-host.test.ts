// @vitest-environment jsdom
//
// `link-host.ts` itself is pure and DOM-free, and the string-fixture blocks below (D1–D7) pin the
// TOKENISER: given this exact text, this verdict. jsdom is here for the D8/D9 blocks, which use no
// fixture strings at all — they run the REAL `sanitize`, extract the anchor's text with the REAL
// `frame.ts` walk, and hand that to `classifyLink`. Only that shape can prove anything about an
// ATTACK, because the attacker writes markup, not the string a hand-written fixture chose to imagine.
//
// Wave 1 of this fix is why the distinction is spelt out. Every one of its fixtures — including the
// ones named for the general property — separated the hidden run from the visible host with a space,
// and `textContent` concatenates text nodes with NO separator. The tests were green, the names
// claimed a closed class, and one deleted character reopened it.
import { describe, expect, it } from 'vitest'
import { linkTextOf } from './frame'
import { classifyLink, displayHost, joinLinkText, type LinkText } from './link-host'
import { sanitize } from './sanitize'

/** The two halves of the contract, named: a warning must fire, or a warning must NOT fire. */
const mismatch = (href: string, text: string) => classifyLink(href, text)
const kindOf = (href: string, text: string) => classifyLink(href, text).kind

/** What the app passes as the base: the document a click is resolved against. */
const APP = 'https://app.waxwing.test/read/e1'

/**
 * One anchor of hostile markup, put through the app's real pipeline: `sanitize`, then the same
 * {@link linkTextOf} walk `mountMailFrame` runs on a click. NOTHING here is hand-written text.
 */
function anchorLinkText(rawHtml: string): LinkText {
  const { html } = sanitize(rawHtml, { allowRemote: false })
  const host = document.createElement('div')
  host.innerHTML = html
  const link = host.querySelector('a')
  if (link === null) throw new Error('the sanitizer dropped the anchor')
  const parts = linkTextOf(link)
  // Anchor the walk to a string the DOM really produces, so these tests measure it against the
  // browser rather than against itself. The tie is exact only when the anchor holds no `alt`: RAW is
  // `textContent` PLUS the alts of descendant <img>/<area>, which `textContent` omits and a reader
  // reads (wave 3, see `linkTextOf`). Where there is an alt, textContent is still a substring-by-
  // parts of RAW, and `frame.test.ts` pins the alt emission itself.
  if (link.querySelector('img[alt], area[alt], input, textarea, option, optgroup') === null) {
    expect(parts.raw).toBe((link.textContent ?? '').trim())
  } else {
    expect(parts.raw).toContain((link.textContent ?? '').trim())
  }
  return parts
}

/** The verdict the app reaches for a real anchor: sanitize → frame extraction → classify. */
function verdictFor(href: string, rawHtml: string) {
  return classifyLink(href, anchorLinkText(rawHtml), APP)
}

describe('displayHost', () => {
  it('returns the ASCII host of an http(s) URL', () => {
    expect(displayHost('https://bank.test/login?a=1#x')).toBe('bank.test')
    expect(displayHost('http://sub.bank.test:8080/')).toBe('sub.bank.test')
  })

  it('punycodes a Unicode host rather than handing back the pretty lie', () => {
    // The renderer must never show `аpple.com` when the browser will resolve xn--pple-43d.com.
    expect(displayHost('https://аpple.com/')).toBe('xn--pple-43d.com')
  })

  it('returns null for anything that is not a web link', () => {
    expect(displayHost('mailto:security@bank.test')).toBeNull()
    expect(displayHost('tel:+4952461234')).toBeNull()
    expect(displayHost('/relative/path')).toBeNull()
    expect(displayHost('#anchor')).toBeNull()
    expect(displayHost('not a url at all')).toBeNull()
    expect(displayHost('')).toBeNull()
  })

  it('resolves against a base when one is given', () => {
    expect(displayHost('//evil.tld/steal', APP)).toBe('evil.tld')
    expect(displayHost('/konto/login', APP)).toBe('app.waxwing.test')
    expect(displayHost('https://bank.test/x', APP)).toBe('bank.test')
  })

  it('refuses a non-web scheme whether or not a base is given', () => {
    expect(displayHost('mailto:security@bank.test', APP)).toBeNull()
    expect(displayHost('tel:+4952461234', APP)).toBeNull()
  })

  it('drops the trailing dot of the root-anchored FQDN form (D7)', () => {
    // `https://bank.test./login` and `https://bank.test/login` are the same destination — unlike the
    // punycode case, the shorter spelling tells the reader nothing untrue.
    expect(displayHost('https://bank.test./login')).toBe('bank.test')
  })
})

// ---- D1: the href is resolved against a base, because the browser resolves it too ----

describe('classifyLink — protocol-relative and scheme-relative hrefs (D1)', () => {
  it.each([
    ['protocol-relative', '//evil.tld/steal'],
    ['backslash-relative, which the URL parser folds to //', '\\\\evil.tld/steal'],
    ['leading whitespace, which the URL parser strips', '  //evil.tld/steal'],
  ])('catches %s — the browser lands on evil.tld either way', (_label, href) => {
    expect(classifyLink(href, 'bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('agrees with the spelt-out form, which is the whole point', () => {
    // The identical destination written in full has always warned. `//evil.tld/steal` reaching the
    // reader in silence was the bug: without a base it does not parse, and "does not parse" is the
    // verdict that means "open it normally".
    expect(classifyLink('https://evil.tld/steal', 'bank.test', APP)).toEqual(
      classifyLink('//evil.tld/steal', 'bank.test', APP),
    )
  })

  it('does not invent evil.tld for a SINGLE backslash, which is only a path separator', () => {
    // `\\evil.tld` folds to `//evil.tld` and leaves the origin; `\evil.tld` does not — it is a path
    // on the app's own host. Whichever it is, the base is what decides, and the dialog names the
    // host the click actually reaches rather than the one the string looks like.
    expect(classifyLink('\\evil.tld/steal', 'bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'app.waxwing.test',
    })
  })

  it('names the host the browser will really open for a single-slash `https:/` href', () => {
    // `https:/evil.tld/x` shares the base's scheme, so the parser treats it as a relative path: the
    // click lands on the APP, not on evil.tld.
    expect(classifyLink('https:/evil.tld/x', 'bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'app.waxwing.test',
    })
    // Without a base the same href resolves standalone and the dialog names evil.tld — a true-looking
    // sentence about a host the reader will never visit. Pinned to document why the base is required.
    expect(displayHost('https:/evil.tld/x')).toBe('evil.tld')
  })

  it('is unparsable only for a non-web SCHEME once a base is given', () => {
    expect(classifyLink('mailto:security@bank.test', 'bank.test', APP).kind).toBe('unparsable')
    expect(classifyLink('tel:+4952461234', 'bank.test', APP).kind).toBe('unparsable')
    // A relative href IS a web link — to the app itself. A mail link labelled `bank.test` that opens
    // the webmail app has broken its claim like any other, and saying so is honest.
    expect(classifyLink('/konto/login', 'bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'app.waxwing.test',
    })
  })

  it('leaves an honoured claim alone through the base', () => {
    expect(classifyLink('//bank.test/login', 'bank.test', APP).kind).toBe('ok')
  })
})

// ---- D2: what the reader sees is not what the string says ----

describe('classifyLink — invisible and compatibility characters in the text (D2)', () => {
  it.each([
    ['U+200B ZERO WIDTH SPACE', 'bank​.test'],
    ['U+00AD SOFT HYPHEN', 'bank­.test'],
    ['U+2060 WORD JOINER', 'bank⁠.test'],
    ['U+200C ZERO WIDTH NON-JOINER', 'bank‌.test'],
    ['U+200D ZERO WIDTH JOINER', 'bank‍.test'],
    ['full-width letters, folded by NFKC', 'ｂａｎｋ.test'],
    ['a wholly full-width host, dot included', 'ｂａｎｋ．ｔｅｓｔ'],
  ])('reads the host the reader actually sees: %s', (_label, text) => {
    expect(mismatch('https://evil.tld/steal', text)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('normalises toward the truth, not merely toward a warning', () => {
    // The same folding has to clear an honest link, or it is just a warning generator.
    expect(kindOf('https://bank.test/login', 'bank​.test')).toBe('ok')
    expect(kindOf('https://bank.test/login', 'ｂａｎｋ.test')).toBe('ok')
  })

  it('pins the reason trim() never caught these', () => {
    // `trim` cuts `\s`, and a zero-width character is not whitespace. This is the entire mechanism of
    // the bug — if this assertion ever flips, the normalisation above can be reconsidered.
    expect('bank​.test'.trim()).toBe('bank​.test')
    expect(/\s/.test('​')).toBe(false)
  })
})

// ---- D3 + D4: fused punctuation, and the one-character opt-out ----

describe('classifyLink — punctuation fused onto the claim (D3)', () => {
  // A tokeniser block: these are hand-written strings, so they prove what the TOKENISER does with a
  // given text and nothing about what markup produces that text. The markup-level attacks are D9.
  it('reads a host that a fused punctuation prefix made "prose"', () => {
    // `<a href="https://evil.tld/"><span hidden>!</span>bank.test</a>` reaches the app as the text
    // `!bank.test`; the reader sees exactly `bank.test`. An anchored gate read that as prose and
    // opened it in silence, which is why the claim is tokenised out of the whole text.
    expect(mismatch('https://evil.tld/', '!bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('reads it with the punctuation on the other side too', () => {
    expect(kindOf('https://evil.tld/', 'bank.test!')).toBe('mismatch')
    expect(kindOf('https://evil.tld/', '​bank.test​')).toBe('mismatch')
  })
})

describe('classifyLink — the one-character opt-out (D4)', () => {
  it.each([
    ['a trailing full stop', 'bank.test.'],
    ['a trailing bang', 'bank.test!'],
    ['a trailing comma', 'bank.test,'],
    ['surrounding brackets', '(bank.test)'],
    ['a leading word', 'Login at bank.test'],
    ['prose on both sides', 'Visit bank.test today'],
    ['a full sentence', 'Please confirm your account at bank.test to continue.'],
    ['German prose', 'Jetzt bei bank.test anmelden'],
  ])('still reads the claim: %s', (_label, text) => {
    expect(mismatch('https://paypa1-secure.ru/login', text)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'paypa1-secure.ru',
    })
  })

  it('is ok when a word in the prose names the host the link really opens', () => {
    // The reversal is about naming a host that is NOT the target — not about disliking prose.
    expect(kindOf('https://bank.test/login', 'Login at bank.test')).toBe('ok')
    expect(kindOf('https://help.bank.test/', 'Visit bank.test today')).toBe('ok')
    expect(kindOf('https://bank.test/', 'Bitte bei bank.test. anmelden')).toBe('ok')
  })

  it('is ok when EVERY named host covers the target', () => {
    // The shape the old "any claim clears" rule was written to protect — "bank.test's help centre
    // lives at help.bank.test", linked to the help centre. It survives the inversion untouched,
    // because the subdomain rule already makes `bank.test` cover `help.bank.test`.
    expect(kindOf('https://help.bank.test/x', 'bank.test and help.bank.test')).toBe('ok')
  })

  it('is NOT ok when one named host is left unhonoured, however many others are (D8)', () => {
    // This assertion was `ok` until the G2 review, and that was the hole: "any claim clears" hands
    // the attacker an off switch, because they can ADD a claim the reader never sees. `other.test`
    // is named in the text and is not where the click goes, so it is what the dialog reports.
    expect(mismatch('https://help.bank.test/x', 'other.test or help.bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'other.test',
      targetHost: 'help.bank.test',
    })
  })

  it('reports the first FAILING claim, not the first claim', () => {
    expect(mismatch('https://evil.ru/x', 'bank.test and paypal.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
    })
    // Here `claims[0]` IS honoured, so naming it would produce a dialog that contradicts itself
    // ("claimed: bank.test / actually: bank.test"). The failing claim is the second one.
    expect(mismatch('https://bank.test/', 'bank.test and status.bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'status.bank.test',
      targetHost: 'bank.test',
    })
  })
})

// ---- D5: filename-shaped text ----

describe('classifyLink — filename-shaped text (D5)', () => {
  it('treats a filename WITH a scheme as a claim — the author said "destination"', () => {
    expect(mismatch('https://paypa1-secure.ru/steal', 'https://invoice.pdf')).toEqual({
      kind: 'mismatch',
      claimedHost: 'invoice.pdf',
      targetHost: 'paypa1-secure.ru',
    })
  })

  it('keeps .zip and .mov OUT of the denylist — both are registrable TLDs', () => {
    expect(kindOf('https://evil.ru/x', 'update.zip')).toBe('mismatch')
    expect(kindOf('https://evil.ru/x', 'trailer.mov')).toBe('mismatch')
  })

  it('does not warn on the real shape: a filename over the CDN that serves it', () => {
    expect(kindOf('https://cdn.example.test/invoice.pdf', 'invoice.pdf')).toBe('ok')
    expect(kindOf('https://cdn.example.test/x', 'Download invoice.pdf now')).toBe('ok')
  })
})

describe('classifyLink — a claim that is honoured', () => {
  it('accepts an exact host match', () => {
    expect(kindOf('https://bank.test/login', 'https://bank.test/login')).toBe('ok')
    expect(kindOf('https://bank.test/login', 'bank.test')).toBe('ok')
  })

  it('accepts a subdomain of the claimed host — mail.google.com under google.com is not phishing', () => {
    expect(kindOf('https://mail.google.com/', 'google.com')).toBe('ok')
    expect(kindOf('https://a.b.c.google.com/', 'https://google.com/')).toBe('ok')
  })

  it('accepts a differing scheme, port or path — only the host is the claim', () => {
    expect(kindOf('http://bank.test:8443/x', 'https://bank.test/completely/other')).toBe('ok')
  })

  it('strips a leading www. from the claim, in both the URL and the bare form', () => {
    expect(kindOf('https://paypal.test/', 'www.paypal.test')).toBe('ok')
    expect(kindOf('https://paypal.test/', 'https://www.paypal.test/')).toBe('ok')
    // ...and the reverse: a bare claim over a www-prefixed target is the subdomain rule.
    expect(kindOf('https://www.paypal.test/', 'paypal.test')).toBe('ok')
  })

  it('ignores case in the claim', () => {
    expect(kindOf('https://bank.test/', 'BANK.TEST')).toBe('ok')
    expect(kindOf('https://bank.test/', 'HTTPS://Bank.Test/Login')).toBe('ok')
  })

  it('accepts the root-anchored FQDN form on either side (D7)', () => {
    // A trailing dot is the same host to every resolver; a mismatch here would be against itself.
    expect(kindOf('https://bank.test./login', 'bank.test')).toBe('ok')
    expect(kindOf('https://bank.test/login', 'https://bank.test./login')).toBe('ok')
    expect(kindOf('https://bank.test./login', 'https://bank.test./login')).toBe('ok')
    // The dot does not launder a lie, either.
    expect(mismatch('https://evil.ru./x', 'bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
    })
  })
})

describe('classifyLink — text that claims no host at all', () => {
  // This block IS the false-positive budget. Every entry here is a warning we must never raise,
  // because a reader who is trained to dismiss the dialog no longer reads it.
  it.each([
    ['empty text (an image-only link)', ''],
    ['whitespace only', '   \n\t '],
    ['English prose', 'Click here'],
    ['German prose', 'Rechnung ansehen'],
    ['an email address', 'security@bank.test'],
    ['an email address in prose', 'Write to security@bank.test for help'],
    ['a mailto: text', 'mailto:security@bank.test'],
    ['a bare word with no dot', 'unsubscribe'],
    ['a host-shaped word with no TLD', 'www.bank'],
    ['a single-letter last label', 'bank.t'],
    ['a numeric last label — a version, not a TLD', 'release 2.1'],
    ['a trailing-dot abbreviation', 'z.b.'],
    ['a price', '19.99'],
    ['a price in prose', 'Nur 19.99 EUR'],
    // D5: the commonest false positive in real mail. Absent from this corpus is why it shipped.
    ['a PDF filename', 'invoice.pdf'],
    ['a German document filename', 'Rechnung.docx'],
    ['an image filename', 'photo.jpg'],
    ['a spreadsheet filename', 'report.xlsx'],
    ['a filename in prose', 'Ihre Rechnung.pdf ansehen'],
  ])('is ok: %s', (_label, text) => {
    expect(kindOf('https://paypa1-secure.ru/steal', text)).toBe('ok')
  })
})

describe('classifyLink — a claim that is broken', () => {
  it('catches the plain lie', () => {
    expect(mismatch('https://paypa1-secure.ru/login', 'bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'paypa1-secure.ru',
    })
  })

  it('catches a full URL text over a different target', () => {
    expect(mismatch('https://paypa1-secure.ru/login', 'https://bank.test/login')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'paypa1-secure.ru',
    })
  })

  it('catches the Cyrillic homograph, and reports both hosts in their ASCII form', () => {
    // `аpple.com` here starts with Cyrillic а (U+0430). Punycoding is what makes the two hosts
    // comparable at all — and what makes the dialog's text true rather than a prettier forgery.
    expect(mismatch('https://apple.com/', 'https://аpple.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'xn--pple-43d.com',
      targetHost: 'apple.com',
    })
    // The same trick the other way round: the LINK is the homograph, the text is the real brand.
    expect(mismatch('https://раypal.com/signin', 'paypal.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'paypal.com',
      targetHost: 'xn--ypal-43d9g.com',
    })
  })

  it('catches a BARE homograph — with no scheme to give it away', () => {
    // An ASCII-only host gate makes this the whole defence's blind spot: the attacker simply omits
    // `https://`, `аpple.com` is not "host-shaped", it claims nothing, and evil.tld opens in silence.
    // In other words the homograph check would only have worked against attackers who cooperate.
    expect(mismatch('https://evil.tld/x', 'аpple.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'xn--pple-43d.com',
      targetHost: 'evil.tld',
    })
    // …and the bare homograph over the REAL host is honest, so it stays silent.
    expect(kindOf('https://xn--pple-43d.com/x', 'аpple.com')).toBe('ok')
  })

  it('does not eat the leading letter off a non-ASCII host when trimming punctuation', () => {
    // The word trim is `\p{L}\p{N}`-aware for exactly this: an ASCII-only trim would strip the
    // Cyrillic а and claim `pple.com`, a host nobody wrote.
    expect(mismatch('https://apple.com/', '(https://аpple.com)')).toEqual({
      kind: 'mismatch',
      claimedHost: 'xn--pple-43d.com',
      targetHost: 'apple.com',
    })
  })

  it('catches the claimed host used as a LABEL of the attacker domain', () => {
    // bank.com.evil.com ends with "bank.com" as a substring but is not under it — the reason the
    // comparison is `endsWith('.' + claimed)` and never `includes(claimed)`.
    expect(mismatch('https://bank.com.evil.com/login', 'bank.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.com',
      targetHost: 'bank.com.evil.com',
    })
    expect(kindOf('https://evilbank.com/', 'bank.com')).toBe('mismatch')
  })

  it('catches a claim the target is a PARENT of — the subdomain rule runs one way only', () => {
    // Text "mail.google.com", link to google.com: the claim is more specific than the target, so
    // the target does not honour it.
    expect(mismatch('https://google.com/', 'mail.google.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'mail.google.com',
      targetHost: 'google.com',
    })
  })

  it('catches a bare-host claim carrying a path', () => {
    expect(mismatch('https://evil.ru/x', 'bank.test/konto/login')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
    })
  })

  it('catches the click-tracker shape — the accepted cost of the reversal', () => {
    // Documented trade, not an oversight: a newsletter whose text names a domain but routes through
    // a tracker now warns. The redirect IS through a third party the text does not name.
    expect(mismatch('https://links.mailer.test/c/abc', 'shop.example.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'shop.example.com',
      targetHost: 'links.mailer.test',
    })
  })
})

describe('classifyLink — not a web link', () => {
  it.each([
    ['mailto:', 'mailto:security@bank.test'],
    ['tel:', 'tel:+4952461234'],
    ['a relative path', '/konto/login'],
    ['a bare fragment', '#section'],
    ['an empty href', ''],
    ['garbage', 'h ttp:/ /nope'],
  ])('is unparsable with no base, and therefore opens normally: %s', (_label, href) => {
    // The text claims a host in every one of these; with no base to resolve against, the HREF is not
    // a web link, so there is nothing to compare. In the app a base is always passed — see the D1
    // block for what these become there.
    expect(kindOf(href, 'bank.test')).toBe('unparsable')
  })
})

describe('classifyLink — hostile input', () => {
  it('scans a 2 MB link text without hanging', () => {
    const flood = `bank.test/${'a'.repeat(2_000_000)}`
    const started = performance.now()
    const verdict = classifyLink('https://evil.ru/x', flood)
    const elapsed = performance.now() - started
    expect(verdict).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.ru' })
    expect(elapsed).toBeLessThan(1000)
  })

  it('does not hang on 2 MB of prose', () => {
    const noise = 'lorem ipsum dolor sit amet '.repeat(80_000)
    expect(noise.length).toBeGreaterThan(2_000_000)
    const started = performance.now()
    expect(classifyLink('https://evil.ru/x', noise).kind).toBe('ok')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not hang on a 2 MB single word with no whitespace to split on', () => {
    // The worst case for the scan: one word, so per-word normalisation gets the whole string. Still
    // a single linear pass, and it happens once per CLICK — never per render.
    const noise = `${'ab.'.repeat(700_000)}!`
    const started = performance.now()
    expect(classifyLink('https://evil.ru/x', noise).kind).toBe('mismatch')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('CANNOT be silenced by padding the text past any bound (the reason there is no clamp)', () => {
    // The attack a head clamp hands over for free, and the reason MAX_LINK_TEXT is gone:
    //   <a href="https://evil.ru/"><span style="display:none">AAAA…</span>bank.test</a>
    // The reader sees `bank.test`; `textContent` carries the padding first. Under a 2048-char head
    // clamp all three of these returned `ok` — proved against this module — and no clamp shape helps:
    // guard the head and the padding goes in front, guard head AND tail and it goes in the middle.
    const pad = 'A'.repeat(2100)
    for (const text of [
      `${pad} bank.test`, // padding before
      `${pad}bank.test`, // padding fused into the word
      `x ${pad} bank.test`, // padding in the middle
      `${'lorem '.repeat(400)}bank.test`, // sheer length
    ]) {
      expect(classifyLink('https://evil.ru/x', text).kind).toBe('mismatch')
    }
  })

  it('does not let userinfo in the TEXT invent a claim the reader never saw', () => {
    // `https://bank.test@evil.ru/` is a URL to evil.ru. The text and the target agree, so there is
    // nothing to warn about here — deceptive URL text is the browser's own problem, not a host
    // mismatch, and inventing a warning would be a false positive.
    expect(kindOf('https://evil.ru/', 'https://bank.test@evil.ru/')).toBe('ok')
  })

  it('reads the authority, not the path, out of a bare claim', () => {
    expect(mismatch('https://evil.ru/x', 'bank.test/@paypal.com')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
    })
  })
})

// ---- D8: hidden markup ADDING an already-honoured claim — the gate's own off switch (G2) ----

/**
 * A SAMPLE of ways to hide a run of text inside an anchor, with the marker that says whether the
 * markup is still in the sanitizer's output. It is a sample and not an enumeration — this table has
 * grown at every review, which is itself the argument against ever naming it "the N ways". Wave 1
 * listed four and wave 2 called them "the five ways"; a checker then broke the sanitizer half of it
 * with eight more spellings of the FIRST row alone.
 *
 * `kept: false` rows are dropped by the sanitizer's property allowlist inside an `<a>`, and only
 * there (ADR-016); preheaders live at body level and are untouched. `kept: true` rows are on the
 * allowlist ON PURPOSE — white-on-coloured button text inside a link is ordinary mail — and are here
 * precisely so the classifier's independence from visibility is asserted rather than assumed.
 *
 * Every attack below is asserted for EVERY row, because the classifier's answer must not depend on
 * which one was used: the union of the two renderings is a fact about text, not about visibility. If
 * some row ever behaves differently, that is the thing worth knowing.
 */
const HIDING: ReadonlyArray<readonly [string, string, RegExp, boolean]> = [
  ['display:none', 'style="display:none"', /display:\s*none/i, false],
  ['visibility:hidden', 'style="visibility:hidden"', /visibility:\s*hidden/i, false],
  ['font-size:0', 'style="font-size:0"', /font-size:\s*0/i, false],
  ['the hidden attribute', 'hidden', /hidden(=|\s|>)/i, false],
  // Wave-3 rows. The first is the spelling real HTML mail overwhelmingly uses and the wave-2 denylist
  // kept it verbatim; the rest are the geometric family it never enumerated at all.
  ['display:none!important', 'style="display:none!important"', /display/i, false],
  ['display : none ! important', 'style="display : none ! important"', /display/i, false],
  ['a font-size that is not exactly zero', 'style="font-size:0.0001px"', /font-size/i, false],
  ['opacity:0', 'style="opacity:0"', /opacity/i, false],
  ['position:absolute;left:-9999px', 'style="position:absolute;left:-9999px"', /position/i, false],
  ['clip-path:inset(100%)', 'style="clip-path:inset(100%)"', /clip-path/i, false],
  ['transform:scale(0)', 'style="transform:scale(0)"', /transform/i, false],
  ['text-indent:-9999px', 'style="text-indent:-9999px"', /text-indent/i, false],
  ['max-height:0;overflow:hidden', 'style="max-height:0;overflow:hidden"', /overflow/i, false],
  ['filter:opacity(0)', 'style="filter:opacity(0)"', /filter/i, false],
  ['color:#fff', 'style="color:#fff"', /color:\s*#fff/i, true],
  ['a large positive padding', 'style="padding-left:9999px"', /padding-left/i, true],
]

describe('what sanitize does with hiding markup inside an anchor (D8, ADR-016)', () => {
  it.each(HIDING)('inside an <a>, %s is %s', (_label, attr, marker, kept) => {
    const { html } = sanitize(
      `<a href="https://evil.tld/steal"><span ${attr}>evil.tld/</span>bank.test</a>`,
      { allowRemote: false },
    )
    // The narrow reversal: structural hiding goes, chromatic hiding stays. Pinned in BOTH
    // directions so that neither half can drift — widening this to `color` would repaint real mail
    // into illegibility, and narrowing it would put the junk back out of sight.
    if (kept) expect(html).toMatch(marker)
    else expect(html).not.toMatch(marker)
    // Either way the text is all still THERE, which is the point: the sanitizer changes what the
    // reader can see, never what the classifier gets to read.
    expect(html).toContain('evil.tld/')
    expect(html).toContain('bank.test')
  })

  it.each(
    HIDING,
  )('outside an anchor, %s is left alone — preheaders are body-level', (_l, attr, marker) => {
    // The reason `sanitize` kept structural hiding in the first place, and the reason the new rule is
    // scoped to anchors instead of applied globally. This is the regression test for real mail.
    const { html } = sanitize(`<div ${attr}>Ihre Rechnung für Juli</div><p>hi</p>`, {
      allowRemote: false,
    })
    expect(html).toMatch(marker)
  })

  it('does not unhide the anchor ITSELF — an <a> hiding itself deceives nobody', () => {
    // Scoped to DESCENDANTS. A wholly hidden link cannot be clicked, so there is no promise to break,
    // and force-showing it would be a rendering change with no security value.
    const { html } = sanitize('<a href="https://x.test/" style="display:none">gone</a>')
    expect(html).toMatch(/display:\s*none/i)
  })

  it('strips the hiding but keeps the rest of the declaration list', () => {
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="color:#fff;display:none;font-weight:bold">j</span>x</a>',
    )
    expect(html).not.toMatch(/display:\s*none/i)
    expect(html).toMatch(/color:\s*#fff/i)
    expect(html).toMatch(/font-weight:\s*bold/i)
  })

  it('drops the style attribute entirely when hiding was all it said', () => {
    const { html } = sanitize('<a href="https://x.test/"><span style="display:none">j</span>x</a>')
    expect(html).toContain('<span>j</span>')
  })

  it.each([
    ['a CSS-escaped property name', 'style="display\\3a none"'],
    ['a zero font-size with a unit', 'style="font-size:0px"'],
    ['a zero font-size written as a decimal', 'style="font-size:0.0em"'],
    ['a leading-dot zero font-size', 'style="font-size:.0%"'],
    ['padded whitespace', 'style="  display : none  "'],
  ])('is not walked past by %s', (_label, attr) => {
    const { html } = sanitize(`<a href="https://x.test/"><span ${attr}>junk</span>visible</a>`)
    expect(html).not.toMatch(/display\s*:|display\\3a|font-size/i)
  })

  it('does NOT strip a font-size that is merely small', () => {
    // `0` is hiding; `0.5em` is a design choice. Over-reading the value would eat legitimate styling.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-size:0.5em">x</span></a>',
    )
    expect(html).toMatch(/font-size:\s*0\.5em/i)
  })
})

describe('classifyLink — a WHITESPACE-SEPARATED hidden word cannot switch the gate off (D8)', () => {
  // Everything in this block feeds `classifyLink` a hand-written string in which the hidden run is
  // already separated from the visible host by a space. That is a real shape — an attacker who writes
  // `<span hidden>evil.tld </span>` produces it — but it is ONLY that shape, and every name here says
  // so. The no-whitespace families, which these fixtures cannot reach, are D9.
  it.each(
    HIDING,
  )('warns even though a %s span already names the target, end to end through sanitize', (_label, attr) => {
    const text = anchorLinkText(
      `<a href="https://evil.tld/steal"><span ${attr}>evil.tld </span>bank.test</a>`,
    )
    // Under "any honoured claim clears the link" this returned `ok` and opened with NO dialog:
    // the hidden `evil.tld` covers the target, so the check answered the attacker's own question.
    expect(classifyLink('https://evil.tld/steal', text, APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it.each([
    ['the hidden host before the visible one', 'evil.tld bank.test'],
    ['the hidden host after the visible one', 'bank.test evil.tld'],
    ['the hidden host as a full URL', 'https://evil.tld/steal bank.test'],
    ['the hidden host wrapped in punctuation', '(evil.tld) bank.test'],
    ['several hidden hosts, all of them honoured', 'evil.tld https://evil.tld/x bank.test'],
  ])('the placement WITHIN a whitespace-separated text does not matter: %s', (_label, text) => {
    expect(classifyLink('https://evil.tld/steal', text, APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('still warns when a hidden claim is itself unhonoured, and names that one', () => {
    // `a.evil.tld` is MORE specific than the target, so the subdomain rule does not honour it and it
    // is the first failing claim. The dialog then names a host the reader never saw — worth pinning
    // rather than pretending otherwise. It is still the safe direction: the gate is shut, and the
    // shape only arises when the attacker hides a host that does not even match their own target.
    expect(classifyLink('https://evil.tld/steal', 'a.evil.tld bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'a.evil.tld',
      targetHost: 'evil.tld',
    })
  })

  it('is not escaped by pointing at a SUBDOMAIN of the hidden claim', () => {
    // `covers` accepts `login.evil.tld` under a claim of `evil.tld`, so the old rule cleared this
    // too. The visible `bank.test` is still unhonoured, and that is the claim the reader read.
    expect(classifyLink('https://login.evil.tld/steal', 'evil.tld bank.test', APP)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'login.evil.tld',
    })
  })

  it('names the host the READER saw, never the attacker’s hidden one', () => {
    // Reporting `claims[0]` would print "claimed: evil.tld / actually: evil.tld" — a dialog that
    // agrees with itself and tells the reader nothing. The FAILING claim is the informative one.
    const verdict = classifyLink('https://evil.tld/steal', 'evil.tld bank.test', APP)
    expect(verdict).not.toEqual({
      kind: 'mismatch',
      claimedHost: 'evil.tld',
      targetHost: 'evil.tld',
    })
    expect(verdict).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('adding a whitespace-separated claim can only make the verdict stricter, never looser', () => {
    // The monotonicity the inverted quantifier buys, stated no wider than the fixtures prove: given a
    // text that ALREADY carries the visible claim as its own word, prepending more words cannot turn
    // the mismatch back into silence. It says nothing about whether the visible claim survives
    // tokenising in the first place — see D9, which is where wave 1 of this fix actually lost.
    for (const prefix of ['', 'evil.tld ', 'https://evil.tld/ ', 'a.b.evil.tld evil.tld ']) {
      expect(classifyLink('https://evil.tld/steal', `${prefix}bank.test`, APP).kind).toBe(
        'mismatch',
      )
    }
  })
})

// ---- D9: hidden markup ABUTTING the visible host — no whitespace anywhere (wave-2) ----

/**
 * The precondition every wave-1 fixture shared without saying so: a space between the hidden run and
 * the visible host. `textContent` concatenates text nodes with NO separator, so the attacker simply
 * omits it, and the whole D8 block above becomes a description of an attack nobody has to mount.
 *
 * Not one string in this block is hand-written. Each starts as markup, goes through the real
 * `sanitize`, and is read by the real `frame.ts` walk — which is the only way a test can be wrong
 * about `textContent` in the direction that matters.
 */
describe('classifyLink — hidden markup ABUTTING the visible host (D9)', () => {
  it('reproduces the two bypasses at the string level, so the mechanism is not in doubt', () => {
    // FORGE: BARE_HOST's optional path group swallows the visible host into the hidden one's path, so
    // the claim set is not `{evil.tld, bank.test}` but `{evil.tld}` — the visible claim is REPLACED.
    const forged = anchorLinkText(
      '<a href="https://evil.tld/steal"><span style="color:#fff">evil.tld/</span>bank.test</a>',
    )
    expect(forged.raw).toBe('evil.tld/bank.test')
    expect(classifyLink('https://evil.tld/steal', forged.raw, APP).kind).toBe('ok')

    // DESTROY: the glued junk leaves a last label that is not ≥2 LETTERS, so no claim is produced at
    // all and the empty-claims rule returns `ok`.
    const destroyed = anchorLinkText(
      '<a href="https://evil.tld/steal">bank.test<span style="color:#fff">x9</span></a>',
    )
    expect(destroyed.raw).toBe('bank.testx9')
    expect(classifyLink('https://evil.tld/steal', destroyed.raw, APP).kind).toBe('ok')

    // Both are `mismatch` once the SEPARATED rendering joins the claim set. This pair of assertions
    // is the whole fix, and deleting the union makes exactly these two go red.
    expect(classifyLink('https://evil.tld/steal', forged, APP).kind).toBe('mismatch')
    expect(classifyLink('https://evil.tld/steal', destroyed, APP).kind).toBe('mismatch')
  })

  it.each(HIDING)('FORGE — a %s prefix ending in "/" swallows the visible host', (_label, attr) => {
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="https://evil.tld/steal"><span ${attr}>evil.tld/</span>bank.test</a>`,
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it.each(HIDING)('DESTROY — %s junk glued AFTER the visible host de-shapes it', (_label, attr) => {
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="https://evil.tld/steal">bank.test<span ${attr}>x9</span></a>`,
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it.each(HIDING)('DESTROY — %s junk glued BEFORE the visible host', (_label, attr) => {
    // Raw fuses this into the word `x9bank.test`, a host nobody wrote and which happens to fail too.
    // The reported claim is `bank.test` regardless, because the SEPARATED rendering is read first —
    // the dialog names a host the reader actually saw. See `joinLinkText`.
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="https://evil.tld/steal"><span ${attr}>x9</span>bank.test</a>`,
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it.each(HIDING)('BOTH AT ONCE — %s spliced in front AND glued behind', (_label, attr) => {
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="https://evil.tld/steal"><span ${attr}>evil.tld/</span>bank.test<span ${attr}>x9</span></a>`,
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it.each(HIDING)('a %s host-shaped SUFFIX cannot launder the claim either', (_label, attr) => {
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="https://evil.tld/steal">bank.test<span ${attr}>.evil.tld</span></a>`,
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('is not escaped by nesting the hidden run several elements deep', () => {
    // The walk is over the whole subtree, not the anchor's immediate children.
    expect(
      verdictFor(
        'https://evil.tld/steal',
        '<a href="https://evil.tld/steal"><b><i><span style="color:#fff">evil.tld/</span></i></b>bank.test</a>',
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('is not escaped by a <br>, which separates the two lines a reader sees', () => {
    // An empty element between two text nodes that share a parent: `textContent` fuses the lines, the
    // reader sees two. Only an element-boundary walk (not a parent-identity one) catches this.
    expect(
      verdictFor(
        'https://evil.tld/steal',
        '<a href="https://evil.tld/steal">evil.tld/<br>bank.test</a>',
      ),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('leaves the legitimate shapes alone — this is still a false-positive budget', () => {
    // A host whose brand half is styled. RAW is the only rendering that names it, which is why the
    // union keeps RAW and does not simply switch to SEPARATED.
    expect(verdictFor('https://bank.test/login', '<a href="x"><b>bank</b>.test</a>').kind).toBe(
      'ok',
    )
    expect(
      verdictFor(
        'https://bank.test/login',
        '<a href="x">bank<span style="color:#c00">.test</span></a>',
      ).kind,
    ).toBe('ok')
    // …and the same shape over a different host must still warn, which is what RAW is FOR.
    expect(verdictFor('https://evil.tld/x', '<a href="x"><b>bank</b>.test</a>')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
    // Prose split across elements claims nothing in either rendering.
    expect(verdictFor('https://evil.tld/x', '<a href="x">Click <b>here</b></a>').kind).toBe('ok')
    expect(verdictFor('https://evil.tld/x', '<a href="x"><b>Rechnung</b> ansehen</a>').kind).toBe(
      'ok',
    )
    // A filename split across elements is still a filename, not a host.
    expect(
      verdictFor('https://cdn.example.test/x', '<a href="x">Download <b>invoice</b>.pdf</a>').kind,
    ).toBe('ok')
  })

  it('is monotone in the RENDERINGS: adding one never turns a mismatch into an ok', () => {
    // Stated as a property over the two renderings, which is the only form in which it is true. It is
    // NOT the claim that hidden markup can only add claims — D9's first test shows it can replace.
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        'https://evil.tld/steal',
        '<a href="x"><span style="color:#fff">evil.tld/</span>bank.test</a>',
      ],
      ['https://evil.tld/steal', '<a href="x">bank.test<span style="color:#fff">x9</span></a>'],
      ['https://evil.tld/x', '<a href="x"><b>bank</b>.test</a>'],
      ['https://bank.test/x', '<a href="x">bank.test and status.bank.test</a>'],
    ]
    for (const [href, html] of cases) {
      const parts = anchorLinkText(html)
      const union = classifyLink(href, parts, APP).kind
      const rawOnly = classifyLink(href, parts.raw, APP).kind
      const sepOnly = classifyLink(href, parts.separated, APP).kind
      // A single rendering may be `ok` where the union is `mismatch`; the reverse must never happen.
      if (rawOnly === 'mismatch' || sepOnly === 'mismatch') expect(union).toBe('mismatch')
    }
  })

  it('costs a new false positive when a split-off fragment is host-shaped on its own', () => {
    // The union's own price, pinned because the file header states it. SEPARATED reads
    // `/partner.test` as a word and trims it to a claim; RAW alone saw only `bank.test/partner.test`
    // and its path. Narrow, and the text really did put a second host in front of the reader — but
    // it is a warning that did not fire before, and it belongs in the corpus rather than in prose.
    expect(
      verdictFor('https://bank.test/x', '<a href="x">bank.test<span>/partner.test</span></a>'),
    ).toEqual({ kind: 'mismatch', claimedHost: 'partner.test', targetHost: 'bank.test' })
  })

  it('does not fix the PRE-EXISTING fusion false positive, and does not pretend to', () => {
    // `<br>` between two lines: RAW fuses `AG` and `bank.test` into `AGbank.test`, which fails. The
    // union adds the correct `bank.test` claim from SEPARATED and cannot delete the fused one —
    // monotonicity cuts both ways. This warned before the wave-2 change and warns after it; the
    // assertion exists so the header's admission is checked rather than merely written.
    expect(verdictFor('https://bank.test/x', '<a href="x">Bank AG<br>bank.test</a>')).toEqual({
      kind: 'mismatch',
      claimedHost: 'agbank.test',
      targetHost: 'bank.test',
    })
  })

  it('joins the renderings so the claim set is exactly the UNION, seam included', () => {
    // The join is the mechanism, so it is pinned directly: no word straddles the newline, and an
    // anchor with no element children is not doubled.
    expect(joinLinkText({ raw: 'bank.test', separated: 'bank.test' })).toBe('bank.test')
    expect(joinLinkText({ raw: 'a.test', separated: 'a .test' })).toBe('a .test\na.test')
    // The seam must be whitespace, not an empty string: joined without a separator these two halves
    // would fuse into the word `bank.test` and invent a claim that neither rendering names.
    expect(classifyLink('https://evil.tld/x', { raw: '.test', separated: 'bank' }, APP).kind).toBe(
      'ok',
    )
    expect(classifyLink('https://evil.tld/x', 'bank.test', APP).kind).toBe('mismatch')
  })
})

// ---- D9b: what is NOT closed, pinned so nobody mistakes silence for safety ----

describe('classifyLink — two colour-hidden split-host fixtures that return ok (D9, ADR-016)', () => {
  // Narrowed in wave 3. The old name — "the chromatic-hiding residual" — read as an inventory of
  // what is open, over two special-case fixtures. It is not one: hiding inside an anchor is not a
  // closed class and neither is the list of residuals (see `link-host.ts`'s header). These two
  // fixtures show two concrete silent shapes, and that is all they show.
  it('does NOT catch a colour-hidden glue on a host that is also split across elements', () => {
    // Both renderings lose: RAW fuses `bank` + `.test` + `x9` into `bank.testx9` (not host-shaped),
    // SEPARATED splits them into `bank`, `.test`, `x9` (none host-shaped). The classifier is silent.
    //
    // This assertion is `ok` ON PURPOSE. Closing it needs the RENDERED text, which needs computed
    // style against a real background — impossible in a script-free frame — and a partial visibility
    // oracle is worse than none because it reads as a closure. If a future change makes this
    // `mismatch`, delete the test; do not "fix" it by widening the sanitizer to `color`.
    const html =
      '<a href="https://evil.tld/steal"><b>bank</b>.test<span style="color:#fff">x9</span></a>'
    expect(anchorLinkText(html).raw).toBe('bank.testx9')
    expect(verdictFor('https://evil.tld/steal', html).kind).toBe('ok')
  })

  it('does not catch the colour-hidden forge of a split host either', () => {
    const html =
      '<a href="https://evil.tld/steal"><span style="color:#fff">evil.tld/</span><b>bank</b>.test</a>'
    expect(verdictFor('https://evil.tld/steal', html).kind).toBe('ok')
  })

  it('loses its display:none when written that way, while the verdict stays ok either way', () => {
    // Narrowed in wave 3: the old name said the attack "is forced into view", which is a claim about
    // RENDERING that this assertion cannot make and that the rule does not deliver in general — the
    // attacker can rewrite the same attack with `color:#fff`, one row up, and it renders hidden.
    // What is asserted here is exactly what runs: for THIS spelling the declaration is gone from the
    // sanitizer's output and the text survives, and the classifier's answer did not change, because
    // no verdict in this module depends on visibility.
    const html =
      '<a href="https://evil.tld/steal"><b>bank</b>.test<span style="display:none">x9</span></a>'
    const { html: cleaned } = sanitize(html, { allowRemote: false })
    expect(cleaned).not.toMatch(/display/i)
    expect(cleaned).toContain('x9')
    expect(verdictFor('https://evil.tld/steal', html).kind).toBe('ok')
  })

  it('is not narrowed at all when the same attack is written with a large positive padding', () => {
    // The honest companion to the row above, and the reason no name here may say "forced into view".
    // `padding-left:9999px` is on the allowlist (a per-declaration ceiling composes away under
    // nesting, so none is attempted), it displaces `x9` out of the frame's visible column just as
    // `display:none` did, and the verdict is the same `ok`.
    const html =
      '<a href="https://evil.tld/steal"><b>bank</b>.test' +
      '<span style="padding-left:9999px">x9</span></a>'
    expect(sanitize(html, { allowRemote: false }).html).toMatch(/padding-left:\s*9999px/i)
    expect(verdictFor('https://evil.tld/steal', html).kind).toBe('ok')
  })
})

describe('classifyLink — the new false-positive cost, stated as tests (D8)', () => {
  it('warns on a footer anchor that names a second host the click does not reach', () => {
    // Wrapping a run of prose in one <a> is the usual way in. The reader IS being sent somewhere the
    // text named alongside another host, so the dialog is telling the truth — it just costs budget.
    expect(
      mismatch('https://example.com/', 'Sent by example.com on behalf of partner.test'),
    ).toEqual({ kind: 'mismatch', claimedHost: 'partner.test', targetHost: 'example.com' })
  })

  it('warns when the text names a CHILD of the target as well as the target', () => {
    // The subdomain rule runs one way only, so a claim on `status.bank.test` is not honoured by a
    // click to `bank.test` — even though `bank.test` in the same text is.
    expect(kindOf('https://bank.test/', 'bank.test and status.bank.test')).toBe('mismatch')
  })

  it('does NOT warn on the shapes the budget actually protects', () => {
    // The ones that must stay silent, or the dialog trains the reflex phishing needs.
    expect(kindOf('https://help.bank.test/', 'bank.test — help centre at help.bank.test')).toBe(
      'ok',
    )
    expect(kindOf('https://cdn.example.test/x', 'Download invoice.pdf and photo.jpg')).toBe('ok')
    expect(kindOf('https://bank.test/', 'Write to security@bank.test or visit bank.test')).toBe(
      'ok',
    )
    expect(kindOf('https://www.paypal.test/', 'www.paypal.test / paypal.test')).toBe('ok')
  })
})

// ---- D10: an anchor labelled by an <img alt> (wave 3) ----

describe('an image-only link claims the host its alt names (D10)', () => {
  it('warns on the shortest phishing link in the file, end to end through sanitize', () => {
    // `sanitize` strips the remote `src` — the privacy default — which is precisely what GUARANTEES
    // the browser renders the `alt` string instead. The reader literally sees the words `bank.test`.
    // Before wave 3 both renderings were empty, the empty-claims rule returned `ok`, and the
    // deliberately non-disableable interstitial never appeared.
    const html =
      '<a href="https://evil.tld/steal">' +
      '<img src="https://cdn.evil.tld/l.png" alt="Sign in to bank.test"></a>'
    // The `src` really is gone, so the alt really is what renders — the premise, asserted.
    const cleaned = sanitize(html, { allowRemote: false }).html
    expect(cleaned).not.toContain('cdn.evil.tld')
    expect(cleaned).toContain('alt="Sign in to bank.test"')
    expect(verdictFor('https://evil.tld/steal', html)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('warns for a bare host in the alt, and for a full URL in it', () => {
    for (const alt of ['bank.test', 'https://bank.test/login', 'Jetzt bei bank.test anmelden']) {
      expect(verdictFor('https://evil.tld/steal', `<a href="x"><img alt="${alt}"></a>`)).toEqual({
        kind: 'mismatch',
        claimedHost: 'bank.test',
        targetHost: 'evil.tld',
      })
    }
  })

  it('is not silenced by splicing text against the alt, because the alt is its own word', () => {
    // The same family the separated rendering exists for, one element type further on. The fixtures
    // put the spliced text DIRECTLY beside the image with no element in between, on purpose: with a
    // `<span>` there, the span's own boundary would do the separating and this would pass whether or
    // not the alt is fenced. Unfenced, `evil.tld/` + `bank.test` fuse into one host-shaped word whose
    // path spells the visible host — the exact wave-2 forge — and the link opens in silence.
    expect(
      verdictFor('https://evil.tld/steal', '<a href="x">evil.tld/<img alt="bank.test"></a>'),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
    // And the DESTROY direction: junk glued after the alt must not de-shape it.
    expect(verdictFor('https://evil.tld/steal', '<a href="x"><img alt="bank.test">x9</a>')).toEqual(
      { kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' },
    )
    // A neighbouring element as well, so both routes to the boundary are covered.
    expect(
      verdictFor('https://evil.tld/steal', '<a href="x"><img alt="bank.test"><span>x9</span></a>'),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('stays silent when the alt names the host the link actually opens', () => {
    // The false-positive side. A logo image alt-texted with its own brand host is ordinary mail.
    expect(verdictFor('https://bank.test/login', '<a href="x"><img alt="bank.test"></a>')).toEqual({
      kind: 'ok',
    })
    expect(
      verdictFor('https://help.bank.test/', '<a href="x"><img alt="bank.test Hilfe"></a>'),
    ).toEqual({ kind: 'ok' })
  })

  it('stays silent for an alt that names no host, which is most alts', () => {
    for (const alt of ['', 'Logo', 'Jetzt kaufen', 'Rechnung.pdf', 'Bank AG']) {
      expect(verdictFor('https://evil.tld/steal', `<a href="x"><img alt="${alt}"></a>`).kind).toBe(
        'ok',
      )
    }
  })
})

// ---- D11: U+2800, a blank-rendering character that is neither \s nor invisible (wave 3) ----

const BRAILLE_BLANK = '\u2800'

describe('a blank-rendering non-space character cannot de-shape a host (D11)', () => {
  it('warns on the cited attack, and names the host the READER saw', () => {
    // `bank.test⠀Login` renders as `bank.test Login`. U+2800 is not `\s`, so the tokeniser saw one
    // word; that word is not host-shaped, so it claimed nothing and the link opened in silence — with
    // no CSS and no elements involved, which is why neither rendering nor the sanitizer touched it.
    // The split reading is taken first, so the dialog reports `bank.test` and not the fused artefact.
    expect(
      verdictFor('https://evil.tld/steal', `<a href="x">bank.test${BRAILLE_BLANK}Login</a>`),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('warns when the fusion would otherwise COVER the target — the split reading’s own case', () => {
    // Text `bank.test⠀x` over a link to `https://bank.testx/`. Read stripped, the claim is
    // `bank.testx`, which IS the target and is honoured, so the link would open in silence while the
    // reader was shown `bank.test`. The split reading claims `bank.test`, which does not cover
    // `bank.testx`. This row is why the word is read both ways instead of only stripped.
    expect(verdictFor('https://bank.testx/', `<a href="x">bank.test${BRAILLE_BLANK}x</a>`)).toEqual(
      { kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'bank.testx' },
    )
  })

  it('warns on the de-shaping direction — the stripped reading’s own case', () => {
    // Text `bank⠀.test`. Split, it is `bank` and `.test`: neither names a host, so nothing is claimed
    // and any target opens in silence. Stripped, it is `bank.test`. This row is why the word is read
    // both ways instead of only split.
    expect(
      verdictFor('https://evil.tld/steal', `<a href="x">bank${BRAILLE_BLANK}.test</a>`),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('costs a false positive on legitimate text that uses the blank as a spacer', () => {
    // The price of the stripped reading, asserted rather than described. `bank.test⠀Login` linked to
    // `bank.test` is a legitimate mail, and it warns: stripped, it claims `bank.testlogin`, which
    // does not cover `bank.test`. Narrow — it needs a braille blank AND a host name in one link's
    // text — and the safe direction, but it is a new warning and belongs in the corpus.
    expect(
      verdictFor('https://bank.test/', `<a href="x">bank.test${BRAILLE_BLANK}Login</a>`),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.testlogin', targetHost: 'bank.test' })
  })

  it('leaves a link whose whole text is one host alone, blank or no blank', () => {
    expect(verdictFor('https://bank.test/', '<a href="x">bank.test</a>').kind).toBe('ok')
    expect(
      verdictFor('https://bank.test/', `<a href="x">${BRAILLE_BLANK}bank.test${BRAILLE_BLANK}</a>`)
        .kind,
    ).toBe('ok')
  })

  /**
   * Characters that render as NOTHING and are default-ignorable but NOT `\p{Cf}`. That much IS an
   * enumerable set and the wave-3 strip now covers all of it; "renders blank" in general is a font
   * fact and is not closed by anything here.
   *
   * The placement below is load-bearing and was got wrong first: put one of
   * these BEFORE the dot (`bank<CGJ>.test`) and the word is host-shaped anyway, because
   * {@link BARE_HOST}'s prefix accepts any character, and IDNA then deletes it from the host — so
   * such a fixture warns with or without the strip and proves nothing about it. Put it INSIDE the
   * last label and the shape test itself fails: `\p{L}{2,}` does not match a combining mark, so no
   * claim is produced and the link opens in silence. That is the fixture worth having.
   */
  const IGNORABLE_NOT_CF: ReadonlyArray<readonly [string, string]> = [
    ['U+034F COMBINING GRAPHEME JOINER', '\u034F'],
    ['U+FE0F VARIATION SELECTOR-16', '\uFE0F'],
    ['U+17B4 KHMER VOWEL INHERENT AQ', '\u17B4'],
    ['U+180B MONGOLIAN FREE VARIATION SELECTOR ONE', '\u180B'],
  ]

  it.each(
    IGNORABLE_NOT_CF,
  )('%s inside the last label renders as nothing, is stripped, and the claim survives', (_label, ch) => {
    // These are invisible to a reader, so `bank.te<ch>st` IS `bank.test` on screen. Splitting on
    // them instead of stripping would de-shape a claim the reader can plainly read, which is why
    // the treatment is the opposite of U+2800's above.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">bank.te${ch}st</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it.each(
    IGNORABLE_NOT_CF,
  )('%s before the dot already failed closed through IDNA — the control, not the proof', (_label, ch) => {
    // Kept as a control so the row above cannot be mistaken for what this one shows. Here the word
    // is host-shaped with or without the strip and the URL parser deletes the character from the
    // host, so it warned before wave 3 too.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">bank${ch}.test</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it.each([
    ['U+200B ZERO WIDTH SPACE', '\u200B'],
    ['U+00AD SOFT HYPHEN', '\u00AD'],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', '\u180E'],
  ])('%s is \\p{Cf} and was already stripped before wave 3', (_label, ch) => {
    expect(verdictFor('https://evil.tld/steal', `<a href="x">bank.te${ch}st</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it.each([
    ['U+3164 HANGUL FILLER', '\u3164'],
    ['U+FFA0 HALFWIDTH HANGUL FILLER', '\uFFA0'],
    ['U+1160 HANGUL JUNGSEONG FILLER', '\u1160'],
  ])('%s is a LETTER to the shape test, and IDNA deletes it from the host', (_label, ch) => {
    // A third mechanism again, pinned because it is the reason these three were never a hole: they
    // are `\p{L}`, so the last label matches, and the URL parser drops them during IDNA. The strip
    // now removes them one step earlier; the verdict is the same either way.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">bank.te${ch}st</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })
})

// ---- D13: an explicit bidi OVERRIDE reverses what the reader sees (wave 4, A4c) ----

const RLO = '\u202E' // RIGHT-TO-LEFT OVERRIDE
const LRO = '\u202D' // LEFT-TO-RIGHT OVERRIDE

describe('an explicit bidi override means we cannot know what the reader saw (D13)', () => {
  it('warns on the cited attack, and names the host the READER saw', () => {
    // `<a href="https://evil.tld/steal">&#x202E;nigol/tset.knab</a>` renders as `bank.test/login`.
    // U+202E draws nothing itself, so the invisible-character strip removed it and the classifier
    // read `nigol/tset.knab` — host-shaped in no way at all, so no claim, and the link opened in
    // silence. No CSS and no elements: the assumption the whole property allowlist rests on.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">${RLO}nigol/tset.knab</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('warns for U+202D LRO as well, which reverses right-to-left text the same way', () => {
    expect(verdictFor('https://evil.tld/steal', `<a href="x">${LRO}nigol/tset.knab</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('warns even when neither reading names a host — the fail-closed half', () => {
    // The point of the rule: it does not depend on decoding the rendering. A single override can make
    // arbitrary text read as anything, so its presence alone is the mismatch. Here no reading names a
    // host, the dialog has no better claim to print than the target, and it therefore AGREES WITH
    // ITSELF. That wording defect is the stated price of failing closed on an undecodable case; it is
    // pinned rather than described so it cannot be forgotten. ADR-016 lists it as a residual.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">${RLO}elbaknab</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'evil.tld',
      targetHost: 'evil.tld',
    })
  })

  it('warns on a link whose text names the right host but carries an override', () => {
    // The false positive, asserted. We cannot know the override did not reorder something, so a text
    // that reads correctly in written order still warns. RLO/LRO are essentially absent from real
    // mail — Unicode recommends the isolates instead, and the row below pins that those stay silent —
    // so this costs very little; it is the reason the rule can be unconditional.
    expect(verdictFor('https://bank.test/', `<a href="x">${RLO}tset.knab</a>`).kind).toBe(
      'mismatch',
    )
  })

  it.each([
    ['U+200F RIGHT-TO-LEFT MARK', '\u200F'],
    ['U+200E LEFT-TO-RIGHT MARK', '\u200E'],
    ['U+061C ARABIC LETTER MARK', '\u061C'],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', '\u2066'],
    ['U+2067 RIGHT-TO-LEFT ISOLATE', '\u2067'],
    ['U+2068 FIRST STRONG ISOLATE', '\u2068'],
    ['U+2069 POP DIRECTIONAL ISOLATE', '\u2069'],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', '\u202A'],
    ['U+202B RIGHT-TO-LEFT EMBEDDING', '\u202B'],
    ['U+202C POP DIRECTIONAL FORMATTING', '\u202C'],
  ])('%s does NOT trigger it — direction is not reordering', (_label, ch) => {
    // The narrowness IS the feature. Marks influence the placement of neighbouring neutrals only;
    // embeddings and isolates set the surrounding level while every character keeps its own class, so
    // a Latin run inside one still reads left to right. All of them are ordinary in legitimate
    // right-to-left mail. The app ships German and English today, but this module is shared and RTL
    // readiness is a tracked M4 concern — a blanket "any bidi control warns" rule would become a tax
    // on every Arabic and Hebrew message the day it arrives.
    expect(verdictFor('https://bank.test/', `<a href="x">${ch}bank.test</a>`).kind).toBe('ok')
    expect(verdictFor('https://bank.test/', `<a href="x">bank${ch}.test</a>`).kind).toBe('ok')
  })

  it('still reports a genuinely broken claim rather than the override, when there is one', () => {
    // Ordering: the normal every-claim loop runs first, so a text that names a host the click does
    // not reach reports THAT host. The override branch is the fallback, not the headline.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">bank.test ${RLO}x</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('reads the reversed word as a claim, which is what puts the reader’s host in the dialog', () => {
    // Pins the reversed reading on its own. Without it the attack above still warns — the override
    // branch sees to that — but the dialog names `evil.tld` twice and tells the reader nothing.
    expect(verdictFor('https://evil.tld/steal', `<a href="x">${RLO}tset.knab</a>`)).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('reverses by CODE POINT, so a non-BMP letter is moved rather than broken in half', () => {
    // The reader sees `𐐀bank.test`, whose host really is `xn--bank-9k5y.test`. Reversing by UTF-16
    // unit instead swaps the two halves of the surrogate pair, IDNA drops the resulting lone
    // surrogates, and the dialog then tells the reader the link says `bank.test` — a different host
    // from the one in front of them. Narrow, and the whole value of the reversed reading is that the
    // name it prints is the one that was actually shown.
    expect(
      verdictFor('https://evil.tld/steal', `<a href="x">${RLO}tset.knab\u{10400}</a>`),
    ).toEqual({
      kind: 'mismatch',
      claimedHost: 'xn--bank-9k5y.test',
      targetHost: 'evil.tld',
    })
  })

  it('does not let an override inside markup escape the check', () => {
    // The character travels in a text node, so both renderings carry it and `sanitize` has no opinion
    // about it — which is exactly why this is here and not in the allowlist.
    expect(
      verdictFor(
        'https://evil.tld/steal',
        `<a href="x"><span style="color:#c00">${RLO}</span>nigol/tset.knab</a>`,
      ).kind,
    ).toBe('mismatch')
  })
})

// ---- D12: residuals named in the header, pinned so the prose is checked rather than trusted ----

describe('residuals the header names, asserted as the ok/mismatch they really are (D12)', () => {
  it('a title naming a host claims nothing — hover-only text, a stated judgement', () => {
    // The last two fixtures are the load-bearing ones: `<a>` and `<span>` are elements `attrTextOf`
    // returns `''` for whatever it is asked, so those rows pass whether or not the decision holds.
    // `<img>` and `<input>` are elements it really does read attributes off, which is the only place
    // the decision could drift. `frame.test.ts` pins the same thing at the walk.
    for (const html of [
      '<a href="x" title="bank.test">Click here</a>',
      '<a href="x"><span title="bank.test">Click</span></a>',
      '<a href="x"><img alt="Click" title="bank.test"></a>',
      '<a href="x"><input type="image" alt="Click" title="bank.test"></a>',
      '<a href="x"><input type="submit" value="Click" title="bank.test"></a>',
    ]) {
      expect(verdictFor('https://evil.tld/steal', html).kind).toBe('ok')
    }
  })

  it('an <input type="image"> alt IS read, which is the A4b half of the same walk', () => {
    // The counterpart to the row above, so the pair reads as a decision rather than an omission.
    expect(
      verdictFor('https://evil.tld/steal', '<a href="x"><input type="image" alt="bank.test"></a>'),
    ).toEqual({ kind: 'mismatch', claimedHost: 'bank.test', targetHost: 'evil.tld' })
  })

  it('a <bdo dir="rtl"> is the MARKUP spelling of an override and is NOT closed', () => {
    // `sanitize` keeps `<bdo>` and its `dir`, and D13's rule is a character-level one that does not
    // see it. The reader is shown `bank.test`; the classifier reads `tset.knab`, which names no host;
    // the link opens in silence. Asserted as the `ok` it really is, and listed in ADR-016.
    const markup = '<a href="x"><bdo dir="rtl">nigol/tset.knab</bdo></a>'
    expect(sanitize(markup).html).toContain('<bdo dir="rtl">')
    expect(verdictFor('https://evil.tld/steal', markup).kind).toBe('ok')
  })

  it('a host written with U+3002 IDEOGRAPHIC FULL STOP claims nothing, and a browser resolves it', () => {
    // NFKC does NOT fold U+3002 to `.` (checked against the engine, not recalled), so the word is not
    // host-shaped and no claim is produced — while the URL parser treats U+3002 as a label separator,
    // i.e. a browser really would go to `bank.test`. Open, known, and asserted in both halves.
    expect(displayHost('https://bank\u3002test/')).toBe('bank.test')
    expect(verdictFor('https://evil.tld/steal', '<a href="x">bank\u3002test</a>').kind).toBe('ok')
  })

  it('a bare IP address claims nothing — the last label must be letters', () => {
    expect(kindOf('https://evil.tld/', '192.168.1.1')).toBe('ok')
    expect(kindOf('https://evil.tld/', 'Melden Sie sich bei 10.0.0.1 an')).toBe('ok')
  })

  it('a comment between two text nodes is not a boundary, in either rendering', () => {
    // SEPARATED separates at ELEMENT boundaries and only there. Harmless rather than open: a comment
    // renders nothing, so the READER sees `bank.testx9` fused exactly as the classifier does — there
    // is no gap between what is shown and what is read, which is the only property the pair is for.
    const parts = anchorLinkText('<a href="https://evil.tld/steal">bank.test<!--c-->x9</a>')
    expect(parts.raw).toBe('bank.testx9')
    expect(parts.separated).toBe('bank.testx9')
    expect(classifyLink('https://evil.tld/steal', parts, APP).kind).toBe('ok')
  })
})

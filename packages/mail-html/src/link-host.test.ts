import { describe, expect, it } from 'vitest'
import { classifyLink, displayHost } from './link-host'

/** The two halves of the contract, named: a warning must fire, or a warning must NOT fire. */
const mismatch = (href: string, text: string) => classifyLink(href, text)
const kindOf = (href: string, text: string) => classifyLink(href, text).kind

/** What the app passes as the base: the document a click is resolved against. */
const APP = 'https://app.waxwing.test/read/e1'

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

// ---- D3 + D4: hidden markup, and the one-character opt-out ----

describe('classifyLink — hidden markup inside the anchor (D3)', () => {
  it('reads a host that a display:none prefix made "prose"', () => {
    // `<a href="https://evil.tld/"><span style="display:none">!</span>bank.test</a>` reaches the app
    // as the text `!bank.test`; the reader sees exactly `bank.test`. `sanitize` keeps `display:none`
    // and `hidden` on purpose (real mail leans on them, preheaders above all), so the claim has to be
    // read correctly HERE rather than guessed at in the sanitizer.
    expect(mismatch('https://evil.tld/', '!bank.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.tld',
    })
  })

  it('reads it with the hidden markup on the other side too', () => {
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

  it('is ok when ANY named host covers the target, not only the first', () => {
    expect(kindOf('https://help.bank.test/x', 'other.test or help.bank.test')).toBe('ok')
  })

  it('reports the FIRST claimed host when none of them is honoured', () => {
    expect(mismatch('https://evil.ru/x', 'bank.test and paypal.test')).toEqual({
      kind: 'mismatch',
      claimedHost: 'bank.test',
      targetHost: 'evil.ru',
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

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitize } from './sanitize'

/** No lowercase http/https URL survives anywhere in the output. */
function hasNoRemoteUrl(html: string): boolean {
  return !/https?:\/\//i.test(html)
}

describe('sanitize — XSS corpus', () => {
  it('strips <script>', () => {
    const { html } = sanitize('<p>hi</p><script>alert(1)</script>')
    expect(html).toContain('hi')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('strips inline event handlers', () => {
    const { html } = sanitize('<img src="cid:x" onerror="alert(1)">')
    expect(html.toLowerCase()).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('neutralizes javascript: hrefs', () => {
    const { html } = sanitize('<a href="javascript:alert(1)">x</a>')
    expect(html).not.toContain('javascript:')
  })

  it('drops SVG entirely (no <svg onload>, no <svg><script>)', () => {
    const { html } = sanitize('<svg onload="alert(1)"><script>alert(2)</script></svg><p>ok</p>')
    expect(html.toLowerCase()).not.toContain('<svg')
    expect(html.toLowerCase()).not.toContain('onload')
    expect(html).not.toContain('alert(')
    expect(html).toContain('ok')
  })

  it('strips a remote background from an inline style (CSS exfiltration)', () => {
    const result = sanitize('<div style="background:url(https://evil.example/x)">y</div>')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote.some((b) => b.kind === 'style')).toBe(true)
  })

  it('forbids <meta http-equiv=refresh>', () => {
    const { html } = sanitize(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>z</p>',
    )
    expect(html.toLowerCase()).not.toContain('<meta')
    expect(html.toLowerCase()).not.toContain('http-equiv')
  })

  it('forbids forms', () => {
    const { html } = sanitize('<form action="https://evil.example"><input name="a"></form><p>z</p>')
    expect(html.toLowerCase()).not.toContain('<form')
    expect(html).toContain('z')
  })

  it('neutralizes DOM-clobbering name/id', () => {
    const { html } = sanitize('<img name="body"><a id="location">x</a>')
    // SANITIZE_NAMED_PROPS prefixes clobbering names/ids so they cannot shadow document props.
    expect(html).not.toMatch(/\sname="body"/)
    expect(html).not.toMatch(/\sid="location"/)
  })

  it('forbids <base> injection', () => {
    const { html } = sanitize('<base href="https://evil.example/"><p>z</p>')
    expect(html.toLowerCase()).not.toContain('<base')
    expect(hasNoRemoteUrl(html)).toBe(true)
  })

  it('blocks a remote srcset', () => {
    const result = sanitize('<img srcset="https://evil.example/x 1x, https://evil.example/y 2x">')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote.some((b) => b.kind === 'image')).toBe(true)
  })

  it('drops a non-image data: URL but the element survives', () => {
    const { html } = sanitize('<img src="data:text/html,<script>alert(1)</script>">')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('alert(1)')
  })

  it('keeps a data:image URL', () => {
    const { html } = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(html).toContain('data:image/png')
  })
})

describe('sanitize — the URL forms the scheme test used to miss (S8)', () => {
  // Every value here classified as `other` before the fix, which means: emitted verbatim, nothing in
  // `blockedRemote`, and `hasRemoteContent` FALSE — so MessageView showed no remote-content banner at
  // all and the reader was told the mail contains none. The URL a browser parses out of each one is
  // an ordinary cross-origin URL (WHATWG URL §4.1 strips C0 controls at the edges and tab/LF/CR
  // anywhere; a special scheme reads `\` as `/`), so each was a tracking pixel nothing ever reported.
  //
  // BOTH halves are asserted every time. "Blocked" alone would also be satisfied by a value that is
  // merely unrecognised, and the banner is the half that was actually lying to the reader.

  /** [label, attribute value, the URL the manifest should name] */
  type Form = [label: string, value: string, parsed: string]

  /** Junk at the EDGES, or slashes the parser folds — meaningful in every URL attribute. */
  const edgeForms: Form[] = [
    ['a leading U+0001 (&#1;)', '\u0001https://evil.tld/t.gif', 'https://evil.tld/t.gif'],
    ['a leading U+001F (&#31;)', '\u001fhttps://evil.tld/t.gif', 'https://evil.tld/t.gif'],
    ['a leading U+0008', '\bhttps://evil.tld/t.gif', 'https://evil.tld/t.gif'],
    ['a trailing U+0001', 'https://evil.tld/t.gif\u0001', 'https://evil.tld/t.gif'],
    ['a control character before //', '\u0001//evil.tld/t.gif', '//evil.tld/t.gif'],
    ['backslashes for the authority', '\\\\evil.tld/t.gif', '\\\\evil.tld/t.gif'],
    ['a mixed slash pair', '/\\evil.tld/t.gif', '/\\evil.tld/t.gif'],
    ['a mixed slash pair the other way round', '\\/evil.tld/t.gif', '\\/evil.tld/t.gif'],
    ['three slashes, one of them a backslash', '/\\/evil.tld/t.gif', '/\\/evil.tld/t.gif'],
  ]

  /** Tab/LF/CR INSIDE the URL. Not applicable to `srcset`, where whitespace separates candidates. */
  const innerForms: Form[] = [
    ['a tab inside the scheme', 'ht\ttps://evil.tld/t.gif', 'https://evil.tld/t.gif'],
    ['a newline inside the scheme', 'htt\nps://evil.tld/t.gif', 'https://evil.tld/t.gif'],
    ['a CR inside the host', 'https://evil\r.tld/t.gif', 'https://evil.tld/t.gif'],
  ]

  const allForms = [...edgeForms, ...innerForms]

  it.each(allForms)('blocks %s in src, and says so', (_label, value, parsed) => {
    const result = sanitize(`<img src="${value}">`)
    expect(result.html).not.toContain('evil')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toEqual([{ url: parsed, kind: 'image' }])
  })

  it.each(allForms)('blocks %s in a video poster, and says so', (_label, value, parsed) => {
    const result = sanitize(`<video poster="${value}"></video>`)
    expect(result.html).not.toContain('evil')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toEqual([{ url: parsed, kind: 'media' }])
  })

  it.each(allForms)('blocks %s in a cell background, and says so', (_label, value, parsed) => {
    const result = sanitize(`<table><tr><td background="${value}">x</td></tr></table>`)
    expect(result.html).not.toContain('evil')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toEqual([{ url: parsed, kind: 'other' }])
  })

  it.each(edgeForms)('blocks %s in srcset, and says so', (_label, value, parsed) => {
    // Only the edge forms: tab/LF/CR are candidate-SEPARATING whitespace in the srcset grammar, so
    // `ht<tab>tps://…` is the relative URL `ht` plus a junk descriptor to the browser as well, and
    // nothing cross-origin is ever requested from it.
    const result = sanitize(`<img srcset="${value} 1x">`)
    expect(result.html).not.toContain('evil')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toEqual([{ url: parsed, kind: 'image' }])
  })

  /**
   * The same attack in a CSS `url()`, where one more layer sits in front of the URL parser: the CSS
   * tokenizer consumes `\<char>` as an ESCAPE first. So the slash forms have to be written doubled to
   * reach the URL parser as slashes at all, and the undoubled ones are deliberately absent from this
   * list rather than forgotten — `url(\\evil.tld/x)` is the escape `\` plus `evil.tld/x`, i.e. the
   * same-origin path `\evil.tld/x`, and `url(/\evil.tld/x)` escapes `e` into U+000E. Neither is
   * cross-origin in a browser, and `cssUnescape` reproduces exactly that step before classifying,
   * which is the reason this file sees the same string the browser does.
   */
  const cssForms: Array<[label: string, value: string]> = [
    ['a leading U+0001', '\u0001https://evil.tld/t.gif'],
    ['a leading U+001F', '\u001fhttps://evil.tld/t.gif'],
    ['a control character before //', '\u0001//evil.tld/t.gif'],
    ['DOUBLED backslashes, which the tokenizer folds to a real `\\\\`', '\\\\\\\\evil.tld/t.gif'],
    ['`/\\/`, whose escape yields the second slash', '/\\/evil.tld/t.gif'],
    ['a tab inside the scheme', 'ht\ttps://evil.tld/t.gif'],
    ['a CR inside the host', 'https://evil\r.tld/t.gif'],
  ]

  it.each(cssForms)('blocks %s inside a CSS url(), and says so', (_label, value) => {
    // The fail-closed residual check did not catch these either: the rewritten `url()` looked
    // handled, so the whole style was kept with the remote URL still sitting in it.
    const result = sanitize(`<div style="background:url(${value})">x</div>`)
    expect(result.html).not.toContain('evil')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote.some((blocked) => blocked.kind === 'style')).toBe(true)
  })

  it('still resolves a cid: through the same normalisation', () => {
    // The stripping is shared, so the legitimate cases have to keep working exactly as before.
    const { html } = sanitize('<img src=" cid:logo@x ">', {
      resolveCid: (id) => (id === 'logo@x' ? 'blob:https://app/abc' : null),
    })
    expect(html).toContain('blob:https://app/abc')
  })

  it('still keeps a raster data:image URL', () => {
    const { html } = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(html).toContain('data:image/png')
  })

  it('does not hand a junk-prefixed javascript: URL back to DOMPurify as force-kept', () => {
    // Why the `other` branch returns the RAW value and not the normalised one: a replacement that
    // DIFFERS from the input makes the hook call `setAttribute` + `forceKeepAttr`, which is exactly
    // the path that bypasses DOMPurify's URI allowlist. Normalising an unrecognised scheme there
    // would have turned this fix into an XSS.
    const { html } = sanitize('<img src="\u0001javascript:alert(1)">')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('alert(1)')
  })
})

describe('sanitize — remote-content policy', () => {
  it('blocks remote images by default and records them', () => {
    const result = sanitize('<img src="https://tracker.example/pixel.gif">')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toHaveLength(1)
    expect(result.blockedRemote[0]?.url).toBe('https://tracker.example/pixel.gif')
  })

  it('keeps remote images when allowRemote is set', () => {
    const result = sanitize('<img src="https://cdn.example/logo.png">', { allowRemote: true })
    expect(result.html).toContain('https://cdn.example/logo.png')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toHaveLength(0)
  })

  it('resolves cid: via the resolver, drops it when unresolved', () => {
    const resolved = sanitize('<img src="cid:logo@x">', {
      resolveCid: (id) => (id === 'logo@x' ? 'blob:https://app/abc' : null),
    })
    expect(resolved.html).toContain('blob:https://app/abc')

    const dropped = sanitize('<img src="cid:missing">', { resolveCid: () => null })
    expect(dropped.html).not.toContain('cid:')
    expect(dropped.html).not.toContain('missing')
  })

  it('preserves a benign anchor href', () => {
    const { html } = sanitize('<a href="https://example.com">link</a>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('link')
  })

  it('leaves no remote URL when a mail packs many remote resources (zero-network proxy)', () => {
    // Stand-in for the Done-when "zero network requests" — a real browser network-spy E2E is M1.9/M4.7.
    const result = sanitize(
      '<img src="https://a.example/1.png">' +
        '<img srcset="https://b.example/2.png 1x">' +
        '<div style="background:url(https://c.example/3.png)">x</div>' +
        '<video poster="https://d.example/4.jpg"></video>',
    )
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.blockedRemote.length).toBeGreaterThan(0)
    expect(result.hasRemoteContent).toBe(true)
  })

  it('records a BlockedResource when the fail-closed residual check drops a whole style', () => {
    // The residual branch set `hasRemote` and pushed nothing, so a mail with only this in it reported
    // "remote content" beside an EMPTY manifest — which reads as a bug in the counter rather than as
    // the fail-closed drop it is. The STYLE_DANGER branch above it always recorded; now both do.
    const result = sanitize('<div style="background:url(https://evil.tld/x">y</div>')
    expect(result.html).not.toContain('evil.tld')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toEqual([
      { url: 'background:url(https://evil.tld/x', kind: 'style' },
    ])
  })

  it('rejects a cid resolver that returns a non-image data: URL (buggy/hostile resolver)', () => {
    const result = sanitize('<img src="cid:x">', {
      resolveCid: () => 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    })
    expect(result.html).not.toContain('data:text/html')
  })

  it('keeps a cid resolver that returns a blob: URL', () => {
    const result = sanitize('<img src="cid:x">', { resolveCid: () => 'blob:https://app/abc' })
    expect(result.html).toContain('blob:https://app/abc')
  })
})

describe('sanitize — srcset is a grammar, not a comma-separated list', () => {
  it('keeps a cid-only srcset instead of dropping the attribute it just rewrote (F9)', () => {
    // The URL_ATTRS branch force-keeps its rewritten value precisely because DOMPurify's URI
    // allowlist excludes `blob:`; the srcset branch did not, so DOMPurify stripped the attribute
    // straight back off and `<img srcset="cid:logo 1x">` rendered no image at all.
    const { html } = sanitize('<img srcset="cid:logo 1x">', {
      resolveCid: (id) => (id === 'logo' ? 'blob:https://app/l' : null),
    })
    expect(html).toContain('srcset="blob:https://app/l 1x"')
  })

  it('keeps the descriptorless spelling of the same thing', () => {
    const { html } = sanitize('<img srcset="cid:logo">', { resolveCid: () => 'blob:https://app/l' })
    expect(html).toContain('srcset="blob:https://app/l"')
  })

  it('leaves DOMPurify to refuse an unknown scheme, rather than force-keeping it along', () => {
    // Why the force-keep is scoped to a RESOLVED cid and not to "the value changed": a candidate
    // whose scheme this file does not recognise is returned verbatim by design, and force-keeping is
    // the one path that takes DOMPurify's URI test out of the picture. A srcset cannot execute a
    // `javascript:` URL in any browser, so this is not an XSS either way — it is the override being
    // spent only where it is needed.
    const { html } = sanitize('<img srcset="javascript:alert(1) 1x">')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('alert(1)')
  })

  it('treats a comma inside a CDN transform path as part of the URL, not as a separator (F10)', () => {
    // Splitting on every `,` turned ONE candidate into two bogus ones, and then reported
    // `https://cdn.test/w_100` — a URL that never appeared in the mail — in the manifest.
    const result = sanitize('<img srcset="https://cdn.test/w_100,h_50/a.png 1x">')
    expect(result.blockedRemote).toEqual([
      { url: 'https://cdn.test/w_100,h_50/a.png', kind: 'image' },
    ])
  })

  it('carries that URL through unchanged when remote content is allowed', () => {
    const { html } = sanitize(
      '<img srcset="https://cdn.test/w_100,h_50/a.png 1x, https://cdn.test/b.png 2x">',
      { allowRemote: true },
    )
    expect(html).toContain(
      'srcset="https://cdn.test/w_100,h_50/a.png 1x, https://cdn.test/b.png 2x"',
    )
  })

  it('still separates candidates at a comma that ENDS a URL', () => {
    // The other half of the grammar: a comma the URL run ends with IS a separator, and the candidate
    // it closes takes no descriptor. Without that branch the two would fuse into one URL that
    // exists nowhere — the same manifest lie as F10, in the opposite direction.
    const result = sanitize('<img srcset="https://cdn.test/a.png, https://cdn.test/b.png 2x">')
    expect(result.blockedRemote).toEqual([
      { url: 'https://cdn.test/a.png', kind: 'image' },
      { url: 'https://cdn.test/b.png', kind: 'image' },
    ])
  })

  it('keeps the candidates that survive and drops only the blocked ones', () => {
    const result = sanitize('<img srcset="cid:logo 1x, https://cdn.test/b.png 2x">', {
      resolveCid: () => 'blob:https://app/l',
    })
    expect(result.html).toContain('srcset="blob:https://app/l 1x"')
    expect(result.blockedRemote).toEqual([{ url: 'https://cdn.test/b.png', kind: 'image' }])
  })
})

describe('sanitize — the inline-style ALLOWLIST inside anchors (ADR-016, wave 4)', () => {
  // The one place this sanitizer takes a view on VISIBILITY. Inside an <a>, and only there, a
  // descendant's inline style is filtered against a list of PROPERTIES; everything else is dropped
  // whatever its value. Outside an anchor nothing changes, because that is how preheaders work.
  //
  // Read the block at the bottom of this file before adding a sentence about closure to any of these
  // names: `color` is on the allowlist on purpose, so hiding inside an anchor is NOT shut.

  /** The property that has to survive, and the one that must not — asserted on the same fixture. */
  function styledSpan(css: string): string {
    return sanitize(`<a href="https://x.test/"><span style="${css}">junk</span>visible</a>`).html
  }

  it.each([
    ['display:none', 'style="display:none"', /display/i],
    ['visibility:hidden', 'style="visibility:hidden"', /visibility/i],
    ['visibility:collapse', 'style="visibility:collapse"', /visibility/i],
    ['font-size:0', 'style="font-size:0"', /font-size/i],
    ['the hidden attribute', 'hidden', /hidden(=|\s|>)/i],
  ])('strips %s from a descendant of an anchor', (_label, attr, marker) => {
    const { html } = sanitize(`<a href="https://x.test/"><span ${attr}>junk</span>visible</a>`)
    expect(html).not.toMatch(marker)
    // The TEXT is never removed — this changes what is rendered, not what the mail said.
    expect(html).toContain('junk')
    expect(html).toContain('visible')
  })

  it.each([
    ['display:none', 'style="display:none"', /display:\s*none/i],
    ['visibility:hidden', 'style="visibility:hidden"', /visibility:\s*hidden/i],
    ['font-size:0', 'style="font-size:0"', /font-size:\s*0/i],
    ['the hidden attribute', 'hidden', /hidden(=|\s|>)/i],
  ])('keeps %s outside an anchor — this is what a preheader is', (_label, attr, marker) => {
    const { html } = sanitize(
      `<div ${attr}>Ihre Rechnung für Juli 2026</div><p>Sehr geehrte Frau Wilke,</p>`,
    )
    expect(html).toMatch(marker)
  })

  it('leaves a body-level style untouched even when the property is off the anchor allowlist', () => {
    // The allowlist is scoped, not global. Outside an <a> this file has no opinion at all: a
    // preheader's `position`/`max-height`/`overflow` clamp is the standard spelling and survives.
    const { html } = sanitize(
      '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Preheader</div>',
    )
    expect(html).toMatch(/display:\s*none/i)
    expect(html).toMatch(/max-height:\s*0/i)
    expect(html).toMatch(/overflow:\s*hidden/i)
    expect(html).toMatch(/opacity:\s*0/i)
  })

  it('keeps hiding on the anchor itself — a link nobody can see cannot deceive anybody', () => {
    const { html } = sanitize('<a href="https://x.test/" style="display:none">gone</a>')
    expect(html).toMatch(/display:\s*none/i)
  })

  it('keeps the allowlisted declarations of a mixed style and drops the rest', () => {
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-weight:bold;display:none;color:#c00">j</span></a>',
    )
    expect(html).not.toMatch(/display/i)
    expect(html).toMatch(/font-weight:\s*bold/i)
    expect(html).toMatch(/color:\s*#c00/i)
  })

  it('drops the style attribute rather than leaving an empty one', () => {
    const { html } = sanitize('<a href="https://x.test/"><span style="display:none">j</span></a>')
    expect(html).toContain('<span>j</span>')
    expect(html).not.toContain('style=""')
  })

  it('reaches a descendant nested several elements below the anchor', () => {
    const { html } = sanitize(
      '<a href="https://x.test/"><b><i><span style="display:none">j</span></i></b>v</a>',
    )
    expect(html).not.toMatch(/display/i)
  })

  // ---- A3a: the spellings the wave-2 DENYLIST kept, because its value was anchored at `\s*$` ----

  it.each([
    ['!important, unspaced — the spelling real mail uses', 'display:none!important'],
    ['!important, spaced', 'display:none !important'],
    ['!important, mixed case', 'display:none!IMPORTANT'],
    ['!important with padding everywhere', 'display : none ! important'],
    ['a comment between the colon and the keyword', 'display:/**/none'],
    ['a trailing comment', 'display:none/*x*/'],
    ['visibility with !important', 'visibility:hidden!important'],
    ['a zero font-size with !important', 'font-size:0!important'],
    ['a CSS-escaped property name', 'display\\3a none'],
    ['a CSS-escaped letter in the property name', 'displa\\79 :none'],
    ['uppercase', 'DISPLAY:NONE'],
  ])('drops the declaration written as %s', (_label, css) => {
    const html = styledSpan(css)
    // Nothing of the declaration survives — not the property, not the value, not the attribute.
    expect(html).toContain('<span>junk</span>')
    expect(html.toLowerCase()).not.toContain('display')
    expect(html.toLowerCase()).not.toContain('visibility')
    expect(html.toLowerCase()).not.toContain('font-size')
  })

  // ---- A3b: geometric hiding, which the wave-2 denylist never enumerated at all ----

  it.each([
    'position:absolute;left:-9999px',
    'position:absolute;top:-9999px',
    'position:absolute;clip:rect(0,0,0,0)',
    'position:fixed;left:-100vw',
    'text-indent:-9999px',
    'clip-path:inset(100%)',
    'transform:scale(0)',
    'transform:translateX(-9999px)',
    'max-height:0;overflow:hidden',
    'height:0;overflow:hidden',
    'width:0;overflow:hidden',
    'opacity:0',
    'filter:opacity(0)',
    'font-size:0.0001px',
    'line-height:0;font-size:0',
    'display:none;position:absolute;opacity:0',
  ])('leaves no style attribute at all for %s', (css) => {
    // Each of these survived wave 2 intact. Asserting on the whole element rather than on a marker
    // regex: the claim is that NOTHING of the style is kept, not that one substring went missing.
    expect(styledSpan(css)).toContain('<span>junk</span>')
  })

  it('drops a property nobody here has heard of, which is the point of an allowlist', () => {
    // The denylist's structural weakness: anything invented after it was written was allowed. This
    // one is not a real hiding vector, and that is deliberate — the assertion is about the DEFAULT.
    expect(
      styledSpan('content-visibility:hidden;rotate:90deg;-webkit-text-fill-color:transparent'),
    ).toContain('<span>junk</span>')
  })

  // ---- The value constraints on the two allowlisted properties that can still collapse a box ----

  it.each([
    '0',
    '0px',
    '0pt',
    '0em',
    '0%',
    '0.0em',
    '.0px',
    '00',
    '0.0001px',
    '0.4px',
    '1px',
    '3px',
    '0.01em',
    '10%',
  ])('drops font-size:%s — below this the text is not small, it is gone', (value) => {
    expect(styledSpan(`font-size:${value}`)).toContain('<span>junk</span>')
  })

  it.each([
    '0.5em',
    '12px',
    '4px',
    '100%',
    '1.2em',
    'medium',
    'larger',
    'inherit',
  ])('keeps font-size:%s — at this size the text is there to be read', (value) => {
    expect(styledSpan(`font-size:${value}`)).toMatch(/font-size/i)
  })

  it.each(['0', '0px', '0.1', '0.2em'])('drops line-height:%s — the same floor', (value) => {
    expect(styledSpan(`line-height:${value}`)).toContain('<span>junk</span>')
  })

  it.each(['1.2', 'normal', '20px', '150%'])('keeps line-height:%s', (value) => {
    expect(styledSpan(`line-height:${value}`)).toMatch(/line-height/i)
  })

  // ---- A4a: a value that BEGINS with a large number and COMPUTES to zero ----

  it.each([
    'calc(100px * 0)',
    'calc(100px*0)',
    'calc(1em*0)',
    'calc(16px * 0.0001)',
    'calc(100px/100000)',
    'min(100px,0px)',
    'max(0px,0px)',
    'clamp(0px,0px,100px)',
    'var(--u,calc(9px*0))',
    'calc(100px*0)!important',
    'CALC(100PX * 0)',
    'calc(calc(100px) * 0)',
  ])('drops font-size:%s — a computed value is never read, only rejected', (value) => {
    // Every one of these was KEPT verbatim by wave 3, which read the first literal number (`100`) and
    // compared it to the floor. The fix does not evaluate the arithmetic — it refuses the whole shape.
    expect(styledSpan(`font-size:${value}`)).toContain('<span>junk</span>')
  })

  it.each([
    'calc(1em*0)',
    'min(100px,0px)',
    'var(--u,calc(0px))',
  ])('drops line-height:%s for the same reason', (value) => {
    expect(styledSpan(`line-height:${value}`)).toContain('<span>junk</span>')
  })

  it('drops a legitimate font-size:calc() too, and that is the accepted cost', () => {
    // Named as the cost it is, not papered over: the text then inherits the anchor's size. It is
    // visible; it is merely not the author's size. ADR-016 lists it under what real mail loses.
    expect(styledSpan('font-size:calc(1rem + 2px)')).toContain('<span>junk</span>')
  })

  it('leaves calc() alone on a property that carries no value constraint', () => {
    // The paren rule is scoped to the two SIZED properties. `padding:calc(...)` cannot collapse the
    // text it wraps, so it is not this rule's business and real mail uses it.
    expect(styledSpan('padding:calc(12px + 2px)')).toMatch(/padding/i)
  })

  it('drops a font-size whose number is too large to represent', () => {
    // Pins the `!Number.isFinite` branch, which is reachable and not dead: 400 digits is a valid CSS
    // number and parses to Infinity, which would otherwise sail over the floor.
    expect(styledSpan(`font-size:${'9'.repeat(400)}px`)).toContain('<span>junk</span>')
  })

  it.each([
    'margin-left:-9999px',
    'margin:0 0 0 -9999px',
    'margin:-100vw',
    'letter-spacing:-1em',
    'word-spacing:-9999px',
    'vertical-align:-9999px',
    'padding-left:-9999px',
    'border-left-width:-9999px',
  ])('drops the allowlisted property %s because the value is negative', (css) => {
    expect(styledSpan(css)).toContain('<span>junk</span>')
  })

  it.each([
    'margin:0',
    'padding:12px 24px',
    'letter-spacing:normal',
    'vertical-align:middle',
  ])('keeps %s — a non-negative value on the same properties', (css) => {
    expect(styledSpan(css)).toContain('style=')
  })

  it('drops a negative length written with a CSS escape', () => {
    // Pins the `cssUnescape` on the VALUE side. A browser does not read `\2d 9999px` as a number at
    // all (escapes work in idents and strings, not in numbers), so this rejects more than a browser
    // would apply — the fail-closed direction, and the reason the term is here rather than absent.
    expect(styledSpan('margin-left:\\2d 9999px')).toContain('<span>junk</span>')
  })

  // ---- A4e: the property-name normalisation, pinned by what it ADMITS ----
  //
  // `trim`, `toLowerCase` and `cssUnescape` on the property name can only map a spelling ONTO an
  // allowlisted name — the allowlist holds no name with a space, a capital or a backslash in it — so
  // each one KEEPS declarations that would otherwise be dropped, and deleting any of them fails
  // closed. A guard that only ever admits more has to be pinned by what it admits, individually AND
  // together: any one of these three assertions alone survives deleting the other two terms.

  it('keeps a declaration after the first, whose property name carries the split’s leading space', () => {
    // `trim`, and it is not academic: this is what every multi-declaration style in real mail looks
    // like.
    expect(
      sanitize('<a href="https://x.test/"><span style="font-weight:bold; color:#c00">j</span></a>')
        .html,
    ).toMatch(/color:\s*#c00/i)
  })

  it('keeps an UPPERCASE allowlisted property name', () => {
    expect(styledSpan('COLOR:#c00')).toMatch(/COLOR/)
  })

  it('keeps a property name spelt with a CSS escape', () => {
    // `cssUnescape`. Note what it does NOT do: `display\3a none` has no literal colon, so it is not a
    // declaration at all and never reaches the allowlist — unescaping cannot manufacture a separator.
    expect(styledSpan('colo\\72:#c00')).toMatch(/colo/)
  })

  it('keeps a property name needing the trim, the lowercase AND the unescape at once', () => {
    // The composite. Individually-redundant terms need this: each of the three assertions above
    // passes with the other two terms deleted, so only a fixture that needs all three proves the
    // conjunction.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-weight:bold; COLO\\52 :#c00">j</span></a>',
    )
    expect(html).toMatch(/COLO/)
  })

  // ---- A4d: `;` inside a url() or a quoted string is not a declaration separator ----

  it('keeps a data: URI background whole, with the declaration after it', () => {
    // The regression this filter introduced (A4d). Splitting on every `;` truncated the kept
    // declaration at `data:image/png` and left an UNTERMINATED CSS string, which then swallowed
    // `color:#000` and everything after it. Legitimate mail, rendering wrongly because of our change.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="background:url(data:image/png;base64,iVBORw0KGgo=)' +
        ' no-repeat;color:#000">j</span></a>',
    )
    expect(html).toContain('base64,iVBORw0KGgo=')
    expect(html).toMatch(/color:\s*#000/i)
    expect(html).not.toContain('url(\'data:image/png"')
  })

  it('keeps a quoted value containing a semicolon whole', () => {
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-family:\'a;b\';color:#000">j</span></a>',
    )
    expect(html).toContain("font-family:'a;b'")
    expect(html).toMatch(/color:\s*#000/i)
  })

  it('still splits at a top-level semicolon after a balanced url()', () => {
    // The other direction: the depth counter must come back to zero, or the filter would fuse every
    // declaration after the first background into one and drop them wholesale.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="background:url(data:image/gif;base64,R0lGOD);' +
        'display:none;color:#c00">j</span></a>',
    )
    expect(html).not.toMatch(/display/i)
    expect(html).toMatch(/color:\s*#c00/i)
  })

  it('treats a backslash-escaped quote as part of the string, not as its end', () => {
    // Pins the escape branch of the splitter. Without it the `\'` closes the string, the `;` becomes
    // a separator and the value is truncated again — the A4d bug in its third spelling.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-family:\'a\\\';b\';color:#000">j</span></a>',
    )
    expect(html).toMatch(/color:\s*#000/i)
    expect(html).toContain(";b'")
  })

  it('does not lift a declaration out of the parentheses of a REJECTED one', () => {
    // Pins the paren-depth half of the splitter, which the quote half does not cover. Without it the
    // `;` inside `foo(…)` is a separator, `q:foo(a` is dropped as an unknown property, and the tail
    // `color:#fff)` is admitted as a declaration of its own — text extracted from inside another
    // declaration's value. With it the whole thing is one declaration, property `q`, dropped.
    //
    // Stated honestly: no hiding vector turns on this, because `color` is allowlisted anyway and an
    // attacker would simply write it directly. What it buys is that the splitter's pieces are the
    // input's declarations, which is the property the paragraph above `filterAnchorStyle` relies on.
    expect(styledSpan('q:foo(a;color:#fff)')).toContain('<span>junk</span>')
  })

  it('does not let a semicolon inside a string smuggle a dropped property into the output', () => {
    // A kept declaration may now CONTAIN a `;`, so the question is whether the browser could read one
    // as a separator where we did not. It cannot here: the `;` is inside a quoted string in both
    // parsers, so `display:none` is part of the font-family value and applies nothing.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-family:\'a;display:none\'">j</span></a>',
    )
    expect(html).toContain("font-family:'a;display:none'")
    const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span')
    expect(span?.style.display).toBe('')
  })

  // ---- S14: a NEWLINE also ends a CSS string, so the `;`s after it separate declarations ----

  it('does not let a newline-terminated string smuggle a reordering pair past the allowlist', () => {
    // The one shape where this splitter's divergence ran in the dangerous direction: the browser ends
    // the string at the newline (§4.3.5, `<bad-string-token>`) and reads `direction`/`unicode-bidi`
    // as declarations of their own, while the splitter kept the whole run as one allowlisted
    // `font-family` whose value nothing inspects. Inside an `<a>` that reverses the RENDERED link
    // text while `classifyLink` reads the written order, so no interstitial ever appears.
    const { html } = sanitize(
      '<a href="https://evil.tld/s"><span style="font-family:\'q\n' +
        ';direction:rtl;unicode-bidi:bidi-override">bank.test/login</span></a>',
    )
    expect(html.toLowerCase()).not.toContain('direction')
    expect(html.toLowerCase()).not.toContain('unicode-bidi')
    expect(html).toContain('bank.test/login')
  })

  it.each(['\n', '\r', '\f'])('ends the string on %j, which CSS folds to a newline', (nl) => {
    // §3.3 preprocessing folds CR, CRLF and FF to LF before the tokenizer runs, so all three end a
    // string. The attribute text reaches us unfolded, which is why the loop tests all three. The
    // `font-family` piece itself is KEPT — it is allowlisted, and the browser drops it as an invalid
    // declaration on its own; the claim here is only that `display:none` is no longer inside it.
    expect(styledSpan(`font-family:'q${nl};display:none`).toLowerCase()).not.toContain('display')
  })

  it('still treats a BACKSLASH-escaped newline as a line continuation inside the string', () => {
    // The one place a newline does not end a string: escaped, it is a CSS line continuation, and the
    // browser fuses to the end of the value exactly as the splitter's escape branch does. Dropping
    // `display` here would be the false-positive direction, and `display` is unset either way.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="font-family:\'a\\\n;b\';color:#000">j</span></a>',
    )
    expect(html).toMatch(/color:\s*#000/i)
    expect(html).toContain(';b')
  })

  it.each([
    ['an unclosed paren', 'background:url(a;display:none'],
    ['an unterminated string', "font-family:'a;display:none"],
    ['a stray close-paren', 'color:red);display:none'],
  ])('agrees with a real CSS parser about where the declaration boundary is, given %s', (_label, css) => {
    // The divergence that would matter is one where the BROWSER sees a boundary this splitter does
    // not, because a rejected property could then ride along inside a kept declaration's text.
    // Checked against a parser rather than reasoned about: for the first two the browser fuses to
    // the end of the value exactly as the splitter does, and for the third both see the boundary
    // and the `display:none` piece is dropped by the allowlist. In all three, `display` is unset.
    const span = new DOMParser().parseFromString(styledSpan(css), 'text/html').querySelector('span')
    expect(span?.style.display).toBe('')
  })

  // ---- The real-mail side of the trade, asserted rather than asserted-about ----

  it('leaves the classic call-to-action button intact: white text on a coloured background', () => {
    // The regression this allowlist could most easily have introduced. Dropping `background` while
    // keeping `color` would paint white-on-white and make legitimate text INVISIBLE — the exact
    // outcome the rule exists to prevent. Both halves are on the list, together.
    const { html } = sanitize(
      '<a href="https://shop.test/x"><span style="background:#0a5;color:#ffffff;' +
        'padding:12px 24px;border-radius:4px;font-family:Helvetica-Neue,sans-serif;' +
        'font-weight:bold;font-size:16px;text-decoration:none">Jetzt kaufen</span></a>',
    )
    expect(html).toMatch(/background:\s*#0a5/i)
    expect(html).toMatch(/color:\s*#ffffff/i)
    expect(html).toMatch(/padding:\s*12px 24px/i)
    expect(html).toMatch(/border-radius:\s*4px/i)
    expect(html).toMatch(/font-family:\s*Helvetica-Neue/i)
    expect(html).toMatch(/font-weight:\s*bold/i)
    expect(html).toMatch(/text-decoration:\s*none/i)
    expect(html).toContain('Jetzt kaufen')
  })

  it('keeps background-color and color separately too, for the same reason', () => {
    const { html } = sanitize(
      '<a href="https://shop.test/x"><span style="background-color:#036;color:#fff">Buy</span></a>',
    )
    expect(html).toMatch(/background-color:\s*#036/i)
    expect(html).toMatch(/color:\s*#fff/i)
  })

  it('drops background-clip but not the transparent colour beside it', () => {
    // `background-clip:text` plus `color:transparent` is an invisible-text recipe. Only half of it is
    // this rule's to take: `background-clip` is off the allowlist, `color` is on it deliberately. So
    // the recipe is DEGRADED, not defeated — the text renders in the page's own colour, which for a
    // literal `transparent` is still nothing. Pinned in both directions so neither half drifts.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="background-clip:text;color:transparent">j</span></a>',
    )
    expect(html).not.toMatch(/background-clip/i)
    expect(html).toMatch(/color:\s*transparent/i)
  })

  it('drops display:inline-block from a padded button — layout cost, not legibility', () => {
    // Named as the cost it is. `display` is off the list because admitting it means allowlisting its
    // VALUES; the button then renders tight instead of padded, and every character is still readable.
    const { html } = sanitize(
      '<a href="https://shop.test/x"><span style="display:inline-block;padding:12px;' +
        'background:#0a5;color:#fff">Buy</span></a>',
    )
    expect(html).not.toMatch(/display/i)
    expect(html).toMatch(/padding:\s*12px/i)
    expect(html).toMatch(/background:\s*#0a5/i)
    expect(html).toMatch(/color:\s*#fff/i)
  })

  it('drops an image’s own width/height/display but never the image', () => {
    // The other named cost. The frame's reset (`img{max-width:100%;height:auto}`) still bounds it,
    // and the width/height ATTRIBUTES that most mail actually uses are not touched by this rule.
    const { html } = sanitize(
      '<a href="https://shop.test/x"><img src="cid:l" width="600" height="80" ' +
        'style="display:block;width:600px;height:80px;border:0" alt="Logo"></a>',
      { resolveCid: () => 'blob:https://app/l' },
    )
    expect(html).toContain('width="600"')
    expect(html).toContain('height="80"')
    expect(html).toContain('alt="Logo"')
    expect(html).toMatch(/border:\s*0/i)
    expect(html).not.toMatch(/display:\s*block/i)
    expect(html).not.toMatch(/width:\s*600px/i)
  })

  // ---- What is NOT closed. These assertions are `kept` ON PURPOSE ----

  it('keeps colour and background — so hiding inside an anchor is NOT closed by this rule', () => {
    // `color:#fff` on the frame's known-white canvas is an always-available hide, and it stays
    // available because taking it away would break the button above. Everything this rule removes is
    // a spelling that hides WITHOUT a colour trick. No name in this file may say more than that.
    const { html } = sanitize(
      '<a href="https://x.test/"><span style="color:#ffffff">invisible on white</span></a>',
    )
    expect(html).toMatch(/color:\s*#ffffff/i)
  })

  it('keeps a reordering pair on the ANCHOR ITSELF — the descendant rule stops one element short', () => {
    // Read beside the S14 fixture above: closing the newline smuggle made the DESCENDANT rule whole,
    // and it buys nothing against this attack, because the anchor's own style is not filtered at all
    // (see `isInsideAnchor`). The rendered text reads `nigol/tset.knab` reversed into
    // `bank.test/login` while `classifyLink` reads the written order and finds nothing to warn about.
    // Pinned as KEPT so that nothing in this file can be read as having closed CSS-driven reordering.
    const { html } = sanitize(
      '<a href="https://evil.tld/s" style="direction:rtl;unicode-bidi:bidi-override">' +
        'nigol/tset.knab</a>',
    )
    expect(html).toMatch(/direction:\s*rtl/i)
    expect(html).toMatch(/unicode-bidi:\s*bidi-override/i)
  })

  it('does not constrain a large POSITIVE length, which displaces a run just as well', () => {
    // Negative lengths are rejected; positive ones are not. `padding-left:9999px` pushes a following
    // run out of the frame's visible column, and any per-declaration ceiling composes away under
    // nesting — so none is attempted, and this is written down instead of papered over.
    const { html } = sanitize(
      '<a href="https://x.test/">bank.test<span style="padding-left:9999px">x9</span></a>',
    )
    expect(html).toMatch(/padding-left:\s*9999px/i)
  })
})

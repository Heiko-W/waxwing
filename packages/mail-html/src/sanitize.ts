/**
 * HTML-mail sanitizer (M1.7, NFR-SEC-01, FR-RD-02/03, tech-stack §4.5 step 1). The first wall of the
 * defense-in-depth: a hardened DOMPurify pass that removes every scripting vector, then a
 * remote-content firewall implemented as a `uponSanitizeAttribute` hook that
 *  - blocks remote `http(s)`/protocol-relative resources by default (images, media, CSS `url()`),
 *    recording each in a manifest so the app can offer "load remote content" (FR-RD-02);
 *  - resolves `cid:` inline parts through a caller-supplied {@link SanitizeOptions.resolveCid}
 *    (the app turns the content-id into a `blob:` URL via `client.download` — the sanitizer never
 *    fetches or imports `@waxwing/jmap`, per the SP.4 auth-header constraint); and
 *  - permits only `data:image/*` (raster) data URIs, dropping every other `data:`.
 *
 * SVG/MathML are excluded entirely (`USE_PROFILES: { html: true }`), and `<style>`/`<base>`/`<meta>`
 * /`<form>`/framing/`<link>` elements are forbidden, so the only remaining URL surface is the set of
 * attributes + inline `style` `url()` that this hook governs. The result is a STRING for the frame.
 */

import DOMPurify from 'dompurify'

export interface BlockedResource {
  readonly url: string
  readonly kind: 'image' | 'style' | 'media' | 'other'
}

export interface SanitizeOptions {
  /** Keep remote `http(s)` resources (the app's per-message/per-sender "load remote content"). */
  readonly allowRemote?: boolean
  /** Resolve a `cid:` content-id to a `blob:`/`data:` URL (the app owns the JMAP blob download). */
  readonly resolveCid?: (contentId: string) => string | null
}

export interface SanitizeResult {
  readonly html: string
  /** Remote resources stripped from the mail (empty when `allowRemote`). */
  readonly blockedRemote: BlockedResource[]
  /** True when the ORIGINAL mail referenced any remote resource, whether blocked or kept. */
  readonly hasRemoteContent: boolean
}

const FORBID_TAGS = [
  'base',
  'meta',
  'object',
  'embed',
  'iframe',
  'frame',
  'frameset',
  'form',
  'link',
  'style',
  'noscript',
  'template',
]

const FORBID_ATTR = ['ping', 'srcdoc']

/** Attributes (besides `srcset`/`style`, handled specially) whose value is a single URL. */
const URL_ATTRS = new Set(['src', 'poster', 'background', 'longdesc', 'xlink:href'])

type UrlKind = 'cid' | 'remote' | 'dataImage' | 'dataOther' | 'other'

function classifyUrl(raw: string): { kind: UrlKind; cid?: string } {
  const url = raw.trim()
  const lower = url.toLowerCase()
  if (lower.startsWith('cid:')) return { kind: 'cid', cid: url.slice(4) }
  if (lower.startsWith('http:') || lower.startsWith('https:') || url.startsWith('//')) {
    return { kind: 'remote' }
  }
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(lower)) return { kind: 'dataImage' }
  if (lower.startsWith('data:')) return { kind: 'dataOther' }
  return { kind: 'other' }
}

function kindForAttr(attrName: string, tagName: string): BlockedResource['kind'] {
  if (attrName === 'style') return 'style'
  if (tagName === 'video' || tagName === 'audio' || tagName === 'source') return 'media'
  if (attrName === 'src' || attrName === 'srcset' || tagName === 'img') return 'image'
  return 'other'
}

/** Per-call remote-content manifest. Exported for direct security tests (not part of the public API). */
export interface Collector {
  readonly blocked: BlockedResource[]
  hasRemote: boolean
}

/**
 * Resolve one URL to its safe replacement, or `null` to drop it. Records remote hits in `collector`.
 * `allow` keeps remote URLs (the "load remote content" pass).
 */
function resolveUrl(
  raw: string,
  attrName: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): string | null {
  const { kind, cid } = classifyUrl(raw)
  switch (kind) {
    case 'cid': {
      const resolved = cid !== undefined ? (options.resolveCid?.(cid) ?? null) : null
      if (resolved === null) return null
      // Re-validate the resolver's OUTPUT: accept only a blob: URL or a raster data:image — never
      // trust a (buggy/compromised) resolver that hands back data:text/html, javascript:, http:, …
      if (resolved.trim().toLowerCase().startsWith('blob:')) return resolved
      return classifyUrl(resolved).kind === 'dataImage' ? resolved : null
    }
    case 'remote': {
      collector.hasRemote = true
      if (options.allowRemote) return raw
      collector.blocked.push({ url: raw.trim(), kind: kindForAttr(attrName, tagName) })
      return null
    }
    case 'dataImage':
      return raw
    case 'dataOther':
      return null
    default:
      return raw
  }
}

/** Longest inline `style` we will process; anything larger is dropped (defensive, also anti-ReDoS). */
const MAX_STYLE_LENGTH = 8192

/**
 * CSS functions/keywords with no legitimate place in mail styling that can fetch or execute — a
 * style containing any is dropped wholesale (fail-closed): `image-set`/`cross-fade` reference images
 * by bare string (not `url()`), and `expression`/`-moz-binding`/`behavior`/`@import`/`javascript:`
 * are code/fetch vectors. Tested against the CSS-UNESCAPED value so escapes cannot hide them.
 */
const STYLE_DANGER =
  /expression\(|behaviou?r\s*:|-moz-binding|@import|image-set|cross-fade|javascript:|vbscript:/i

/** Any remaining remote scheme after `url()` rewriting → a malformed `url()` the parser missed. */
const REMOTE_SCHEME = /https?:|\/\//i

/** Decode CSS escapes (`\XXXXXX ` hex and `\<char>`) so obfuscated schemes can't hide from checks. */
function cssUnescape(value: string): string {
  return value.replace(
    /\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g,
    (_match, hex?: string, ch?: string) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return ch ?? ''
    },
  )
}

/**
 * Sanitize an inline `style` value. Regex CSS parsing is inherently bypassable, so this is
 * FAIL-CLOSED: it rewrites known `url()`s, but drops the ENTIRE attribute if the value is oversized,
 * contains a dangerous function/keyword, or still carries a remote scheme after rewriting.
 */
export function sanitizeStyle(
  css: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): { value: string; drop: boolean } {
  if (css.length > MAX_STYLE_LENGTH) return { value: '', drop: true }
  if (STYLE_DANGER.test(cssUnescape(css))) {
    collector.hasRemote = true
    collector.blocked.push({ url: css.trim().slice(0, 128), kind: 'style' })
    return { value: '', drop: true }
  }
  // Linear `url(...)` match (no overlapping quantifiers → ReDoS-safe): capture up to the first `)`.
  const rewritten = css.replace(/url\(([^)]*)\)/gi, (_match, inner: string) => {
    const target = cssUnescape(inner.trim().replace(/^['"]|['"]$/g, ''))
    const replacement = resolveUrl(target, 'style', tagName, options, collector)
    // Blocked → empty url() (renders nothing); kept → re-quote with quotes/backslashes/parens
    // stripped from the safe replacement so it cannot break out of the CSS string.
    return replacement === null ? "url('')" : `url('${replacement.replace(/['"\\()]/g, '')}')`
  })
  // Fail closed: strip every WELL-FORMED `url(...)` (already handled above — safe replacement, empty,
  // or an intentionally-kept allowRemote URL), then if a remote scheme still remains it lived in a
  // MALFORMED/unbalanced `url(` the parser could not match — drop the whole style rather than leak it.
  const residual = cssUnescape(rewritten).replace(/url\([^)]*\)/gi, '')
  if (REMOTE_SCHEME.test(residual)) {
    collector.hasRemote = true
    return { value: '', drop: true }
  }
  return { value: rewritten, drop: false }
}

/** Keep only the srcset candidates that survive {@link resolveUrl}; empty result → drop the attr. */
function sanitizeSrcset(
  value: string,
  tagName: string,
  options: SanitizeOptions,
  collector: Collector,
): string | null {
  const kept: string[] = []
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const [url, ...descriptor] = trimmed.split(/\s+/)
    if (url === undefined) continue
    const replacement = resolveUrl(url, 'srcset', tagName, options, collector)
    if (replacement !== null) kept.push([replacement, ...descriptor].join(' '))
  }
  return kept.length > 0 ? kept.join(', ') : null
}

export function sanitize(html: string, options: SanitizeOptions = {}): SanitizeResult {
  const collector: Collector = { blocked: [], hasRemote: false }

  const hook = (
    node: Element,
    event: { attrName: string; attrValue: string; keepAttr: boolean },
  ) => {
    const attr = event.attrName
    const tag = node.tagName.toLowerCase()

    // Leave anchor/area link targets to the frame's link policy (DOMPurify already blocks
    // javascript:/vbscript: etc. via its default ALLOWED_URI_REGEXP).
    if (attr === 'href' && (tag === 'a' || tag === 'area')) return

    if (attr === 'style') {
      const styled = sanitizeStyle(event.attrValue, tag, options, collector)
      if (styled.drop) event.keepAttr = false
      else event.attrValue = styled.value
      return
    }

    if (attr === 'srcset') {
      const rewritten = sanitizeSrcset(event.attrValue, tag, options, collector)
      if (rewritten === null) {
        event.keepAttr = false
      } else {
        node.setAttribute('srcset', rewritten)
        event.attrValue = rewritten
      }
      return
    }

    if (URL_ATTRS.has(attr) || attr === 'href') {
      const replacement = resolveUrl(event.attrValue, attr, tag, options, collector)
      if (replacement === null) {
        event.keepAttr = false
        return
      }
      if (replacement !== event.attrValue) {
        // A resolved cid → blob:/data: URL. Set it ourselves and force-keep so DOMPurify's URI
        // allowlist (which excludes blob:) does not strip our known-safe replacement.
        node.setAttribute(attr, replacement)
        ;(event as { forceKeepAttr?: boolean }).forceKeepAttr = true
      }
    }
  }

  DOMPurify.addHook('uponSanitizeAttribute', hook)
  try {
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_ARIA_ATTR: true,
      ALLOW_DATA_ATTR: false,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
    })
    return {
      html: typeof clean === 'string' ? clean : String(clean),
      blockedRemote: collector.blocked,
      hasRemoteContent: collector.hasRemote,
    }
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute')
  }
}

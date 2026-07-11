/**
 * Inline-image `cid` ↔ objectURL rewriting for the composer (M2.7). The CANONICAL body form —
 * what `draft.body`, the local `drafts` row, and the outgoing/Drafts Email all store — is
 * `<img src="cid:<cid>">`. The LIVE editor instead shows `<img src="<objectURL>" data-cid="<cid>">`
 * so a just-added image previews without a server round-trip. The editor boundary converts between
 * them: {@link canonicalizeInlineImages} on getHTML, {@link resolveInlineImages} on setHTML. Pure
 * (DOMParser only), so it unit-tests without a browser.
 */

const CID_PREFIX = 'cid:'

/** getHTML output → canonical: rewrite `<img data-cid=c>` to `<img src="cid:c">`, dropping `data-cid`. */
export function canonicalizeInlineImages(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of Array.from(doc.body.querySelectorAll('img[data-cid]'))) {
    const cid = img.getAttribute('data-cid')
    img.removeAttribute('data-cid')
    if (cid !== null && cid !== '') img.setAttribute('src', `${CID_PREFIX}${cid}`)
  }
  return doc.body.innerHTML
}

/**
 * setHTML input → display: rewrite `<img src="cid:c">` to `<img src=resolve(c) data-cid=c>`. An
 * image whose `resolve` returns `null` (e.g. after a reload, before preview-restore lands) is
 * dropped from the editor view — the canonical `cid:` reference still serializes and sends.
 */
export function resolveInlineImages(html: string, resolve: (cid: string) => string | null): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith(CID_PREFIX)) continue
    const cid = src.slice(CID_PREFIX.length)
    const url = resolve(cid)
    if (url === null) {
      img.remove()
      continue
    }
    img.setAttribute('src', url)
    img.setAttribute('data-cid', cid)
  }
  return doc.body.innerHTML
}

/** Remove the `<img src="cid:cid">` for one inline image from `html` (a cancelled/removed upload). */
export function removeInlineImage(html: string, cid: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    if (img.getAttribute('src') === `${CID_PREFIX}${cid}`) img.remove()
  }
  return doc.body.innerHTML
}

/** The cids referenced by `<img src="cid:...">` in `html` — used to prune orphaned inline attachments. */
export function referencedCids(html: string): Set<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const cids = new Set<string>()
  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (src.startsWith(CID_PREFIX)) {
      const cid = src.slice(CID_PREFIX.length)
      if (cid !== '') cids.add(cid)
    }
  }
  return cids
}

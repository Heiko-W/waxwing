/**
 * Module-scoped `cid → objectURL` registry for inline-image previews (M2.7). It lives at module
 * scope (not React state) so a pasted screenshot's preview survives a ComposerWindow remount —
 * minimize→restore, phone draft-switch, route change — without a server round-trip. Only a full
 * page RELOAD clears it; restoring previews after a reload (via an authenticated blob download)
 * is the deferred follow-up. `resolveInlineImage` reads this; the upload hook writes it.
 */

const registry = new Map<string, string>()

/** Record the local objectURL that previews the inline image with content-id `cid`. */
export function putInlineObjectUrl(cid: string, url: string): void {
  registry.set(cid, url)
}

/** The preview objectURL for `cid`, or `null` if none is live (e.g. after a reload). */
export function getInlineObjectUrl(cid: string): string | null {
  return registry.get(cid) ?? null
}

/** Revoke + forget one inline preview (upload cancelled, or its draft discarded). */
export function revokeInlineObjectUrl(cid: string): void {
  const url = registry.get(cid)
  if (url !== undefined) {
    URL.revokeObjectURL(url)
    registry.delete(cid)
  }
}

/** Revoke + forget several inline previews (a draft's whole set on discard). */
export function revokeInlineObjectUrls(cids: Iterable<string>): void {
  for (const cid of cids) revokeInlineObjectUrl(cid)
}

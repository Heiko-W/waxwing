/**
 * What may be shown inline, and in which surface (M5.17).
 *
 * Two screens download bytes nobody has vetted and put them in front of the user: the reader's
 * attachment strip (M1.8) and the file browser (M5.7). What they agree to show is a security
 * decision, not a display preference, so it lives here once — and can be tested without rendering
 * anything.
 *
 * **The surface is the point.** An `<img>` is not a smaller `<iframe>`: an SVG loaded through
 * `<img src>` runs in the SVG spec's *secure static mode*, where scripts do not execute and
 * external references are not fetched. The same file in a frame would be an ordinary document.
 * Everything else goes into `<iframe sandbox="">` — no scripts, no forms, no same-origin — which
 * matters because a `blob:` URL carries this app's origin, and `sandbox=""` is what takes it away
 * again. `frame-src 'self' blob:` in `index.html` exists for exactly this frame.
 *
 * **The type is a claim, not a fact.** For an attachment it is what the sender wrote; for a file
 * it is what whoever uploaded it wrote. Nothing here reads the bytes. That is survivable only
 * because both surfaces are inert for every type on the list: being lied to changes what the user
 * sees, not what runs.
 */

/** Where a previewable type is allowed to be rendered. */
export type PreviewSurface = 'image' | 'frame'

/**
 * Media types allowed into `<iframe sandbox="">`.
 *
 * A short list rather than a family: `text/*` would admit `text/html`, and an HTML document is the
 * one thing this must not hand to a frame — sandboxed or not, it is the whole attack surface the
 * mail body frame exists to contain, and it would arrive here without the sanitizer.
 *
 * **PDF IS NOT ON THIS LIST, AND THAT IS A DECISION, NOT AN OMISSION.**
 *
 * It was, and it never worked: the frame opened, `aria-expanded` said "true", and the box stayed
 * empty — Chromium drew its "cannot display" sheet, Firefox nothing. Measured in the same browser
 * on the same page under the same CSP: the identical PDF in an `<iframe>` WITHOUT `sandbox` renders
 * perfectly, in `<iframe sandbox="">` it does not, and `text/plain` in `<iframe sandbox="">` does.
 * The CSP is not involved (`frame-src 'self' blob:` allows the frame either way). So the offer was
 * a button that promised a preview and delivered a blank rectangle.
 *
 * There are exactly three ways to make a PDF appear, and each was weighed:
 *
 * 1. **Relax the sandbox.** Chromium's viewer is not a renderer we can address; it is an internal
 *    HTML document with a plugin in it, and it needs script execution AND a same-origin-ish
 *    context. `sandbox="allow-scripts"` alone still fails. `sandbox="allow-scripts
 *    allow-same-origin"` works — and for a `blob:` URL it is not a relaxation, it is a removal:
 *    a blob URL inherits THIS app's origin, so the framed document would be same-origin with the
 *    app, able to reach `window.parent`, read the IndexedDB that holds the wrapped credentials,
 *    call the JMAP API with the user's session, and — because the two tokens together let a frame
 *    edit its own `sandbox` attribute — take the rest for itself. The bytes come from whoever sent
 *    the mail or uploaded the file. That is the single most dangerous pair of tokens in the whole
 *    attribute, and it would be granted to exactly the content that has earned the least trust.
 * 2. **`<object>`/`<embed>`.** The sandbox attribute does not exist on either, so this would
 *    silently drop the containment rather than narrow it — and it is blocked outright by
 *    `object-src 'none'` in `index.html`, which `csp.shipped.test.ts` pins.
 * 3. **Render it ourselves** (pdf.js or similar) inside a surface we control. This is the only way
 *    to have both, and it is a feature with a dependency, a lazy chunk and a size budget behind it
 *    — not a line in this file. If a PDF preview comes back, it comes back this way.
 *
 * Until then the honest offer is the one that works: no Preview button for a PDF, and the Download
 * button that sits beside it in both surfaces already opens it in the reader's own viewer, at full
 * size, outside this app entirely. A missing button is a smaller loss than a button that lies, and
 * far smaller than a sandbox opened for the one content type nobody has vetted.
 */
const FRAMEABLE: ReadonlySet<string> = new Set(['text/plain'])

/**
 * The media type without its parameters, lowercased.
 *
 * JMAP's `EmailBodyPart.type` carries the type alone, but a `FileNode` type comes from whatever
 * uploaded the file and may well read `text/plain; charset=utf-8`. Comparing that against a bare
 * type silently fails closed, which looks like "preview is broken for text files".
 */
function mediaType(raw: string | null | undefined): string {
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** Where this type may be previewed, or `null` if it may not be. */
export function previewSurface(type: string | null | undefined): PreviewSurface | null {
  const media = mediaType(type)
  if (media.startsWith('image/')) return 'image'
  return FRAMEABLE.has(media) ? 'frame' : null
}

/** Whether an inline preview is offered at all. */
export function isPreviewable(type: string | null | undefined): boolean {
  return previewSurface(type) !== null
}

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
 */
const FRAMEABLE: ReadonlySet<string> = new Set(['application/pdf', 'text/plain'])

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

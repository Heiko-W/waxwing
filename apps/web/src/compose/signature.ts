/**
 * Per-identity signature handling (M2.5, FR-CMP-06). Pure, DOMParser-driven functions that seed and
 * swap a signature in the draft body. The signature lives in a marked container
 * (`[data-waxwing-signature]`) so switching the From identity replaces exactly that node without
 * touching the user's typed text or the quoted original. The plain-text alternative comes free from
 * {@link htmlToPlainText} at send/plain-mode time (it walks the marked signature like any block).
 */

import type { Identity } from '@waxwing/jmap'
import { plainTextToHtml } from './html-to-text'

/** Boolean attribute marking the signature container so a swap finds + replaces exactly it. */
export const SIGNATURE_ATTR = 'data-waxwing-signature'

export type SignaturePlacement = 'aboveQuote' | 'belowQuote'

/** The signature HTML for an identity: `htmlSignature`, else `textSignature`→HTML, else `''`. */
export function signatureHtmlForIdentity(
  identity: Pick<Identity, 'htmlSignature' | 'textSignature'>,
): string {
  if (identity.htmlSignature.trim() !== '') return identity.htmlSignature
  if (identity.textSignature.trim() !== '') return plainTextToHtml(identity.textSignature)
  return ''
}

/** Resolve the default From identity from the M2.3 email hint (case-insensitive), else the first. */
export function pickDefaultIdentity<T extends Pick<Identity, 'email'>>(
  identities: readonly T[],
  hintEmail?: string,
): T | undefined {
  if (hintEmail !== undefined) {
    const hit = identities.find(
      (identity) => identity.email.toLowerCase() === hintEmail.toLowerCase(),
    )
    if (hit) return hit
  }
  return identities[0]
}

/** A leading empty block (the `<p><br></p>` cursor slot from quoteBody/forwardBody). */
function isEmptyBlock(element: Element | null): boolean {
  return (
    element !== null &&
    (element.tagName === 'P' || element.tagName === 'DIV') &&
    (element.textContent ?? '').trim() === ''
  )
}

/**
 * INITIAL insertion of `signatureHtml` (wrapped in the marker div) above the quote. No-op for an
 * empty signature. If the body opens with the empty cursor-slot block, the signature goes just
 * after it (so the caret stays at the top); otherwise it goes at the very top.
 */
export function applySignature(
  bodyHtml: string,
  signatureHtml: string,
  placement: SignaturePlacement = 'aboveQuote',
): string {
  if (signatureHtml.trim() === '') return bodyHtml
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  if (doc.body.childNodes.length === 0) {
    const slot = doc.createElement('p')
    slot.appendChild(doc.createElement('br'))
    doc.body.appendChild(slot)
  }
  const sig = doc.createElement('div')
  sig.setAttribute(SIGNATURE_ATTR, '')
  sig.innerHTML = signatureHtml

  if (placement === 'belowQuote') {
    doc.body.appendChild(sig)
    return doc.body.innerHTML
  }
  const first = doc.body.firstElementChild
  if (isEmptyBlock(first) && first !== null) first.after(sig)
  else if (first !== null) first.before(sig)
  else doc.body.appendChild(sig)
  return doc.body.innerHTML
}

/**
 * SWAP the existing signature's contents for `newSignatureHtml` (empty → remove the container).
 * NO-OP when no signature marker is present — respects an explicit deletion by the user.
 */
export function replaceSignature(bodyHtml: string, newSignatureHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const existing = doc.body.querySelector(`[${SIGNATURE_ATTR}]`)
  if (existing === null) return bodyHtml
  if (newSignatureHtml.trim() === '') existing.remove()
  else existing.innerHTML = newSignatureHtml
  return doc.body.innerHTML
}

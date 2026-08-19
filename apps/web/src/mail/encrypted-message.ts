/**
 * Recognising signed and encrypted mail (M5.15, NFR-SEC-05 part).
 *
 * **This module performs no cryptography.** It reads MIME types and says what a message *is*, so
 * the reading pane can explain itself instead of showing an empty body or a base64 blob. Verifying
 * a signature or decrypting a body needs private key material and a key store, and that is a
 * separate, larger piece of work — deliberately not started here.
 *
 * **Why this matters more than it looks.** Stalwart can encrypt incoming mail at rest with the
 * user's own public key or S/MIME certificate. On such an account, EVERY message arrives
 * encrypted, and a client that cannot decrypt shows the reader a body that is either blank or
 * unintelligible — with no explanation. Saying "this message is encrypted and this client cannot
 * open it" turns a mystery into a fact the reader can act on.
 */

/** What a message's structure says about it. */
export type MessageProtection =
  | { readonly kind: 'none' }
  | { readonly kind: 'signed'; readonly scheme: 'smime' | 'pgp' }
  | { readonly kind: 'encrypted'; readonly scheme: 'smime' | 'pgp' }

const NONE: MessageProtection = { kind: 'none' }

/** The part shape this reads — a subset of `EmailBodyPart`. */
export interface ProtectionPart {
  readonly type: string
  /** For a `multipart/*`, the parts inside it. */
  readonly subParts?: readonly ProtectionPart[] | null
  /** `application/pkcs7-mime` carries the intent here. */
  readonly smimeType?: string | null
}

function normalise(type: string | null | undefined): string {
  return (type ?? '').trim().toLowerCase()
}

/**
 * What protection this message structure carries.
 *
 * Only the OUTERMOST layer is reported: a signed message containing an encrypted one is described
 * as signed, which is what its structure says. Reporting the inner layer would claim knowledge of
 * something this module has not opened.
 */
export function detectProtection(part: ProtectionPart | null | undefined): MessageProtection {
  if (part === null || part === undefined) return NONE
  const type = normalise(part.type)

  // RFC 8551 §3.9 / RFC 3156 §5 — the signature travels beside the content.
  if (type === 'multipart/signed') {
    const signature = (part.subParts ?? []).map((sub) => normalise(sub.type))
    if (signature.some((sub) => sub.includes('pgp-signature'))) {
      return { kind: 'signed', scheme: 'pgp' }
    }
    // `application/pkcs7-signature`, and the older `x-pkcs7-signature` some senders still emit.
    if (signature.some((sub) => sub.includes('pkcs7-signature'))) {
      return { kind: 'signed', scheme: 'smime' }
    }
    // A `multipart/signed` whose signature part is unrecognised is still signed by something.
    return { kind: 'signed', scheme: 'smime' }
  }

  // RFC 3156 §4 — PGP/MIME.
  if (type === 'multipart/encrypted') return { kind: 'encrypted', scheme: 'pgp' }

  // RFC 8551 §3.2 — the single-part S/MIME form. `smime-type` distinguishes the two uses; without
  // it, `enveloped-data` is the overwhelmingly common case and the safer assumption, because
  // calling an encrypted message "signed" would tell the reader it is readable when it is not.
  if (type === 'application/pkcs7-mime' || type === 'application/x-pkcs7-mime') {
    const smimeType = normalise(part.smimeType)
    if (smimeType === 'signed-data') return { kind: 'signed', scheme: 'smime' }
    return { kind: 'encrypted', scheme: 'smime' }
  }

  // Inline PGP in a text body is NOT detected here: it needs the body text, not the structure,
  // and a false positive on a message merely *discussing* PGP would be worse than a miss.
  return NONE
}

/** Whether this client can render the body at all. */
export function isReadable(protection: MessageProtection): boolean {
  return protection.kind !== 'encrypted'
}

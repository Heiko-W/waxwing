/**
 * base64url ⇄ bytes for Web Push (M4.0, RFC 8291/8292) — pure, and worth its own file because both
 * directions are easy to get subtly wrong and impossible to notice afterwards.
 *
 * The wrongness is silent in both directions. A mis-decoded `applicationServerKey` makes
 * `subscribe()` reject with `InvalidAccessError` — visible, at least. A mis-ENCODED `p256dh` is
 * accepted by everyone: the server stores it, encrypts against it, the push service delivers, and the
 * browser then fails to decrypt and fires no `push` event at all. Nothing anywhere reports an error;
 * notifications simply never arrive. (Stalwart does validate the point — our own probe was rejected
 * with `"Invalid P-256 ECDH public key"` for a made-up key — but validation only proves it is *a*
 * key, not that it is OURS.)
 *
 * Everything here is unpadded base64url, which is what every browser emits and what RFC 9749 uses
 * for `applicationServerKey`. Stalwart v0.16.14 accepts padded and unpadded alike
 * (`DecodePaddingMode::Indifferent`, one of the three fixes it shipped for us); we send unpadded
 * because that is what the spec asks for and what a stricter server would require.
 */

/**
 * Decode unpadded (or padded) base64url into bytes.
 *
 * Throws on anything that is not base64 at all — a caller handing this a truncated key wants to know,
 * because the alternative is a subscription created against a key that decodes to the wrong point.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  // `atob` speaks base64, not base64url, and requires the padding browsers omit.
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encode bytes as unpadded base64url — the form `PushSubscription/set` takes. */
export function bytesToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // Chunked rather than `String.fromCharCode(...bytes)`: spreading a large array blows the argument
  // limit. These payloads are 65 and 16 bytes today, but a helper that fails on size is a trap.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

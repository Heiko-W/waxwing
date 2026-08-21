/**
 * Contact photo preparation (M4.2, stage 5b; corrected 2026-08 for the JMAP gap analysis, B-1).
 *
 * A picked file is downscaled to a sane maximum edge and then encoded as a `data:` URI that goes
 * INTO the card as `media[key].uri` (RFC 9553 §2.7.x).
 *
 * **Why not a blob.** The predecessor uploaded the bytes to the JMAP blob endpoint and wrote
 * `media[key].blobId` (RFC 9610 §1.6.3 permits that). Stalwart does not:
 *
 * ```
 * ContactCard/set → notCreated: { "type": "invalidProperties",
 *   "description": "blobIds in media is not supported.", "properties": ["media"] }
 * ```
 *
 * measured against a live v0.16.18 (`docs/jmap-gap-2026-08-21/berichte/D-sharing-pim.md` §3.3); the
 * same call with a `data:` URI is accepted, stored and handed back unchanged. So the WRITE path is
 * inline-only. The READ path stays dual — {@link ./use-contact-photo} still resolves a `blobId` a
 * server or another client put there, because RFC 9610 allows it and this client must not go blind
 * to a photo it did not write.
 *
 * **The photo now travels inside the card**, which is what sets the two limits below. It is fetched
 * with every `ContactCard/get` and kept in the replica, so it is scaled to {@link PHOTO_MAX_EDGE} —
 * enough for the 5rem avatar at 3× — and refused above {@link PHOTO_MAX_BYTES}, rather than letting
 * a 4 MB camera shot turn one address-book entry into a 5.5 MB base64 string.
 *
 * The scaler is injectable so the form's tests drive it with a pass-through — jsdom has neither a
 * real canvas nor `createImageBitmap`. The default scaler is defensive: on ANY failure (unsupported
 * type, no canvas, jsdom) it returns the original file, and the byte ceiling is then the backstop.
 */

/**
 * Longest edge (px) a contact photo is scaled down to.
 *
 * 256, not the 512 of the blob era: the photo is now part of the card, and the largest place it is
 * ever painted is the 5rem (80px) detail avatar — 256 covers that at 3× device pixels with room to
 * spare, at a quarter of the bytes 512 would cost.
 */
export const PHOTO_MAX_EDGE = 256

/**
 * Largest photo (bytes, BEFORE base64) that may be written into a card. Base64 adds ~33%, so this
 * is ~85 KB of `uri` — a card that is still cheap to sync and to hold. A 256px JPEG lands far below
 * it; the ceiling exists for the case where scaling was impossible (an unsupported/undecodable
 * type, or a browser without `createImageBitmap`) and the original would go in as-is.
 */
export const PHOTO_MAX_BYTES = 64 * 1024

/** A prepared photo ready to be written: its bytes and the media type they were (re-)encoded as. */
export interface PreparedPhoto {
  readonly blob: Blob
  readonly mediaType: string
}

/** The photo as it is stored in the card: an inline `data:` URI plus its media type. */
export interface PhotoDataUri {
  readonly uri: string
  readonly mediaType: string
}

/** Turns a picked file into the bytes to store (downscaled when it helps). */
export type PhotoScaler = (file: File) => Promise<PreparedPhoto>

/** Thrown by {@link preparePhotoUri} when even the scaled photo is too large to put in a card. */
export class PhotoTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`photo is ${bytes} bytes, over the ${PHOTO_MAX_BYTES} byte card limit`)
    this.name = 'PhotoTooLargeError'
  }
}

function fallbackType(file: File): string {
  return file.type !== '' ? file.type : 'application/octet-stream'
}

async function encodeBitmap(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob !== null ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      0.82,
    )
  })
}

/**
 * Downscale `file` so its longest edge is at most `maxEdge`px, re-encoding as JPEG. An image that is
 * already small enough IN BOTH DIMENSIONS AND BYTES is returned unchanged; one that is small enough
 * on screen but heavy on the wire (a 200px lossless PNG of 300 KB) is still re-encoded, because
 * the bytes are the constraint now that the photo rides inside the card.
 *
 * Any failure to decode/encode returns the original, so a photo is never lost to an over-eager
 * optimisation — {@link preparePhotoUri}'s byte ceiling is what stops an oversized one.
 */
export async function scalePhoto(
  file: File,
  maxEdge: number = PHOTO_MAX_EDGE,
  maxBytes: number = PHOTO_MAX_BYTES,
): Promise<PreparedPhoto> {
  if (typeof createImageBitmap !== 'function') return { blob: file, mediaType: fallbackType(file) }
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= maxEdge && file.size <= maxBytes) {
      bitmap.close()
      return { blob: file, mediaType: fallbackType(file) }
    }
    const scale = Math.min(1, maxEdge / longest)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const blob = await encodeBitmap(bitmap, width, height)
    bitmap.close()
    return { blob, mediaType: 'image/jpeg' }
  } catch {
    return { blob: file, mediaType: fallbackType(file) }
  }
}

/**
 * Base64-encode `blob` into a `data:` URI carrying `mediaType`.
 *
 * The type is taken from the caller, not from whatever `FileReader` inferred from the blob: a blob
 * with no type of its own reads back as `data:base64,…` — a URI with no media type, which is not
 * what we want to hand the server. So only the payload is kept and the prefix is rebuilt.
 */
export function blobToDataUri(blob: Blob, mediaType: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read the photo'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('could not read the photo'))
        return
      }
      const payload = result.slice(result.indexOf(',') + 1)
      resolve(`data:${mediaType};base64,${payload}`)
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * The whole write-side preparation: scale, then encode inline. REJECTS with
 * {@link PhotoTooLargeError} when the result would not fit in a card — the one failure the form
 * tells the user about in its own words, rather than as "the photo could not be read".
 */
export async function preparePhotoUri(
  file: File,
  scale: PhotoScaler = scalePhoto,
  maxBytes: number = PHOTO_MAX_BYTES,
): Promise<PhotoDataUri> {
  const prepared = await scale(file)
  if (prepared.blob.size > maxBytes) throw new PhotoTooLargeError(prepared.blob.size)
  return {
    uri: await blobToDataUri(prepared.blob, prepared.mediaType),
    mediaType: prepared.mediaType,
  }
}

/**
 * Contact photo preparation + upload (M4.2, stage 5b). A picked file is optionally downscaled to a
 * sane maximum edge (a phone camera shot is multiple megapixels — a contact avatar renders at ~80px,
 * so uploading the original would bloat the blob store for nothing) and then POSTed to the JMAP blob
 * endpoint via {@link uploadBlob}. The resulting `blobId` becomes a `ContactCardMedia` (`kind: 'photo'`)
 * in the card's `media` map (see {@link formToMedia}).
 *
 * Both steps are injectable so the form's tests drive them with a fake uploader and a pass-through
 * scaler — jsdom has neither a real canvas nor `createImageBitmap`. The default scaler is
 * defensive: on ANY failure (unsupported type, no canvas, jsdom) it returns the original file rather
 * than block the upload.
 */

/** Longest edge (px) a contact photo is scaled down to before upload. */
export const PHOTO_MAX_EDGE = 512

/** A prepared photo ready to upload: its bytes and the media type they were (re-)encoded as. */
export interface PreparedPhoto {
  readonly blob: Blob
  readonly mediaType: string
}

/** Uploads prepared photo bytes and returns the stored blob id + media type. */
export type PhotoUploader = (
  blob: Blob,
  mediaType: string,
) => Promise<{ readonly blobId: string; readonly mediaType: string }>

/** Turns a picked file into the bytes to upload (downscaled when it helps). */
export type PhotoScaler = (file: File) => Promise<PreparedPhoto>

function fallbackType(file: File): string {
  return file.type !== '' ? file.type : 'application/octet-stream'
}

async function encodeBitmap(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
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
      0.85,
    )
  })
}

/**
 * Downscale `file` so its longest edge is at most {@link PHOTO_MAX_EDGE}px, re-encoding as JPEG. An
 * already-small image (or any failure to decode/encode) is returned unchanged so a photo is never
 * lost to an over-eager optimisation.
 */
export async function scalePhoto(
  file: File,
  maxEdge: number = PHOTO_MAX_EDGE,
): Promise<PreparedPhoto> {
  if (typeof createImageBitmap !== 'function') return { blob: file, mediaType: fallbackType(file) }
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= maxEdge) {
      bitmap.close()
      return { blob: file, mediaType: fallbackType(file) }
    }
    const scale = maxEdge / longest
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const blob = await encodeBitmap(bitmap, width, height)
    bitmap.close()
    return { blob, mediaType: 'image/jpeg' }
  } catch {
    return { blob: file, mediaType: fallbackType(file) }
  }
}

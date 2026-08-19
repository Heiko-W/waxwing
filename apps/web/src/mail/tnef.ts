/**
 * Reading `winmail.dat` — TNEF attachment extraction (M5.21, MS-OXTNEF).
 *
 * Outlook, configured for "Rich Text" format, packs a message's real attachments into one opaque
 * `application/ms-tnef` part called `winmail.dat`. Every non-Outlook client shows the reader a file
 * they cannot open, and the actual invoice inside it is invisible. This unpacks it.
 *
 * **Scope: attachments only.** TNEF also carries the RTF body, MAPI property tables, recipient
 * tables and rendering metadata. None of that is decoded here — the body already arrives as the
 * message's own `text/plain` alternative in every case that matters, and a MAPI property decoder is
 * a large surface for no reader-visible gain.
 *
 * Recognising a container is in `tnef-detect.ts`, not here — a module that is both statically and
 * dynamically imported cannot be code-split, and the strip needs the predicate eagerly.
 *
 * **This parses hostile bytes, so it distrusts every one of them.** Lengths come from the file and
 * are checked against what remains before any read; a malformed stream ends the parse and returns
 * whatever was already complete, rather than throwing away a valid first attachment because the
 * third one is corrupt. Nothing here allocates a buffer sized by a number the file chose.
 */

/** `0x223E9F78`, little-endian, at offset 0. Nothing else is a TNEF stream. */
const TNEF_SIGNATURE = 0x223e9f78

/** Attribute ids, in the low 16 bits of the 4-byte attribute field (MS-OXTNEF §2.1.3). */
const ATT_ATTACH_DATA = 0x800f
const ATT_ATTACH_TITLE = 0x8010
const ATT_ATTACH_REND_DATA = 0x9002
const ATT_ATTACHMENT = 0x9005

/** Level byte: an attribute belongs to the message or to the attachment currently being built. */
const LVL_ATTACHMENT = 0x02

/**
 * The most bytes this will hand back from one container.
 *
 * A cap, not a spec limit: the decoded result goes into memory in the reading pane, and a crafted
 * stream should not be able to ask for an unbounded amount of it. 64 MB is well above Stalwart's
 * 50 MB attachment ceiling, so no real message reaches it.
 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** One file recovered from the container. */
export interface TnefAttachment {
  /**
   * Position in the container, and the only identity these have: one `winmail.dat` may hold two
   * files of the same name, and nothing downstream reorders them.
   */
  readonly id: number
  /** The filename TNEF recorded. Never empty — see `FALLBACK_NAME`. */
  readonly name: string
  readonly bytes: Uint8Array
}

/** Used when the container names a file with nothing usable. Not localized: it becomes a filename. */
const FALLBACK_NAME = 'attachment'

/**
 * A TNEF string, which is Latin-1 or UTF-16 and usually NUL-terminated.
 *
 * Decoded as Latin-1 rather than UTF-8: TNEF predates it, the code page lives in a MAPI property
 * this does not read, and mojibake in a filename is recoverable where a thrown decoder is not.
 * A UTF-16 name (every other byte zero) is detected and handled, because Outlook does emit those.
 */
function readString(bytes: Uint8Array): string {
  if (bytes.length === 0) return FALLBACK_NAME
  const looksUtf16 = bytes.length >= 4 && bytes.length % 2 === 0 && bytes[1] === 0 && bytes[3] === 0
  let text = ''
  if (looksUtf16) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = (bytes[index] ?? 0) | ((bytes[index + 1] ?? 0) << 8)
      if (code === 0) break
      text += String.fromCharCode(code)
    }
  } else {
    for (const byte of bytes) {
      if (byte === 0) break
      text += String.fromCharCode(byte)
    }
  }
  const trimmed = text.trim()
  return trimmed === '' ? FALLBACK_NAME : trimmed
}

/** Whether these bytes begin with the TNEF signature. Cheap enough to call before decoding. */
export function looksLikeTnef(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(0, true) === TNEF_SIGNATURE
}

/**
 * The files inside a `winmail.dat`.
 *
 * Returns an empty array for anything that is not a TNEF stream, and for a stream that contains no
 * attachments — the caller shows the container itself in both cases, which is what it did before
 * this existed.
 */
export function extractTnefAttachments(bytes: Uint8Array): TnefAttachment[] {
  if (!looksLikeTnef(bytes)) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const found: TnefAttachment[] = []
  let total = 0
  // The attachment being assembled: TNEF streams its name and its data as separate attributes, in
  // an order that is conventional rather than guaranteed.
  let name: string | null = null
  let data: Uint8Array | null = null

  const flush = (): void => {
    if (data === null) return
    found.push({ id: found.length, name: name ?? FALLBACK_NAME, bytes: data })
    name = null
    data = null
  }

  // 4 bytes signature + 2 bytes key.
  let offset = 6
  while (offset + 9 <= bytes.length) {
    const level = bytes[offset]
    const attribute = view.getUint32(offset + 1, true)
    const length = view.getUint32(offset + 5, true)
    const dataStart = offset + 9

    // Every length is the file's claim. Refusing here is what keeps a truncated or crafted stream
    // from reading past the end — and `+ 2` accounts for the trailing checksum.
    if (length > bytes.length - dataStart) break
    if (dataStart + length + 2 > bytes.length) break

    const id = attribute & 0xffff
    if (level === LVL_ATTACHMENT) {
      switch (id) {
        case ATT_ATTACH_REND_DATA:
          // Starts a new attachment. Whatever was half-built before it is complete.
          flush()
          break
        case ATT_ATTACH_TITLE:
          name = readString(bytes.subarray(dataStart, dataStart + length))
          break
        case ATT_ATTACH_DATA: {
          total += length
          // Stop rather than truncate: half a file handed over as if whole is worse than none.
          if (total > MAX_TOTAL_BYTES) return found
          // `slice`, not `subarray`: the result outlives this buffer and must not pin it.
          data = bytes.slice(dataStart, dataStart + length)
          break
        }
        case ATT_ATTACHMENT:
          // The MAPI property table. Deliberately not decoded — see the module note.
          break
        default:
          break
      }
    }

    offset = dataStart + length + 2
  }
  flush()
  return found
}

/**
 * Bundling a message's attachments into one `.zip` (M5.3).
 *
 * A lazy module on purpose: `client-zip` is small but nobody pays for it until they actually ask
 * for a bundle. It is named in `.size-limit.js` as a lazy chunk, so it stays out of the initial JS
 * budget.
 *
 * **STORE, no compression.** `client-zip` writes entries uncompressed, which is the right trade
 * here rather than a limitation: mail attachments are overwhelmingly PDFs, JPEGs and Office files,
 * all of which are already compressed. Deflating them again costs CPU on the reader's machine and
 * saves close to nothing.
 */

import { downloadZip } from 'client-zip'
import { safeFilenameStem } from './safe-filename'

/** One file to put in the archive. */
export interface ZipEntry {
  readonly name: string
  readonly blob: Blob
}

/** Fallback stem when the message has no usable subject. */
const FALLBACK_STEM = 'attachments'

/**
 * The archive's filename, derived from the message subject.
 *
 * Through `safeFilenameStem` for the same reason a single attachment download is: the subject is
 * the sender's string, and this becomes a name on the reader's filesystem.
 */
export function zipFilename(subject: string | null | undefined): string {
  // `safeFilenameStem` strips rather than substitutes, so an empty or hostile subject can leave
  // nothing at all — hence the explicit fallback instead of a second argument (that one is a
  // length cap).
  const stem = safeFilenameStem(subject ?? '')
  return `${stem === '' ? FALLBACK_STEM : stem}.zip`
}

/**
 * Makes every entry name unique within the archive.
 *
 * Two attachments called `invoice.pdf` are entirely ordinary in one message, and a zip with two
 * identical entry names is a file that extracts to one attachment on some tools and errors on
 * others — either way the reader silently loses a file.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count === 0) return name

    const dot = name.lastIndexOf('.')
    // A leading dot is the whole name (`.gitignore`), not an extension.
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`
  })
}

/** Builds the archive. Entry names are made unique first. */
export async function buildZip(entries: readonly ZipEntry[]): Promise<Blob> {
  const names = uniqueNames(entries.map((entry) => entry.name))
  const files = entries.map((entry, index) => ({
    name: names[index] as string,
    input: entry.blob,
    // A fixed date rather than "now": the archive should be a function of its contents, so the same
    // attachments produce the same bytes twice. `client-zip` requires *a* date.
    lastModified: new Date(0),
  }))
  return await downloadZip(files).blob()
}

/**
 * Filenames the SENDER chose, made safe for the two places this app puts them: an `<a download>`
 * attribute and a visible label. Shared by the `.eml` save (`use-message-source.ts`) and the
 * attachment strip (`AttachmentList.tsx`), which had the same attack and only one of the defences.
 *
 * ## The attack, and its actual size
 * `Invoice<U+202E>gpj.exe` renders as `Invoiceexe.jpg`: U+202E reverses everything after it, so the
 * visible extension is a lie. `<U+200B>.bashrc` slips a dot past a naive leading-dot strip;
 * `../../pwned.txt` tries to climb out of the download directory.
 *
 * The DOWNLOAD half is, measured, already neutralised by the browsers themselves — verified with
 * Playwright in Chromium and WebKit, `download.suggestedFilename()` returns `Invoice_gpj.exe`,
 * `_.bashrc` and `_.._pwned.txt`/`pwned.txt` for those three. That is a mitigation this app neither
 * controls nor can rely on across engines, so it is duplicated here, but it must not be described as
 * the thing that closes the hole.
 *
 * What is genuinely ours is the LABEL. Waxwing renders the sender's filename in the strip and in
 * every `aria-label` around it, next to an icon derived from the sender-DECLARED MIME type — so
 * without {@link displayFilename} the app itself, not the OS, is what tells the reader that the
 * attachment is a JPEG. Two measures answer that: the bidi/zero-width characters are stripped from
 * the text, and the caller wraps what is left in `<bdi>` so a genuinely right-to-left filename still
 * cannot reorder the UI around it.
 *
 * ## What this does NOT do
 * It does not make the file safe to open, and it cannot: the bytes and the declared type are still
 * whatever arrived. It does not defend the `title=` tooltip against being long, or a name against
 * being confusable in the U+0430-for-`a` sense — homoglyphs are left alone, because stripping them
 * would mangle every legitimate non-Latin filename.
 */

/** Longest filename kept. The POSIX/NTFS ceiling; past it the name is not a name but a payload. */
export const MAX_FILENAME_LENGTH = 255

/** C0/C1 controls and DEL — also what a header-injection attempt is built from. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g

/**
 * Bidi overrides/embeddings/isolates, zero-width joiners/spaces, and the BOM — every character that
 * changes what a name LOOKS like without changing what it IS. This set is what makes a stripped name
 * and a rendered name the same string.
 */
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * A sender-supplied name reduced to something safe to WRITE: the invisible characters above, plus
 *
 * - the Windows-reserved set (`/ \ : * ? " < > |`), which is also what a path-traversal attempt is
 *   spelt with;
 * - every `..` sequence AND any leading dot, so nothing can climb a directory or land hidden;
 * - trailing dots/whitespace, which Windows silently strips (turning `a .eml` into `a`);
 * - a lone trailing surrogate left by the length clamp, which is not well-formed text.
 *
 * A Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…) is deliberately left alone: those are
 * reserved only as a *bare* name, and every caller here either appends an extension or is handing
 * the result to a browser that sanitizes again.
 *
 * Returns `''` when nothing survives — the callers decide what to put there, because `message.eml`
 * and `attachment` are different fallbacks.
 */
export function safeFilenameStem(raw: string, maxLength: number = MAX_FILENAME_LENGTH): string {
  return (
    raw
      .replace(CONTROL_CHARACTERS, '')
      .replace(INVISIBLE_CHARACTERS, '')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\.{2,}/g, '')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, maxLength)
      // The clamp can cut a surrogate pair in half; a lone high surrogate is not well-formed text.
      .replace(/[\uD800-\uDBFF]$/, '')
      .replace(/[.\s]+$/, '')
  )
}

/**
 * The value for an `<a download>`: {@link safeFilenameStem}, or `fallback` when nothing survives.
 * Note what is NOT clamped away — the extension. The whole name is capped at
 * {@link MAX_FILENAME_LENGTH} rather than at some tighter budget precisely so that a normal
 * `Presentation for the Q3 review.pptx` keeps the suffix that decides which application opens it.
 */
export function safeDownloadName(name: string | null, fallback: string): string {
  const stem = safeFilenameStem(name ?? '')
  return stem === '' ? fallback : stem
}

/**
 * The name as it may be SHOWN. Only the characters that lie about the text are removed — the
 * separators and dots a download name cannot keep are harmless in a label, and removing them would
 * misreport what actually arrived. Clamped to {@link MAX_FILENAME_LENGTH} so a pathological name
 * cannot become the whole accessible name of a control.
 *
 * The label still has to be isolated where it is rendered (`<bdi>`): this strips the characters that
 * REVERSE the name, not the strongly-RTL letters that can reorder the punctuation around it.
 */
export function displayFilename(name: string): string {
  return name
    .replace(CONTROL_CHARACTERS, '')
    .replace(INVISIBLE_CHARACTERS, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, '')
}

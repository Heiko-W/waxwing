/**
 * The real {@link EditorEngine} backed by Squire (M2.1). This module is reached ONLY through
 * {@link defaultEditorFactory}'s dynamic `import()`, so squire-rte and DOMPurify land in a lazy
 * chunk, never the entry bundle.
 *
 * Two things Squire needs that its defaults get wrong for a bundled app:
 *  - `sanitizeToDOMFragment`: Squire's default calls a BARE GLOBAL `DOMPurify`, which does not exist
 *    in a bundled build (setHTML/insertHTML/paste would throw). We pass our own, using the DOMPurify
 *    we import here. It is intentionally PERMISSIVE (unlike @waxwing/mail-html's reading-side
 *    lockdown): keep formatting tags, inline styles and images; DOMPurify still drops `<script>`,
 *    `on*` handlers and `javascript:` URLs by default, which is the boundary that matters for input.
 *  - `getHTML()` output carries editor-only classes + bookmarks → run it through {@link cleanOutgoingHtml}.
 */

import DOMPurify from 'dompurify'
import Squire from 'squire-rte'
import { cleanOutgoingHtml } from './clean-html'
import type { EditorEngine } from './editor-engine'
import { htmlToPlainText } from './html-to-text'

// An ISOLATED DOMPurify instance for the composer editor only. Created via the `DOMPurify(window)`
// factory so the permissive hook below lives on THIS instance's `hooks[]` — never on the shared
// default singleton that @waxwing/mail-html uses to sanitize untrusted incoming mail. (A hook added
// to the default singleton would leak across: mail-html's per-call `removeHook()` only pops the last
// hook, so a globally-registered composer hook would survive and weaken the reading-side sanitizer.)
const purify = DOMPurify(window)

// Permit our own inline-image preview object URLs (`blob:`) as an `<img src>` (M2.7). DOMPurify
// otherwise strips `blob:` as an unknown protocol, which would blank a pasted screenshot's preview
// every time the editor re-seeds via setHTML (minimize→restore, From-identity change). Safe and
// narrow: only `blob:` on an `<img>`, and it applies to the composer instance alone. `javascript:`
// etc. stay blocked.
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'src' && node.nodeName === 'IMG' && data.attrValue.startsWith('blob:')) {
    data.forceKeepAttr = true
  }
})

function sanitizeToDOMFragment(html: string): DocumentFragment {
  return purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    // `target` (links) + `data-cid` (M2.7 inline-image marker). `data-*` survive DOMPurify by
    // default, but naming it is explicit; inline `<img src="blob:…">` previews are inserted via
    // Squire.insertImage (DOM node, not this HTML-string path), so the blob: URL is never sanitized.
    ADD_ATTR: ['target', 'data-cid'],
  }) as unknown as DocumentFragment
}

/** Wrap a fresh Squire instance as the narrow {@link EditorEngine} (keeps Squire fully encapsulated). */
export function createSquireEngine(root: HTMLElement): EditorEngine {
  const squire = new Squire(root, {
    sanitizeToDOMFragment: (html: string) => sanitizeToDOMFragment(html),
    toPlainText: (html: string) => htmlToPlainText(html),
  })
  return {
    getHTML: () => cleanOutgoingHtml(squire.getHTML()),
    setHTML: (html) => {
      squire.setHTML(html)
    },
    focus: () => {
      squire.focus()
    },
    destroy: () => {
      squire.destroy()
    },
    bold: () => {
      squire.bold()
    },
    removeBold: () => {
      squire.removeBold()
    },
    italic: () => {
      squire.italic()
    },
    removeItalic: () => {
      squire.removeItalic()
    },
    underline: () => {
      squire.underline()
    },
    removeUnderline: () => {
      squire.removeUnderline()
    },
    makeUnorderedList: () => {
      squire.makeUnorderedList()
    },
    makeOrderedList: () => {
      squire.makeOrderedList()
    },
    removeList: () => {
      squire.removeList()
    },
    increaseQuoteLevel: () => {
      squire.increaseQuoteLevel()
    },
    decreaseQuoteLevel: () => {
      squire.decreaseQuoteLevel()
    },
    makeLink: (url) => {
      squire.makeLink(url)
    },
    removeLink: () => {
      squire.removeLink()
    },
    insertImage: (src, attributes) => {
      squire.insertImage(src, attributes ?? {})
    },
    setFontSize: (size) => {
      squire.setFontSize(size)
    },
    hasFormat: (tag) => squire.hasFormat(tag),
    getPath: () => squire.getPath(),
    addEventListener: (type, handler) => {
      squire.addEventListener(type, handler)
    },
    removeEventListener: (type, handler) => {
      squire.removeEventListener(type, handler)
    },
  }
}

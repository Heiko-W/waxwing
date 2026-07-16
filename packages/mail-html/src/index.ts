/**
 * `@waxwing/mail-html` — HTML-mail sanitizer pipeline + sandboxed iframe renderer (AGPL-3.0, M1.7).
 *
 * The security boundary for rendering untrusted mail (NFR-SEC-01, tech-stack §4.5): a DOMPurify
 * pipeline that strips scripts, blocks remote content by default (FR-RD-02) and resolves `cid:`
 * inline parts, plus a script-free sandboxed-iframe renderer and a safe plain-text renderer.
 */

export { escapeHtml } from './escape'
export {
  buildFrameDocument,
  type FrameOptions,
  type MailFrameCallbacks,
  type MailFrameController,
  type MailLinkInfo,
  mountMailFrame,
} from './frame'
export { classifyLink, displayHost, type LinkVerdict } from './link-host'
export {
  type BlockedResource,
  type SanitizeOptions,
  type SanitizeResult,
  sanitize,
} from './sanitize'
export { type PlainTextOptions, renderPlainText } from './text'

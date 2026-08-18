/**
 * Renders one already-sanitized message body inside the @waxwing/mail-html sandboxed iframe (M1.8,
 * FR-RD-01). Given a body HTML string (sanitizer output, or renderPlainText output) it builds the
 * frame document with the matching `allowRemote` and mounts it (script-free `sandbox`, auto-height,
 * link interception). All isolation/CSP lives in the package; this is just the React lifecycle.
 */

import { buildFrameDocument, type MailLinkInfo, mountMailFrame } from '@waxwing/mail-html'
import { useEffect, useMemo, useRef } from 'react'
import styles from './reading.module.css'

/**
 * Does this body bring its own presentation?
 *
 * Two questions ride on the answer, and both are safe to get wrong in only one direction — so the
 * test is deliberately eager: any hint of authored styling and the frame falls back to the forced
 * black-on-white document it has always used.
 *
 *  - **Colour.** A message that sets `color:#eee` and no background is unreadable on anything but
 *    white, which is why the frame forces white for arbitrary mail. But a body with no colour of its
 *    own needs no such protection, and forcing it left a sheet of `#ffffff` inside a `#2c2c2e` card
 *    in the dark theme — the hardest edge in the whole UI.
 *  - **Width.** A designed HTML mail chose its own measure (typically 600 px); a plain-text message
 *    rendered here has none and ran to 87 characters a line on a desktop.
 *
 * `<table` and `width=` are in the list because they are what a designed mail is built from, not
 * because they carry colour: a newsletter laid out in tables must keep the width its author picked.
 * `class=` is deliberately NOT in it — `renderPlainText` stamps `class="waxwing-quote"` on collapsed
 * quotes, so including it would have excluded the very case this exists for.
 */
const AUTHORED = /(?:style\s*=|<table|width\s*=|bgcolor\s*=|<font)/i

/** Read a design token off the document, so the frame follows the live theme and any `theme.css`. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

export interface MailBodyFrameProps {
  /** Already-sanitized HTML (from `sanitize`) or safe HTML from `renderPlainText`. */
  readonly bodyHtml: string
  /** Must match the `allowRemote` used to sanitize, so the inner CSP agrees. */
  readonly allowRemote: boolean
  readonly title: string
  /**
   * An intercepted link click. `info.text` carries what the reader saw, so the app can check the
   * claim against the real host before opening (FR-RD-08 — `use-link-opener.ts`). Memoize it: it is
   * an effect dependency, and a new identity remounts the frame.
   */
  readonly onOpenLink: (href: string, info: MailLinkInfo) => void
}

export function MailBodyFrame({ bodyHtml, allowRemote, title, onOpenLink }: MailBodyFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const srcdoc = useMemo(() => {
    if (AUTHORED.test(bodyHtml)) return buildFrameDocument(bodyHtml, { allowRemote })
    return buildFrameDocument(bodyHtml, {
      allowRemote,
      palette: {
        background: token('--waxwing-surface', '#ffffff'),
        text: token('--waxwing-text', '#111111'),
        // Also the fix for a link colour that had been hardcoded to a superseded accent, so a
        // hoster's `accentColor` reached every link in the app except the ones inside a message.
        link: token('--waxwing-accent', '#2f6fe0'),
      },
      constrainWidth: true,
    })
  }, [bodyHtml, allowRemote])

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null) return
    const controller = mountMailFrame(iframe, srcdoc, { onLink: onOpenLink })
    return () => controller.destroy()
  }, [srcdoc, onOpenLink])

  return <iframe ref={iframeRef} title={title} aria-label={title} className={styles.frame} />
}

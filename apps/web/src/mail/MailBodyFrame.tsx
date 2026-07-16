/**
 * Renders one already-sanitized message body inside the @waxwing/mail-html sandboxed iframe (M1.8,
 * FR-RD-01). Given a body HTML string (sanitizer output, or renderPlainText output) it builds the
 * frame document with the matching `allowRemote` and mounts it (script-free `sandbox`, auto-height,
 * link interception). All isolation/CSP lives in the package; this is just the React lifecycle.
 */

import { buildFrameDocument, type MailLinkInfo, mountMailFrame } from '@waxwing/mail-html'
import { useEffect, useMemo, useRef } from 'react'
import styles from './reading.module.css'

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
  const srcdoc = useMemo(
    () => buildFrameDocument(bodyHtml, { allowRemote }),
    [bodyHtml, allowRemote],
  )

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null) return
    const controller = mountMailFrame(iframe, srcdoc, { onLink: onOpenLink })
    return () => controller.destroy()
  }, [srcdoc, onOpenLink])

  return <iframe ref={iframeRef} title={title} aria-label={title} className={styles.frame} />
}

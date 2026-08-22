/**
 * Opening a link out of a mail body (M3.9, FR-RD-08).
 *
 * The frame intercepts the click (nothing runs inside it — see `@waxwing/mail-html`'s `frame.ts`),
 * hands the app the href and the text the reader actually saw, and this decides what happens next:
 * open it, or stop and ask.
 *
 * ## Why a blocking dialog, and why it cannot be turned off
 * A host mismatch is the one phishing signal a reader can act on but cannot see — the visible text
 * is the attacker's to write. Passive affordances (a status bar, a tooltip) are read by nobody in
 * the moment that matters, so this interrupts. Deliberately absent:
 *
 *  - **No "don't ask again".** The entire value is that it cannot be trained away. A friction the
 *    reader can switch off is a friction the attacker's own message can talk them into switching off.
 *  - **No per-sender allowlist.** It would be keyed on `From`, which is spoofable — the header the
 *    whole warning exists because we cannot trust. That is worse than nothing: it would let an
 *    attacker inherit a decision the reader made about someone else.
 *
 * The dialog is raised at most once per click and holds no state beyond the pending link.
 */

import { classifyLink, displayHost, type MailLinkInfo } from '@waxwing/mail-html'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PendingLink {
  readonly href: string
  /** ASCII/punycode, as the link's text claims. Safe to render verbatim. */
  readonly claimedHost: string
  /** ASCII/punycode, where the browser will actually go. Safe to render verbatim. */
  readonly targetHost: string
}

export interface LinkOpener {
  /** Pass to `MailBodyFrame`'s `onOpenLink`. Stable. Only intercepted links arrive here. */
  readonly onOpenLink: (href: string, info: MailLinkInfo) => void
  /**
   * Pass to `MailBodyFrame`'s `onGateLink`. Stable. Answers, per link and before any click, whether
   * the app keeps it (`true`) or the browser may open it (`false`) — see `frame.ts` on why that
   * decision cannot wait for the click on Safari.
   */
  readonly gateLink: (href: string, info: MailLinkInfo) => boolean
  /** The link awaiting a decision, or `null` when nothing is pending (the dialog is then unmounted). */
  readonly pending: PendingLink | null
  /** Open the pending link and dismiss. */
  confirm(): void
  /** Discard the pending link WITHOUT opening it. */
  cancel(): void
}

/** `noopener,noreferrer`: the opened page gets no `window.opener` handle and no referrer. */
function openExternal(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer')
}

export function useLinkOpener(): LinkOpener {
  const [pending, setPending] = useState<PendingLink | null>(null)

  // `confirm` must be stable (it sits next to `cancel`, which Dialog requires to be) yet act on the
  // CURRENT pending link, so it reads a mirror rather than closing over the state. The mirror is
  // written in an effect, not during render: `window.open` inside a `setPending` updater would fire
  // twice under StrictMode, which double-opens the very link we made the reader think about.
  const pendingRef = useRef<PendingLink | null>(null)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  /**
   * Asked once per link when the message loads, long before any click (see `frame.ts`'s `gateLink`).
   * `false` hands the link to the browser; `true` keeps it here.
   *
   * The base is not optional in a browser, it is the whole check. A protocol-relative `//evil.tld/x`
   * resolves against THIS document and lands on `https://evil.tld/x` — and `classifyLink` without a
   * base cannot parse that href at all, calls it `unparsable`, and would release it. Classify the
   * href the way it will actually be opened, or classify nothing at all. (The frame resolves it with
   * the same base before asking, so both sides are looking at one URL.)
   */
  const gateLink = useCallback((href: string, info: MailLinkInfo): boolean => {
    const verdict = classifyLink(href, info.text, window.location.href)
    if (verdict.kind === 'mismatch') return true
    // A web link nothing is wrong with: the browser opens it, in the new tab the frame prepares.
    // `noopener`/`noreferrer` ride on the anchor, so it is as isolated as `window.open` made it.
    // Anything else — `mailto:`, `tel:`, an href with no host to compare — stays with the app.
    return displayHost(href, window.location.href) === null
  }, [])

  const onOpenLink = useCallback((href: string, info: MailLinkInfo): void => {
    // Reached only by links `gateLink` KEPT, and the frame has already suppressed the click.
    const verdict = classifyLink(href, info.text, window.location.href)
    if (verdict.kind === 'mismatch') {
      setPending({ href, claimedHost: verdict.claimedHost, targetHost: verdict.targetHost })
      return
    }
    // `mailto:`/`tel:` — the app opens them itself, exactly as it always has.
    openExternal(href)
  }, [])

  const cancel = useCallback((): void => setPending(null), [])

  const confirm = useCallback((): void => {
    const target = pendingRef.current
    setPending(null)
    if (target !== null) openExternal(target.href)
  }, [])

  return { onOpenLink, gateLink, pending, confirm, cancel }
}

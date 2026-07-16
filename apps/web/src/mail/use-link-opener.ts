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

import { classifyLink, type MailLinkInfo } from '@waxwing/mail-html'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PendingLink {
  readonly href: string
  /** ASCII/punycode, as the link's text claims. Safe to render verbatim. */
  readonly claimedHost: string
  /** ASCII/punycode, where the browser will actually go. Safe to render verbatim. */
  readonly targetHost: string
}

export interface LinkOpener {
  /** Pass to `MailBodyFrame`'s `onOpenLink`. Stable. */
  readonly onOpenLink: (href: string, info: MailLinkInfo) => void
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

  const onOpenLink = useCallback((href: string, info: MailLinkInfo): void => {
    // The base is not optional in a browser, it is the whole check. `window.open('//evil.tld/x')`
    // resolves against THIS document, so a protocol-relative href lands on `https://evil.tld/x` —
    // and `classifyLink` without a base cannot parse that href at all, calls it `unparsable`, and
    // drops straight to `openExternal` below. Same destination as `https://evil.tld/x`, no dialog.
    // Classify the href the way the `window.open` two lines down will resolve it, or classify
    // nothing at all.
    const verdict = classifyLink(href, info.text, window.location.href)
    if (verdict.kind === 'mismatch') {
      setPending({ href, claimedHost: verdict.claimedHost, targetHost: verdict.targetHost })
      return
    }
    // `ok` and `unparsable` alike open exactly as they always have: a link whose text claims no
    // host, and a `mailto:`/`tel:`/relative href with no host to compare, are both unremarkable.
    openExternal(href)
  }, [])

  const cancel = useCallback((): void => setPending(null), [])

  const confirm = useCallback((): void => {
    const target = pendingRef.current
    setPending(null)
    if (target !== null) openExternal(target.href)
  }, [])

  return { onOpenLink, pending, confirm, cancel }
}

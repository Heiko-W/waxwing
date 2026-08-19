/**
 * Opens a composer for a `mailto:` link handed to the app by the operating system (FR-CMP-13).
 *
 * The manifest registers `mailto` with `./?mailto=%s`, so clicking a mail link anywhere on the
 * system lands here with the whole URI in a query parameter.
 *
 * Two details that are easy to get wrong:
 *
 * - **The parameter is stripped from the URL after use**, the same way the OAuth callback params
 *   are. Leave it there and a reload — or a restore of the last session — opens a second composer
 *   for a mail the user already sent.
 * - **It runs once per parameter, not once per mount.** The effect keys on the raw value, so
 *   arriving at the same address twice in a row still opens a composer the second time, while a
 *   re-render caused by anything else does not.
 */

import { useEffect, useRef } from 'react'
import { useComposerStore } from '../../compose'
import { isEmptyMailto, mailtoBodyToHtml, parseMailto } from '../../compose/mailto'

/** The query parameter the manifest's `protocol_handlers` entry fills in. */
export const MAILTO_PARAM = 'mailto'

/** Removes the parameter from the address bar without adding a history entry. */
function stripParam(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete(MAILTO_PARAM)
  window.history.replaceState(window.history.state, '', url.href)
}

export function useMailtoHandler(): void {
  const handled = useRef<string | null>(null)

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get(MAILTO_PARAM)
    if (raw === null || raw === '') return
    if (handled.current === raw) return
    handled.current = raw

    // Strip first: whatever the parse decides, this parameter must not survive into a reload.
    stripParam()

    const request = parseMailto(raw)
    // `mailto:` with nothing in it is a valid URI and means "start a blank message" — but so does
    // a parameter we could not read at all, and opening an empty composer for a malformed link is
    // the friendlier of the two failures.
    if (isEmptyMailto(request)) {
      useComposerStore.getState().openDraft({})
      return
    }

    useComposerStore.getState().openDraft({
      to: request.to,
      cc: request.cc,
      bcc: request.bcc,
      subject: request.subject,
      body: mailtoBodyToHtml(request.body),
    })
  }, [])
}

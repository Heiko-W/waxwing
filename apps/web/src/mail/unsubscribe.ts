/**
 * `List-Unsubscribe` handling (M5.3, FR-RD-09; RFC 2369, RFC 8058).
 *
 * A mailing list offers up to two ways out: a URL to open, and — where the sender opted in with
 * `List-Unsubscribe-Post` — a one-click POST that needs no page visit at all.
 *
 * **What is honest about the one-click path.** The POST goes to another origin, which will not send
 * CORS headers, so it has to be a `no-cors` request. That request *is* delivered; what comes back
 * is opaque. We therefore know the POST left the browser and never know whether the list acted on
 * it. The UI says "sent", not "unsubscribed" — the distinction is the whole point, because the one
 * thing a reader must not be told is that they are off a list when they may not be.
 *
 * **Why the scheme allowlist is not paranoia.** The URLs come from the message. A `javascript:` or
 * `data:` URL reaching an opener would be script execution from mail content, and one-click POSTs
 * are restricted further still — to `https:` alone, because an `http:` POST would carry whatever
 * opaque token the URL holds in clear text over the network.
 */

/** What a message offers the reader by way of getting off the list. */
export interface UnsubscribeOffer {
  /** An `https:` endpoint that accepts the RFC 8058 one-click POST, when the sender opted in. */
  readonly oneClick: string | null
  /** A URL to open in a new tab (`https:` only). */
  readonly url: string | null
  /** A `mailto:` URI to seed a composer with. */
  readonly mailto: string | null
}

const NONE: UnsubscribeOffer = { oneClick: null, url: null, mailto: null }

/**
 * `List-Unsubscribe-Post` has exactly one defined value (RFC 8058 §3.1). Compared
 * case-insensitively and whitespace-tolerantly, because senders are not careful, but not loosened
 * further: this header is the sender's consent to a POST, and anything else is not that consent.
 */
function optsIntoOneClick(post: string | null | undefined): boolean {
  if (typeof post !== 'string') return false
  return post.trim().toLowerCase() === 'list-unsubscribe=one-click'
}

/** Parses a URL, returning `null` for anything malformed. */
function safeUrl(candidate: string): URL | null {
  try {
    return new URL(candidate.trim())
  } catch {
    return null
  }
}

/**
 * Reads the offer out of the two headers.
 *
 * `urls` arrives already unbracketed from `:asURLs`; a raw `<https://…>, <mailto:…>` string is also
 * accepted so a caller holding an unparsed header is not forced to pre-clean it.
 */
export function readUnsubscribeOffer(
  urls: readonly string[] | null | undefined,
  post: string | null | undefined,
): UnsubscribeOffer {
  if (!Array.isArray(urls) || urls.length === 0) return NONE

  let httpsUrl: string | null = null
  let mailto: string | null = null

  for (const raw of urls) {
    if (typeof raw !== 'string') continue
    // Tolerate a bracketed value in case a server hands back the raw header form.
    const parsed = safeUrl(raw.replace(/^\s*<|>\s*$/g, ''))
    if (parsed === null) continue

    if (parsed.protocol === 'https:' && httpsUrl === null) httpsUrl = parsed.href
    else if (parsed.protocol === 'mailto:' && mailto === null) mailto = parsed.href
    // Every other scheme — `http:`, `javascript:`, `data:` — is dropped without comment.
  }

  return {
    // One-click needs BOTH the sender's opt-in and an https endpoint to send it to.
    oneClick: optsIntoOneClick(post) ? httpsUrl : null,
    url: httpsUrl,
    mailto,
  }
}

/** Whether there is anything to offer the reader at all. */
export function hasUnsubscribeOffer(offer: UnsubscribeOffer): boolean {
  return offer.oneClick !== null || offer.url !== null || offer.mailto !== null
}

/** The body RFC 8058 §3.2 requires for the one-click POST. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'

/**
 * Sends the one-click POST.
 *
 * `mode: 'no-cors'` because the endpoint belongs to the sender and will not permit our origin. The
 * request is still delivered — that is the whole reason this mode exists — but the response is
 * opaque, so **this resolves as soon as the request left, not when the list acted**. It resolves
 * `false` only when the browser refused to send at all (offline, blocked).
 *
 * The `Content-Type` is the one `no-cors` allows without a preflight, and is also the one RFC 8058
 * specifies. Any other header would turn this into a preflighted request that the endpoint would
 * fail.
 */
export async function sendOneClickUnsubscribe(
  endpoint: string,
  fetchLike: typeof fetch = fetch,
): Promise<boolean> {
  const parsed = safeUrl(endpoint)
  if (parsed === null || parsed.protocol !== 'https:') return false
  try {
    await fetchLike(parsed.href, {
      method: 'POST',
      mode: 'no-cors',
      // No credentials: this is a third-party endpoint and the token is already in the URL.
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ONE_CLICK_BODY,
    })
    return true
  } catch {
    return false
  }
}

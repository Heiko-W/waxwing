/**
 * Contact photo source (M4.2). Turns a card's {@link ContactCardMedia} into a displayable URL, going
 * through the SAME write-through blob cache as the reader's attachments ({@link useBlobFetcher}), so a
 * photo is downloaded from the authenticated JMAP endpoint at most once and then served from the
 * replica (and re-shown offline). Photo UPLOAD is not this milestone — this is read-only.
 *
 * The lifecycle is the async-seam-sensitive part (this project's top bug class — a React value meeting
 * a single async resource): the object URL is created only after the fetch resolves, revoked when the
 * media changes or the component unmounts, and a `cancelled` guard makes a late resolution a no-op so
 * it can neither paint a superseded photo nor leak its URL. A `data:`/inline `uri` needs no fetch and
 * no revoke, so it is returned as-is.
 */

import type { ContactCardMedia, Id } from '@waxwing/jmap'
import { useEffect, useState } from 'react'
import { useBlobFetcher } from '../mail/use-blob'

/** The resolved photo URL for a card's media, or `undefined` (none / not yet loaded / failed). */
export function useContactPhoto(
  accountId: Id,
  media: ContactCardMedia | undefined,
): string | undefined {
  const fetchBlob = useBlobFetcher(accountId)
  const [url, setUrl] = useState<string | undefined>(undefined)

  const blobId = media?.blobId
  const inlineUri = media?.uri
  const mediaType = media?.mediaType ?? 'application/octet-stream'

  useEffect(() => {
    // No externalised blob → use the inline URI directly (a `data:` photo), or nothing. No object URL
    // is created here, so there is nothing to revoke on cleanup.
    if (blobId === undefined) {
      setUrl(inlineUri)
      return
    }

    let objectUrl: string | undefined
    let cancelled = false
    void (async () => {
      const blob = await fetchBlob({ blobId, type: mediaType, name: null })
      if (cancelled) return
      if (blob === null) {
        setUrl(undefined)
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    })()

    return () => {
      cancelled = true
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [blobId, inlineUri, mediaType, fetchBlob])

  return url
}

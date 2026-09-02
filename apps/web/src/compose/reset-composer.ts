/**
 * Drop everything the composer holds at MODULE scope (FR-AUTH-05, FR-AUTH-09).
 *
 * Three module singletons carry a draft between renders — deliberately, so a window survives a route
 * change, a host remount and a minimize/restore: the {@link useComposerStore} itself (recipients,
 * subject, body, attachment references), the upload hook's `pending` map (the actual `File` objects
 * still going up) and the inline-image registry (`blob:` URLs for pasted screenshots). None of them
 * is React state, so nothing about signing out touches them: the shell unmounts, the module graph
 * does not.
 *
 * That made a sign-out on a shared machine leak in both directions. The next person to sign in on
 * the same tab saw the previous person's draft windows re-mount (`AppShell` gates the host on
 * "are there drafts?"), and the first tab switch or keystroke flushed them into the NEW account —
 * `putDraft` under its id and an `Email/set` into ITS Drafts folder, on the server, with a `from`
 * that resolves to nothing. "Sign out and remove data" did not help: that wipe is about IndexedDB
 * and web storage, and none of this is stored.
 *
 * Called from `endSession` AFTER the open drafts have been flushed (see {@link flushOpenDrafts}) —
 * the order matters, because a flush reads the very store this clears. NOT called on the M4.4
 * account switch: the composer is deliberately scoped to the primary account and a switch changes
 * the ACTING account, not the person at the keyboard.
 */

import { useComposerStore } from './composer-store'
import { revokeAllInlineObjectUrls } from './inline-image-registry'
import { abortPendingUploads } from './use-attachment-upload'

export function resetComposer(): void {
  abortPendingUploads()
  revokeAllInlineObjectUrls()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
}

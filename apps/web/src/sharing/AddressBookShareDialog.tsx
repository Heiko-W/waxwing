/**
 * Sharing one address book (S-2) — the `AddressBook` binding of {@link ShareDialog}.
 *
 * Structurally the mail folder's dialog with a different noun, and for the same measured reason: the
 * grant map is not on hand when it opens. The sync engine fetches address books with no `properties`
 * at all, and whether Stalwart volunteers `shareWith` in that answer has never been measured (see
 * `addressbook-client.ts`) — so the map is fetched here and nothing is rendered until it lands. A
 * dialog that opened on `{}` would show "Only you" over a book two people can read, and the first
 * edit made from that view would write the `{}` back.
 *
 * The wait lives INSIDE the dialog, one `<Dialog>` mounted once with its body swapped. Rendering a
 * separate loading dialog and replacing it unmounts a focus trap, and `useFocusTrap` returns focus
 * to the opener when it goes — the reader's focus would jump back to the rail the moment the fetch
 * returned.
 */

import type { AddressBookRights, Id } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AddressBookSharingClient } from './addressbook-client'
import type { AddressBookShareWith } from './addressbook-roles'
import { addressBookRoles } from './addressbook-roles'
import { ShareDialog, type ShareLoadState, type SharingClient } from './ShareDialog'

export interface AddressBookShareDialogProps {
  readonly bookId: Id
  /** The book's display name — supplied by the caller, which owns that vocabulary. */
  readonly name: string
  readonly client: AddressBookSharingClient
  onClose: () => void
  /** Called after every successful write, so a "shared" marker behind the dialog stays true. */
  onChanged?: (() => void) | undefined
}

const NOTHING: AddressBookShareWith = {}

export function AddressBookShareDialog({
  bookId,
  name,
  client,
  onClose,
  onChanged,
}: AddressBookShareDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<ShareLoadState>('loading')
  const [shareWith, setShareWith] = useState<AddressBookShareWith>(NOTHING)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await client.load(bookId)
        if (cancelled) return
        setShareWith(loaded)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, bookId])

  const setShare = useCallback(
    (next: Record<Id, AddressBookRights>) => client.setShareWith(bookId, next),
    [client, bookId],
  )
  // Memoized: the generic dialog holds this in a `useEffect` dependency list, so a fresh object per
  // render would re-run the principal search on every keystroke.
  const sharing = useMemo<SharingClient<AddressBookRights>>(
    () => ({ searchPrincipals: (query) => client.searchPrincipals(query), setShareWith: setShare }),
    [client, setShare],
  )

  return (
    <ShareDialog
      title={t('sharing.addressBook.title', { name })}
      kind="addressBook"
      roles={addressBookRoles}
      shareWith={shareWith}
      client={sharing}
      state={state}
      loadFailedMessage={t('sharing.addressBook.loadFailed')}
      onClose={onClose}
      onChanged={() => onChanged?.()}
    />
  )
}

export default AddressBookShareDialog

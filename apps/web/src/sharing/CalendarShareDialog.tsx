/**
 * Sharing one calendar (S-2) — the `Calendar` binding of {@link ShareDialog}, and the shortest of
 * the four.
 *
 * It has no load, and that is not an omission: `CALENDAR_PROPERTIES` in
 * `calendar/calendar-client.ts` has named `shareWith` since K-1, so every `Calendar` object the rail
 * is holding already carries the server's own grant map. The dialog is therefore in the Files
 * position — the map arrives WITH the object — rather than the mail folder's, which has to fetch it.
 *
 * The one thing to keep true: if `shareWith` ever leaves that property list, this file has to grow
 * the fetch that `MailboxShareDialog` performs. The failure would be silent and destructive — an
 * absent property reads as "shared with nobody", and the first edit would write that back.
 *
 * Four roles rather than three, and the generic dialog needs telling nothing about it: the count
 * comes from `calendarRoles` (see `calendar-roles.ts`).
 */

import type { CalendarRights, Id } from '@waxwing/jmap'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CalendarShareWith } from './calendar-roles'
import { calendarRoles } from './calendar-roles'
import type { CalendarSharingClient } from './calendar-share-client'
import { ShareDialog, type SharingClient } from './ShareDialog'

export interface CalendarShareDialogProps {
  readonly calendarId: Id
  /** The calendar's display name — the caller owns it. */
  readonly name: string
  /**
   * The grant map the last `Calendar/get` returned. `null`/absent is "shared with nobody", which is
   * what the server means by it — see the module note on why that is safe HERE and nowhere else.
   */
  readonly shareWith: Record<Id, CalendarRights> | null | undefined
  readonly client: CalendarSharingClient
  onClose: () => void
  /** Called after every successful write, so the rail's "shared" marker stays true. */
  onChanged: () => void
}

const NOTHING: CalendarShareWith = {}

export function CalendarShareDialog({
  calendarId,
  name,
  shareWith,
  client,
  onClose,
  onChanged,
}: CalendarShareDialogProps) {
  const { t } = useTranslation()

  const setShare = useCallback(
    (next: Record<Id, CalendarRights>) => client.setShareWith(calendarId, next),
    [client, calendarId],
  )
  // Memoized: the generic dialog holds this in a `useEffect` dependency list, so a fresh object per
  // render would re-run the principal search on every keystroke.
  const sharing = useMemo<SharingClient<CalendarRights>>(
    () => ({ searchPrincipals: (query) => client.searchPrincipals(query), setShareWith: setShare }),
    [client, setShare],
  )

  return (
    <ShareDialog
      title={t('sharing.calendar.title', { name })}
      kind="calendar"
      roles={calendarRoles}
      shareWith={shareWith ?? NOTHING}
      client={sharing}
      onClose={onClose}
      onChanged={onChanged}
    />
  )
}

export default CalendarShareDialog

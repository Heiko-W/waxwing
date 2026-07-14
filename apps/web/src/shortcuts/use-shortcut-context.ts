/**
 * Assembles the {@link ShortcutContext} the registry runs against (M3.8).
 *
 * Everything here is a READER over state that already exists — the router, the hoisted list store, the
 * open message's registered handlers, the role mailboxes — plus the SAME action seams the buttons use
 * (`useTriage` → `useMessageActions`, the composer store). The sync engine is never reachable from a
 * shortcut: that is the invariant this file exists to hold.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useRouter } from '../app/route'
import { useComposerStore } from '../compose'
import { useListStore } from '../mail/list-store'
import { useReadingStore } from '../mail/reading-store'
import { SEARCH_INPUT_ID } from '../mail/search/SearchBox'
import { useTriage } from '../mail/use-triage'
import { useEmailWindow, useMailboxes } from '../sync'
import type { RoleMailboxes, ShortcutContext, ShortcutScope } from './types'
import { usePaletteUi } from './ui-store'

const ROLE_KEYS = ['inbox', 'archive', 'junk', 'trash', 'drafts', 'sent'] as const
type RoleKey = (typeof ROLE_KEYS)[number]

function isRoleKey(role: string | null): role is RoleKey {
  return role !== null && (ROLE_KEYS as readonly string[]).includes(role)
}

export function useShortcutContext(): ShortcutContext {
  const router = useRouter()
  const route = router.match
  const list = useListStore()
  const reading = useReadingStore((state) => state.handlers)
  const triage = useTriage()
  const mailboxes = useMailboxes()
  const openPalette = usePaletteUi((state) => state.openPalette)
  const openHelp = usePaletteUi((state) => state.openHelp)

  const roles = useMemo<RoleMailboxes>(() => {
    const map: { -readonly [K in RoleKey]?: Id } = {}
    for (const mailbox of mailboxes ?? []) {
      if (isRoleKey(mailbox.role)) map[mailbox.role] = mailbox.id
    }
    return map
  }, [mailboxes])

  // Outside the mail area (settings, contacts) only GLOBAL chords may fire — otherwise `e` on the
  // settings screen would archive whatever the list happened to have selected before we left it.
  const scope: ShortcutScope =
    route.id !== 'mail' ? 'global' : route.params.emailId !== undefined ? 'reading' : 'list'
  const openEmailId = route.id === 'mail' ? route.params.emailId : undefined
  const focusedEmailId = list.ids[list.focusIndex]
  const hasSelection = list.selection.selected.size > 0

  const targetIds = useMemo<readonly Id[]>(() => {
    if (hasSelection) return [...list.selection.selected]
    if (openEmailId !== undefined) return [openEmailId]
    if (focusedEmailId !== undefined) return [focusedEmailId]
    return []
  }, [hasSelection, list.selection.selected, openEmailId, focusedEmailId])

  // The move source follows the same precedence as the targets: a selection moves out of the list's
  // window, the open message out of the mailbox it is being READ in (which is the one its own action
  // bar uses), a focused row out of the window again.
  const sourceMailboxId: Id | null =
    !hasSelection && openEmailId !== undefined
      ? (reading?.mailboxId ?? list.sourceMailboxId)
      : list.sourceMailboxId

  const inTrash = roles.trash !== undefined && sourceMailboxId === roles.trash

  // `s` is a TOGGLE, so it has to know the current flag state of what it is about to act on — read from
  // the replica, the same source the star button renders from, so key and button can never disagree.
  const targetRows = useEmailWindow(useMemo(() => [...targetIds], [targetIds]))
  const targetsAllFlagged =
    targetIds.length > 0 &&
    targetRows !== undefined &&
    targetRows.length === targetIds.length &&
    targetRows.every((row) => row?.keywords.$flagged === true)

  return useMemo<ShortcutContext>(
    () => ({
      scope,
      route,
      navigate: router.navigate,
      back: router.back,
      targetIds,
      sourceMailboxId,
      openEmailId,
      focusedEmailId,
      hasSelection,
      targetsAllFlagged,
      roles,
      inTrash,
      triage,
      reading,
      list,
      openCompose: () => {
        useComposerStore.getState().openDraft()
      },
      focusSearch: () => {
        const input = document.getElementById(SEARCH_INPUT_ID)
        if (input instanceof HTMLInputElement) input.focus()
      },
      openPalette,
      openHelp,
    }),
    [
      scope,
      route,
      router,
      targetIds,
      sourceMailboxId,
      openEmailId,
      focusedEmailId,
      hasSelection,
      targetsAllFlagged,
      roles,
      inTrash,
      triage,
      reading,
      list,
      openPalette,
      openHelp,
    ],
  )
}

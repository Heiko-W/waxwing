/**
 * What the ⌘K palette can reach (M3.8, FR-UI-04): every enabled registry action, every folder, every
 * label, plus the two secondary areas. "Palette reaches every folder and action" is the WP's exit
 * criterion, so this list is derived — never hand-maintained.
 *
 * LAZY: imported only by the palette chunk.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CONTACTS_PATH, mailPath, settingsPath } from '../app/route'
import { folderDisplayName } from '../mail/folder-tree'
import { useLabels } from '../mail/labels/use-labels'
import { useMailboxes } from '../sync'
import { isRunnable, SHORTCUTS } from './registry'
import type { ShortcutContext, ShortcutGroup } from './types'

export interface PaletteItem {
  /** Stable across sessions — it is the recents key. `action:<id>` / `folder:<id>` / `label:<kw>`. */
  readonly id: string
  readonly label: string
  readonly group: ShortcutGroup
  /** Chords to show as `<kbd>` chips (empty for a folder/label/route jump). */
  readonly keys: readonly string[]
  run(): void
}

export function usePaletteItems(context: ShortcutContext): readonly PaletteItem[] {
  const { t } = useTranslation()
  const mailboxes = useMailboxes()
  const labels = useLabels()

  return useMemo<readonly PaletteItem[]>(() => {
    const items: PaletteItem[] = []

    for (const action of SHORTCUTS) {
      if (action.paletteHidden === true) continue
      // The SAME gate the key dispatcher uses — scope AND enabled. `enabled()` alone would keep
      // offering "Archive" on /settings and /contacts (nothing clears the list window when the list
      // unmounts), and running it there would file away a message that is not even on screen.
      if (!isRunnable(action, context)) continue
      items.push({
        id: `action:${action.id}`,
        label: t(action.titleKey),
        group: action.group,
        keys: action.keys,
        run: () => action.run(context),
      })
    }

    for (const mailbox of mailboxes ?? []) {
      items.push({
        id: `folder:${mailbox.id}`,
        label: t('palette.goToFolder', { folder: folderDisplayName(mailbox, t) }),
        group: 'navigation',
        keys: [],
        run: () => context.navigate(mailPath(mailbox.id)),
      })
    }

    for (const label of labels ?? []) {
      items.push({
        id: `label:${label.keyword}`,
        label: t('palette.goToLabel', { label: label.name }),
        group: 'navigation',
        keys: [],
        // A label view is not a folder — it is the `?label=` query on /mail (`use-label-view.ts`).
        run: () => context.navigate(`/mail?label=${encodeURIComponent(label.keyword)}`),
      })
    }

    items.push({
      id: 'route:settings',
      label: t('palette.goToSettings'),
      group: 'application',
      keys: [],
      run: () => context.navigate(settingsPath()),
    })
    items.push({
      id: 'route:contacts',
      label: t('palette.goToContacts'),
      group: 'application',
      keys: [],
      run: () => context.navigate(CONTACTS_PATH),
    })

    return items
  }, [context, mailboxes, labels, t])
}

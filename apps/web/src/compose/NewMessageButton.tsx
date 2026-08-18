/**
 * The "New message" trigger (M2.2). Lives in the shell header so compose is reachable from every
 * route. Imports only the store's `openDraft`, so it stays in the eager graph without pulling in
 * the editor/squire (those load lazily with {@link ComposerHost} once a draft opens).
 *
 * On a phone it LOOKS like it lives somewhere else: the same node is styled as a floating action
 * button in the bottom-trailing corner. FR-UI-03 asks for "bottom-reachable actions", and the most
 * frequent writing action in the app was sitting in the corner a thumb reaches last on an 844 px
 * device, while the 59 px band that IS reachable carried only navigation. Styling the existing node
 * rather than rendering a second one keeps one id (`ComposerHost` returns focus to it), one
 * shortcut target and one accessible name.
 */

import { SquarePen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '../ui'
import { useComposerStore } from './composer-store'
import styles from './new-message-button.module.css'

/** Stable id so the composer host can return focus here when the last draft closes. */
export const NEW_MESSAGE_BTN_ID = 'waxwing-compose-new'

export function NewMessageButton() {
  const { t } = useTranslation()
  const openDraft = useComposerStore((state) => state.openDraft)

  // (The ⌘/Ctrl+N listener that used to live here is now the `compose.new` registry row — `c` primary,
  // ⌘N a best-effort second chord — dispatched by the single ShortcutProvider listener. M3.8.)

  return (
    <IconButton
      id={NEW_MESSAGE_BTN_ID}
      className={styles.newMessage}
      label={t('compose.new')}
      variant="ghost"
      onClick={() => openDraft()}
    >
      <SquarePen />
    </IconButton>
  )
}

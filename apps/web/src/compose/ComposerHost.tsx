/**
 * The composer mount layer (M2.2). Rendered LAZILY (default export → `React.lazy` in AppShell) so
 * the editor + squire load only once a draft opens. It portals a fixed layer to `document.body` —
 * OUTSIDE the route-swapped `<main>` — so docked drafts float above the mail UI and survive route
 * changes (the store is module-scoped; this host lives in the persistent AppShell). Desktop/tablet
 * shows every draft as a window; phone shows one full-screen draft at a time.
 */

import { useEffect, useRef } from 'react'
import { useLayoutTier } from '../app/shell/layout'
import { Portal } from '../ui'
import type { BlobUploader } from './attachment-upload'
import { ComposerWindow } from './ComposerWindow'
import styles from './composer.module.css'
import { useComposerStore } from './composer-store'
import type { EditorFactory } from './editor-engine'
import { NEW_MESSAGE_BTN_ID } from './NewMessageButton'
import type { RecipientSuggestionSource } from './recipient-suggestions'
import { useDraftAutosave } from './use-draft-autosave'

export interface ComposerHostProps {
  /** Injectable editor factory (tests pass a fake); production omits it (real Squire adapter). */
  readonly editorFactory?: EditorFactory | undefined
  /** Injectable recipient-suggestion source (tests/E2E); production omits it (recents source). */
  readonly recipientSuggestions?: RecipientSuggestionSource | undefined
  /** Injectable blob uploader (tests/E2E); production omits it (built from the session). */
  readonly uploader?: BlobUploader | undefined
}

export default function ComposerHost({
  editorFactory,
  recipientSuggestions,
  uploader,
}: ComposerHostProps) {
  const tier = useLayoutTier()
  const drafts = useComposerStore((state) => state.drafts)
  const focusedId = useComposerStore((state) => state.focusedId)

  // Persist edits (durable local write + coalesced server save) on idle + on tab-hide.
  useDraftAutosave()

  /*
   * Return focus when the last draft closes (WCAG 2.4.3).
   *
   * On UNMOUNT, which is when that happens: `AppShell` renders this host only while `drafts.size > 0`,
   * so the "zero drafts" render the previous version waited for does not occur in the app — the
   * component is gone by then. That effect had been dead since M2.2 and the unit tests could not see
   * it, because they render the host directly and never reproduce the mount gate. The Gate harness
   * below does.
   *
   * The target is the New-message trigger — it is what was pressed — but since B50 that button only
   * renders on the mail route, and a draft can be opened from anywhere: `c` and ⌘N are global chords
   * and the command palette offers the same action from Settings. So the opener is remembered and
   * used when the trigger is not on screen; without it a keyboard reader closing a draft started in
   * Settings would be stranded on `body`.
   */
  const opener = useRef<HTMLElement | null>(null)
  // Read in the RENDER body, deliberately. Child effects run before the parent's, so by the time an
  // effect here could look, `ComposerWindow` has already taken focus for itself — it would remember
  // the composer instead of what opened it. Nothing is committed during render, so `activeElement`
  // is still the opener. Idempotent under StrictMode's double render for the same reason.
  if (opener.current === null && drafts.size > 0) {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  useEffect(() => {
    return () => {
      // Unmounting with drafts still open is the shell being torn down (sign-out, a remount), not a
      // close — moving focus there would fight whatever is replacing this tree.
      if (useComposerStore.getState().drafts.size > 0) return
      const trigger = document.getElementById(NEW_MESSAGE_BTN_ID)
      // The opener may be gone: a command-palette row is, every time. Focusing a detached node
      // silently does nothing, which would look like it worked.
      const fallback = opener.current?.isConnected === true ? opener.current : null
      ;(trigger ?? fallback)?.focus()
    }
  }, [])

  if (drafts.size === 0) return null

  const all = [...drafts.values()]
  // Phone: one full-screen window at a time — the focused draft (else the newest).
  const phoneId = focusedId ?? all[all.length - 1]?.id
  const visible = tier === 'phone' ? all.filter((draft) => draft.id === phoneId) : all

  return (
    <Portal>
      <div className={styles.layer} data-composer-layer="">
        {visible.map((draft) => (
          <ComposerWindow
            key={draft.id}
            draft={draft}
            tier={tier}
            {...(editorFactory ? { editorFactory } : {})}
            {...(recipientSuggestions ? { recipientSuggestions } : {})}
            {...(uploader ? { uploader } : {})}
          />
        ))}
      </div>
    </Portal>
  )
}

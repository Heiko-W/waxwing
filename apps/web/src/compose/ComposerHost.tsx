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
import { ComposerWindow } from './ComposerWindow'
import styles from './composer.module.css'
import { useComposerStore } from './composer-store'
import type { EditorFactory } from './editor-engine'
import { NEW_MESSAGE_BTN_ID } from './NewMessageButton'

export interface ComposerHostProps {
  /** Injectable editor factory (tests pass a fake); production omits it (real Squire adapter). */
  readonly editorFactory?: EditorFactory | undefined
}

export default function ComposerHost({ editorFactory }: ComposerHostProps) {
  const tier = useLayoutTier()
  const drafts = useComposerStore((state) => state.drafts)
  const focusedId = useComposerStore((state) => state.focusedId)

  // Return focus to the New-message trigger when the last draft closes (WCAG 2.4.3).
  const prevCount = useRef(drafts.size)
  useEffect(() => {
    if (prevCount.current > 0 && drafts.size === 0) {
      document.getElementById(NEW_MESSAGE_BTN_ID)?.focus()
    }
    prevCount.current = drafts.size
  }, [drafts.size])

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
          />
        ))}
      </div>
    </Portal>
  )
}

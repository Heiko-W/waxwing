/**
 * Autosave bridge (M2.6, FR-CMP-03). Mounted once inside {@link ComposerHost}. Subscribes to the
 * composer store and, whenever a draft's content changes, (re)arms a per-draft idle debounce that
 * persists it (durable local write + coalesced outbox save). Also flushes every draft immediately
 * when the tab is hidden (`visibilitychange`) — the main crash-safety window (close/refresh/navigate).
 *
 * Known limitation: a follower tab's edits persist through ITS own autosave; there is no cross-tab
 * hand-off, so two tabs editing the same draft last-write-wins (owner-accepted for M2.6).
 */

import { useEffect } from 'react'
import type { DraftWindow } from './composer-store'
import { useComposerStore } from './composer-store'
import { useDraftSync } from './use-draft-sync'

/** Idle delay before an edited draft is persisted (owner-confirmed default). */
const AUTOSAVE_DEBOUNCE_MS = 3000

/**
 * The fields that make a draft a different MESSAGE. Everything else on a {@link DraftWindow} is
 * window state — `mode`, `dirty`, `createdAt` — and re-arming on those is what made minimizing,
 * restoring or going full-screen cost a server round trip and a fresh server draft id each.
 *
 * Compared by REFERENCE, which is exact here: the store rebuilds the draft object per mutation and
 * carries every untouched field over by spread, so an unchanged field keeps its identity.
 */
const CONTENT_KEYS = [
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'body',
  'plainText',
  'inReplyTo',
  'references',
  'fromIdentityId',
  'attachments',
  'sendOptions',
] as const satisfies readonly (keyof DraftWindow)[]

function contentChanged(before: DraftWindow, after: DraftWindow): boolean {
  return CONTENT_KEYS.some((key) => before[key] !== after[key])
}

export function useDraftAutosave(): void {
  const draftSync = useDraftSync()
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const disarm = (localId: string): void => {
      const timer = timers.get(localId)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(localId)
      }
    }
    const arm = (localId: string): void => {
      disarm(localId)
      timers.set(
        localId,
        setTimeout(() => {
          timers.delete(localId)
          void draftSync.flush(localId)
        }, AUTOSAVE_DEBOUNCE_MS),
      )
    }

    const unsubscribe = useComposerStore.subscribe((state, prev) => {
      // A fresh Map + DraftWindow object per mutation ⇒ ref-inequality pinpoints the changed draft;
      // `contentChanged` then asks whether the change was to the MESSAGE or only to its window.
      for (const [localId, draft] of state.drafts) {
        const before = prev.drafts.get(localId)
        if (before === undefined || contentChanged(before, draft)) arm(localId)
      }
      for (const localId of prev.drafts.keys()) {
        if (!state.drafts.has(localId)) disarm(localId) // closed/discarded — cancel its autosave
      }
    })

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') return
      for (const localId of useComposerStore.getState().drafts.keys()) {
        disarm(localId)
        void draftSync.flush(localId)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [draftSync])
}

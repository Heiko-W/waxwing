/**
 * The update flow (M3.5). Registers the service worker and, when a NEW build is installed and
 * waiting, raises exactly ONE sticky toast offering a reload. Mounted once in the shell, next to the
 * storage notifier.
 *
 * Nothing reloads without the user's word: a forced reload mid-compose is exactly the failure the
 * plan's "no forced reloads mid-compose" bullet names. Two rules make the reload safe:
 *  - **Flush every open draft first.** Autosave is a 3 s IDLE debounce (use-draft-autosave.ts), so a
 *    reload within 3 s of the last keystroke would silently drop those keystrokes. Everything else
 *    already survives a reload (drafts restore; the undo-send grace is a persisted `notBefore` row).
 *  - **The other tabs reload on `controllerchange`** — `skipWaiting()` re-parents them to the new
 *    worker, so their code is stale from that moment. They flush their drafts too, then reload.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { type DraftSync, useComposerStore, useDraftSync } from '../compose'
import { useToast } from '../ui'
import {
  type RegisterSwDeps,
  registerServiceWorker,
  type SwRegistration,
  setActiveSwRegistration,
  startUpdateChecks,
} from './register-sw'

type RegisterFn = (deps: RegisterSwDeps) => Promise<SwRegistration | null>

export interface UpdatePromptDeps {
  /** Defaults to {@link registerServiceWorker} in a production build; never runs in dev/tests. */
  readonly register?: RegisterFn | undefined
  /** Defaults to a full page reload. */
  readonly reload?: (() => void) | undefined
  /** Defaults to the composer's real persistence seam. */
  readonly draftSync?: Pick<DraftSync, 'flush'> | undefined
}

/**
 * Persist every open draft. Called before ANY reload this module causes — see the header.
 *
 * **It can never fail the reload it precedes.** `flush` writes to IndexedDB, which rejects on a full
 * disk (the state M3.4's storage notifier exists for), on a closed database, and in Safari's private
 * mode — and a rejection here used to swallow the `activate()` that followed it: the user clicked
 * "Reload", the toast dismissed itself, and nothing happened, ever again. Saving the draft is
 * best-effort; stranding the user on a dead build is not an acceptable price for it. `allSettled`,
 * so one bad draft cannot take the others' flushes down with it either.
 */
async function flushOpenDrafts(draftSync: Pick<DraftSync, 'flush'>): Promise<void> {
  const openIds = [...useComposerStore.getState().drafts.keys()]
  await Promise.allSettled(openIds.map((localId) => draftSync.flush(localId)))
}

export function useUpdatePrompt(deps: UpdatePromptDeps = {}): void {
  const { t } = useTranslation()
  const { toast, dismiss } = useToast()
  const realDraftSync = useDraftSync()
  const draftSync = deps.draftSync ?? realDraftSync

  // The registration effect must run ONCE — re-registering on every language change or draft
  // mutation would re-arm the update interval — so what it needs is read through a live ref.
  const live = useRef({ t, toast, dismiss, draftSync })
  useEffect(() => {
    live.current = { t, toast, dismiss, draftSync }
  })

  const { register, reload } = deps

  useEffect(() => {
    // In dev there is no service worker at all (devOptions.enabled = false), so registering one
    // would 404. `import.meta.env.PROD` is a build-time literal, the same guard main.tsx uses.
    const registerFn: RegisterFn | null =
      register ?? (import.meta.env.PROD ? registerServiceWorker : null)
    if (registerFn === null) return

    let disposed = false
    let teardown: (() => void) | undefined
    let stopUpdateChecks: (() => void) | undefined
    let currentToast: string | undefined

    const doReload = reload ?? ((): void => window.location.reload())

    void registerFn({
      onUpdateReady: (activate) => {
        const { t: translate, toast: raise, dismiss: drop } = live.current
        // Exactly ONE update toast on screen: a second build landing while the first offer is still
        // up replaces it rather than stacking (the offer always activates the NEWEST waiting worker).
        // Replacing — rather than latching a `prompted` flag forever — is also what lets a user who
        // dismissed one offer still be told about the NEXT deploy.
        if (currentToast !== undefined) drop(currentToast)
        currentToast = raise({
          tone: 'neutral',
          duration: 0, // sticky: the user decides when, and an unnoticed update is worse than none
          title: translate('pwa.update.title'),
          description: translate('pwa.update.body'),
          action: {
            label: translate('pwa.update.action'),
            onAction: () => {
              void (async () => {
                await flushOpenDrafts(live.current.draftSync)
                activate() // → SKIP_WAITING → the new worker activates → `controllerchange` reloads us
              })()
            },
          },
        })
      },
      onControllerChange: () => {
        void (async () => {
          await flushOpenDrafts(live.current.draftSync)
          doReload()
        })()
      },
    }).then((registered) => {
      if (registered === null) return
      if (disposed) {
        registered.dispose()
        return
      }
      teardown = registered.dispose
      stopUpdateChecks = startUpdateChecks(registered.registration)
      // Publish it: M3.6 shows every notification through `registration.showNotification()`, and this
      // is the one place that owns the registration flow.
      setActiveSwRegistration(registered.registration)
    })

    return () => {
      disposed = true
      // All three matter: the interval, the listeners attached to the registration object — which the
      // browser hands back IDENTICALLY on the next register(), so a leaked one would fire again — and
      // the published registration, which must not outlive the flow that owns it.
      stopUpdateChecks?.()
      teardown?.()
      setActiveSwRegistration(null)
    }
  }, [register, reload])
}

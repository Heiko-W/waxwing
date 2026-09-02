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
import { ACTIVE_DRAFT_SYNC, type DraftSync, flushOpenDrafts } from '../compose'
import { useToast } from '../ui'
import {
  type RegisterSwDeps,
  registerServiceWorker,
  type SwRegistration,
  setActiveSwRegistration,
  startUpdateChecks,
} from './register-sw'

type RegisterFn = (deps: RegisterSwDeps) => Promise<SwRegistration | null>

/*
 * {@link ACTIVE_DRAFT_SYNC} is the composer's real persistence seam, resolved at CALL time rather
 * than through `useDraftSync()`. This hook runs ABOVE the `ReplicaProvider` (app/App.tsx explains
 * why the registration has to live there), so the hook form would hand it the no-replica branch —
 * whose `flush` is `async () => {}`. That is precisely the defect M3.10 found: the toast promised
 * "Open drafts are saved first" while `flushOpenDrafts` awaited nothing, and the unit tests could
 * not see it because every one of them injected `deps.draftSync`.
 */

/**
 * How long a reload will wait on the draft flush before going ahead without it.
 *
 * A local IndexedDB write is single-digit milliseconds, so this is three orders of magnitude of
 * headroom: past it the likeliest explanation is a database blocked behind another tab's
 * `versionchange`, which resolves only when that tab closes — i.e. possibly never. The reload must
 * not be hostage to that, for the same reason a REJECTED flush must not block it (see below).
 */
const FLUSH_DEADLINE_MS = 2000

export interface UpdatePromptDeps {
  /** Defaults to {@link registerServiceWorker} in a production build; never runs in dev/tests. */
  readonly register?: RegisterFn | undefined
  /** Defaults to a full page reload. */
  readonly reload?: (() => void) | undefined
  /** Defaults to {@link ACTIVE_DRAFT_SYNC}, the composer's real persistence seam. */
  readonly draftSync?: Pick<DraftSync, 'flush'> | undefined
  /** Defaults to {@link FLUSH_DEADLINE_MS}; injectable so a test need not wait out the real one. */
  readonly flushDeadlineMs?: number | undefined
}

export function useUpdatePrompt(deps: UpdatePromptDeps = {}): void {
  const { t } = useTranslation()
  const { toast, dismiss } = useToast()
  const draftSync = deps.draftSync ?? ACTIVE_DRAFT_SYNC
  const flushDeadlineMs = deps.flushDeadlineMs ?? FLUSH_DEADLINE_MS

  // The registration effect must run ONCE — re-registering on every language change or draft
  // mutation would re-arm the update interval — so what it needs is read through a live ref.
  const live = useRef({ t, toast, dismiss, draftSync, flushDeadlineMs })
  useEffect(() => {
    live.current = { t, toast, dismiss, draftSync, flushDeadlineMs }
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
                await flushOpenDrafts(live.current.draftSync, live.current.flushDeadlineMs)
                activate() // → SKIP_WAITING → the new worker activates → `controllerchange` reloads us
              })()
            },
          },
        })
      },
      onControllerChange: () => {
        void (async () => {
          await flushOpenDrafts(live.current.draftSync, live.current.flushDeadlineMs)
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

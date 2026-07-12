/**
 * Install guidance (M3.5, NFR-COMPAT-01). Captures Chromium's `beforeinstallprompt` so the browser's
 * own mini-infobar is suppressed and the offer moves into OUR account menu — one quiet item, no
 * banner, no nag (Apple Mail is the UI reference and it never nags).
 *
 * The captured event is MODULE state, not component state, and the listeners are attached from
 * {@link initInstallCapture} at BOOT — before `main.tsx` awaits config.json and i18n — not from a
 * component effect. `beforeinstallprompt` fires exactly once per page and is not replayed: on a
 * repeat visit the worker is already registered, so Chromium can decide the app is installable and
 * fire it while the boot is still waiting on the network. An effect that mounts several hundred
 * milliseconds later would simply never see it, and the install offer would never appear.
 *
 * `appinstalled` is also the ONLY place `requestPersistence()` is called (M3.4 owns the function and
 * the Settings switch; the "requested on install" half is deliberately left here). Never on first
 * paint: Firefox shows a permission prompt for it, and an unprompted permission bar on boot is the
 * definition of a nag.
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import { requestPersistence } from '../../sync'

/** Which install story this browser tells. `ios` has no install API at all — only instructions. */
export type InstallPlatform = 'chromium' | 'ios' | 'other'

/** Chromium's non-standard install event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent
    appinstalled: Event
  }
}

export interface InstallPrompt {
  /** True only where the browser actually offers a programmatic install (Chromium, not yet installed). */
  readonly canPrompt: boolean
  /** Already running as an installed app — offer nothing. */
  readonly isStandalone: boolean
  readonly platform: InstallPlatform
  /** Show the browser's install dialog. A no-op where there is no captured event. */
  promptInstall(): Promise<void>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let persistenceRequested = false
let capturing: AbortController | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getDeferredPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt
}

/**
 * Start listening for the browser's install events. Called ONCE from `main.tsx`, at the very top of
 * the boot — see the module header for why an effect is too late.
 *
 * @param persist injected in tests; production uses {@link requestPersistence} (M3.4).
 */
export function initInstallCapture(persist: () => Promise<boolean> = requestPersistence): void {
  if (capturing !== null || typeof window === 'undefined') return
  capturing = new AbortController()
  const { signal } = capturing

  window.addEventListener(
    'beforeinstallprompt',
    (event) => {
      // Suppresses Chromium's mini-infobar and hands us the event to replay on demand.
      event.preventDefault()
      deferredPrompt = event
      emit()
    },
    { signal },
  )

  window.addEventListener(
    'appinstalled',
    () => {
      deferredPrompt = null // the offer is spent — hide the menu item
      emit()
      if (persistenceRequested) return
      persistenceRequested = true
      // Best-effort: a denial is final for the session (sync/storage.ts) and there is nothing to say.
      void persist()
    },
    { signal },
  )
}

/** Test seam: forget the captured event, the listeners and the one-shot persistence request. */
export function resetInstallState(): void {
  capturing?.abort()
  capturing = null
  deferredPrompt = null
  persistenceRequested = false
  emit()
}

function isIos(): boolean {
  const { userAgent, platform, maxTouchPoints } = navigator
  // iPadOS 13+ reports itself as MacIntel; the touch points give it away.
  return /iphone|ipad|ipod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

function detectPlatform(): InstallPlatform {
  if (isIos()) return 'ios'
  return 'onbeforeinstallprompt' in window ? 'chromium' : 'other'
}

function detectStandalone(): boolean {
  const standaloneIos = (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (standaloneIos) return true
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(display-mode: standalone)').matches
}

/** Reads what {@link initInstallCapture} captured. Pure reader — it attaches no listeners itself. */
export function useInstallPrompt(): InstallPrompt {
  const captured = useSyncExternalStore(subscribe, getDeferredPrompt, () => null)
  const [platform] = useState(detectPlatform)
  const [isStandalone] = useState(detectStandalone)

  const promptInstall = useCallback(async (): Promise<void> => {
    const event = deferredPrompt
    if (event === null) return
    // The event is single-use: drop it before showing the dialog, whatever the user chooses.
    deferredPrompt = null
    emit()
    await event.prompt()
  }, [])

  return { canPrompt: captured !== null, isStandalone, platform, promptInstall }
}

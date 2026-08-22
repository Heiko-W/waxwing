/**
 * The ONE global keydown listener (M3.8, FR-UI-04) — plus the two lazy overlays it opens.
 *
 * It listens on `window` in the BUBBLE phase, deliberately. React 19 attaches its handlers at the app
 * root (a descendant of `<body>`), so every existing component handler — the grid's arrows, Squire's
 * ⌘B/I/U/K, the composer's ⌘↵/Escape, the menu type-ahead — runs FIRST, and each of their
 * `preventDefault()` calls becomes a free, precise veto here (step 1). A capture-phase listener would
 * pre-empt all of them, which is exactly the "shortcut conflicts with the editor" bug this design
 * exists to prevent.
 *
 * Escape is NOT bound here: `ui/internal/useDismiss` owns it through a LIFO stack, so the innermost
 * overlay always wins. Two owners for one key is the bug, not the feature.
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ui'
import { isInOverlay, isTextEntryTarget } from './dom'
import { matchesAny, parseChord } from './keys'
import { isRunnable, SHORTCUTS, unavailableNow } from './registry'
import type { ShortcutContext } from './types'
import { usePaletteUi } from './ui-store'
import { useShortcutContext } from './use-shortcut-context'

// Two surfaces most sessions never open — they load on first use, not in the entry chunk
// (NFR-PERF-03; excluded from the size budget in `.size-limit.js`).
const CommandPalette = lazy(() => import('./CommandPalette'))
const ShortcutHelp = lazy(() => import('./ShortcutHelp'))

export function ShortcutProvider() {
  const { t } = useTranslation()
  const { toast, runNewestAction } = useToast()
  // `t` changes identity on every i18n event, and `notify` is a dependency of the context object the
  // whole registry is memoised on — listing `t` there would churn that object, and every consumer of
  // it, on a language change. So `t` is read through a ref, the same trick `contextRef` below plays on
  // the listener. `toast` is already stable (a `useCallback` inside the toast host).
  const tRef = useRef(t)
  useLayoutEffect(() => {
    tRef.current = t
  })

  const notify = useCallback(
    (messageKey: string) => {
      // `warning`, not `danger`: this lands in the POLITE live region, which is right for "this account
      // cannot do that" — nothing failed and nothing was lost. The hint is added here rather than
      // carried in the key, so the registry keeps answering with exactly ONE key per reason and every
      // such message still ends by naming a way forward instead of merely apologising.
      toast({
        title: tRef.current(messageKey),
        description: tRef.current('shortcuts.unavailable.hint'),
        tone: 'warning',
      })
    },
    [toast],
  )

  const context = useShortcutContext(notify, runNewestAction)
  const contextRef = useRef<ShortcutContext>(context)
  const paletteOpen = usePaletteUi((state) => state.paletteOpen)
  const helpOpen = usePaletteUi((state) => state.helpOpen)
  const closeOverlays = usePaletteUi((state) => state.closeOverlays)

  // Refresh the snapshot on every render so the listener — subscribed exactly ONCE — never goes
  // stale. (Putting `context` in the effect below's deps would re-subscribe on every keystroke.)
  //
  // `useLayoutEffect`, NOT `useEffect` — B44's sibling, and the same reasoning as `use-swipe.ts`
  // (which carries the long version and the test that pins it). This ref is read from a NATIVE
  // `keydown` listener, and a passive effect does not run at commit: React schedules it and the
  // browser may deliver the keystroke first. In that window `e` would archive the selection the
  // reader had one render ago rather than the one on screen. A layout effect runs inside the
  // commit, so nothing that can observe the new DOM sees the old context with it.
  useLayoutEffect(() => {
    contextRef.current = context
  })

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // 1. A component already claimed this key (Squire's ⌘K, the composer's ⌘↵, the grid's arrows).
      if (event.defaultPrevented) return
      // 2. An IME composition keystroke belongs to the input method.
      if (event.isComposing || event.keyCode === 229) return
      // 3. Not while a modal / menu / the composer is up. That one is unconditional: those
      //    surfaces claim their own keys, chords included (Squire's ⌘K, the composer's ⌘↵).
      const target = event.target
      if (isInOverlay(target)) return
      /*
       * TYPING SILENCES LETTERS, NOT CHORDS.
       *
       * This used to be the same early return as the overlay check, so nothing at all fired while
       * the caret was in a field — including Ctrl/⌘+K, whose own button is labelled "Command
       * palette (Ctrl+K)" and whose entry in the cheat sheet claims no scope. Pressing it in the
       * search box did nothing, which reads as a broken shortcut rather than as a rule.
       *
       * The rule that was wanted all along is narrower: a bare letter belongs to the field the
       * reader is typing into (`e` must never archive while someone writes "e-mail"), while a Mod
       * chord is not typing in any layout — `matchesChord` already rejects Alt and AltGr for them,
       * so nothing a keyboard produces as a CHARACTER can reach one. Filtering the chord list
       * rather than returning early keeps that decision in one expression, and a letter pressed
       * while typing simply matches nothing.
       */
      const typing = isTextEntryTarget(target)

      const context = contextRef.current
      for (const action of SHORTCUTS) {
        const keys = typing ? action.keys.filter((chord) => parseChord(chord).mod) : action.keys
        if (keys.length === 0) continue
        if (!matchesAny(event, keys)) continue
        // A held `e` must not archive forty messages: swallow the repeat rather than fall through to
        // another action that happens to share the chord.
        if (event.repeat && action.allowRepeat !== true) return
        // ONE gate, shared with the palette (`isRunnable` = scope ∧ enabled). Deriving it twice is
        // what let the palette offer list actions from the Settings screen.
        if (!isRunnable(action, context)) {
          // A refusal caused by the ACCOUNT'S SHAPE gets answered instead of swallowed (G2/B3): `e` on
          // an account with no Archive folder used to fall out of this loop and do nothing at all — no
          // move, no toast, no live-region text — which is indistinguishable from a broken keyboard.
          // Every other refusal still falls through silently, because it is momentary and its cause is
          // on screen (nothing selected, an empty list, a body still loading).
          const reason = unavailableNow(action, context)
          if (reason === null) continue
          // The chord IS ours — we are answering it, so we own the key too.
          event.preventDefault()
          context.notify(reason)
          return
        }
        event.preventDefault()
        action.run(context)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette context={context} onClose={closeOverlays} />
        </Suspense>
      )}
      {helpOpen && (
        <Suspense fallback={null}>
          <ShortcutHelp context={context} onClose={closeOverlays} />
        </Suspense>
      )}
    </>
  )
}

/**
 * "You have unsaved changes here" — for the settings forms that are rendered INLINE (M5.1/M5.3).
 *
 * The dialog editors on this screen (a filter rule, a template) already guard themselves: `Dialog`
 * takes `confirmDiscard` and watches its own subtree for typing. The identity editor and the
 * vacation responder are not dialogs — they are rows of their section's card, deliberately, because
 * a signature editor inside a modal on a phone is a worse screen than one in the page. That left
 * them with no guard at all: clicking another rail entry, or the phone's "‹ Settings" back link,
 * unmounted a half-typed multi-line signature without a word.
 *
 * A boolean rather than the `Dialog` approach of sniffing input events, because these two forms
 * already know the answer precisely — they hold both the draft and the value it was loaded from, so
 * "changed" here means changed, not "touched and put back".
 *
 * Scope: this covers leaving the SECTION. Leaving the settings screen entirely (the primary nav, a
 * shortcut, the browser's back button) still discards, and closing that would mean a router-level
 * navigation block, which is an architecture decision rather than a fix.
 */

import { createContext, useContext, useEffect } from 'react'

export interface UnsavedGuard {
  /**
   * Declare whether the section currently holds unsaved input. Returns the undo, so a form that
   * unmounts (or stops being dirty) takes its claim with it — a stale `true` would put a discard
   * prompt in front of a reader who has nothing to lose, which trains people to click through it.
   */
  readonly claim: (dirty: boolean) => () => void
}

export const UnsavedContext = createContext<UnsavedGuard | null>(null)

/**
 * Report this form's dirtiness to the surrounding settings page.
 *
 * A no-op outside the page (the sections are rendered directly in several tests, and each is a
 * legitimate standalone component), so nothing here can make a section un-renderable.
 */
export function useUnsavedChanges(dirty: boolean): void {
  const guard = useContext(UnsavedContext)
  useEffect(() => {
    if (guard === null || !dirty) return
    return guard.claim(true)
  }, [guard, dirty])
}

/**
 * Shallow equality over a flat draft object.
 *
 * Both drafts this is used with are flat records of primitives (`IdentityDraft`, `VacationDraft`),
 * and both are `readonly` — which is why the constraint is `object` rather than a `Record`, whose
 * index signature a readonly interface does not satisfy.
 */
export function sameDraft<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a) as (keyof T)[]) {
    if (a[key] !== b[key]) return false
  }
  return true
}

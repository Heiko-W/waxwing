/**
 * "Does this keystroke belong to an input method?" — the one rule, in one place (R-40).
 *
 * While a Japanese or Chinese IME is composing, the keys the user presses are the IME's: Enter
 * commits the candidate, Escape cancels the composition, the arrows move through the candidate
 * list. A surface that reads `event.key` without asking this first takes those presses for itself
 * and the reader loses what they were typing — or, with a `confirmDiscard` dialog, is asked whether
 * to throw it away.
 *
 * **Two checks, because browsers disagree and both shapes are real.** Firefox (≥ 65) reports the
 * COMMITTED key with `isComposing: true` — `key: 'Escape'`, `key: 'Enter'` — so only the flag
 * separates it from a real press. Chromium reports `key: 'Process'` with the legacy `keyCode 229`,
 * which is why nothing here ever failed in a Chromium-based test: the `event.key` comparisons
 * simply missed. Safari sends `keyCode 229` too. Testing both covers all three without depending on
 * which one a given engine happens to use.
 *
 * The rule was already stated — correctly — for the global chord dispatcher (`shortcuts/keys.ts`,
 * "IME first", and `ShortcutProvider`'s listener). This is the same rule for the surfaces that do
 * their own key handling: the shared Escape coordinator, the menu, and the command palette.
 */

/** The subset of a `KeyboardEvent` the check needs — so a test can pass a plain object. */
export interface CompositionKeyEvent {
  readonly isComposing?: boolean
  readonly keyCode?: number
}

/** True while an input method owns this keystroke. Nothing in the app may act on it. */
export function isComposingKey(event: CompositionKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/**
 * The active mail account (M4.4 Etappe 3).
 *
 * With ≥1 delegated/shared account the sidebar shows every account as a sibling (Apple Mail), but the
 * message list and the reading pane are module SINGLETONS that can only hold ONE account's window and
 * one open message at a time (`list-store`, `reading-store`). This tiny store records WHICH account
 * they currently operate on; {@link MailScreen} scopes those panes to it through a `ReplicaProvider`.
 *
 * `null` means "not chosen yet" — the caller falls back to the connected session's primary account
 * ({@link resolveActiveAccount}), so the byte-for-byte single-account path never touches this store.
 *
 * Switching account is the correctness-critical moment: JMAP mailbox ids are per-account and short
 * (`a`, `b`, …), so account B's Inbox can carry the SAME list `windowKey` as account A's. Left alone,
 * `setWindow` would treat the switch as "same window, new page" and KEEP A's selection — and one
 * `e`/swipe would then dispatch a move for A's message ids against B's mailbox.
 * {@link resetMailScopedStores} clears that per-account state; it is the SAME reset the sign-out path
 * runs (SessionProvider), for the same reason, so both share one definition here.
 */

import type { Id } from '@waxwing/jmap'
import { create } from 'zustand'
import { ACCOUNT_PARAM, useRoute } from '../app/route'
import { useSessionOptional } from '../app/session/context'
// Deliberately the module, not the `../shortcuts` barrel: the barrel re-exports `ShortcutProvider`,
// whose subtree now depends on this module (AppShell wraps it in `ActiveAccountScope`), so the barrel
// import would close a cycle.
import { usePaletteUi } from '../shortcuts/ui-store'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { useReadingStore } from './reading-store'

interface ActiveAccountStore {
  /** The account the list/reading panes operate on; `null` ⇒ fall back to the primary. */
  readonly accountId: Id | null
  /** Point the panes at `accountId`. Pair with {@link resetMailScopedStores} on a real change. */
  setActiveAccount(accountId: Id): void
  /** Back to the primary/default — the sign-out reset (the next session's accounts may differ). */
  reset(): void
}

export const useActiveAccountStore = create<ActiveAccountStore>()((set) => ({
  accountId: null,
  setActiveAccount(accountId) {
    set({ accountId })
  },
  reset() {
    set({ accountId: null })
  },
}))

/** The stored active account id, or `null` before one is chosen (⇒ caller uses the primary). */
export function useActiveAccountId(): Id | null {
  return useActiveAccountStore((state) => state.accountId)
}

/**
 * The account the mail UI is ACTING in — the ONE definition (M4.4 Etappe 4).
 *
 * `null` before connect. Every surface that has to agree on this reads it here: the panes, the
 * keyboard layer, and through {@link ActiveAccountScope} the engine each of them dispatches to. They
 * cannot disagree, which is the point — a list scoped to one account while a shortcut resolves role
 * mailboxes in another is the same silent cross-account write in a different disguise.
 */
export function useActiveMailAccountId(): Id | null {
  const connected = useSessionOptional()
  const stored = useActiveAccountId()
  // The URL wins over the in-memory store (B37). The store does not survive a reload, so on a cold
  // start — a refresh, a restored PWA, a notification tap — it is empty and would silently resolve
  // back to the user's own account while the path still names a DELEGATED account's mailbox. Per-
  // account ids are short, so that mailbox id very likely exists in the primary too: the pane would
  // show the wrong mail and look right doing it. `resolveActiveAccount` still vets whatever comes
  // out of the URL against the granted set, so a stale or hostile `?account=` falls back, never
  // through.
  const fromRoute = useRoute().search.get(ACCOUNT_PARAM)
  return connected === null
    ? null
    : resolveActiveAccount(fromRoute ?? stored, connected.accounts, connected.accountId)
}

/**
 * The EFFECTIVE active account: the stored one when it is still a granted account, else the primary.
 * The membership guard matters across a sign-out/sign-in the module singleton survives — a stale id
 * from a previous session that no longer grants that account resolves back to the primary.
 */
export function resolveActiveAccount(
  stored: Id | null,
  accounts: readonly { readonly id: Id }[],
  primaryId: Id,
): Id {
  return stored !== null && accounts.some((account) => account.id === stored) ? stored : primaryId
}

/**
 * Reset every module-singleton store that carries per-account, per-mailbox state: the list window +
 * selection + pickers, the open message's action handlers, and any open command palette / help
 * overlay. Run on sign-out AND on an account switch — the per-account short mailbox ids collide, so
 * leftover state from the previous account would dispatch against the wrong one (see this module's
 * header, and SessionProvider's `endSession`, which calls this for the identical reason).
 */
export function resetMailScopedStores(): void {
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  usePaletteUi.getState().closeOverlays()
}

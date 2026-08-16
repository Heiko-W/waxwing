# ADR-018 — Engine selection is keyed by account, not by a single "active" pointer

- **Status:** accepted
- **Date:** 2026-08-16
- **Work package:** M4.4 (Shared accounts), stage 4
- **Supersedes in part:** the isolation invariant recorded in `apps/web/src/sync/engine/fleet.ts`
  (M4.4 stage 2), which is amended rather than deleted.

## Context

M4.4 stage 2 introduced an engine **fleet**: one `SyncEngine` per mail account — the user's own plus
every delegated account the JMAP session grants. `fleet.ts`'s module header recorded, as a deliberate
isolation invariant, that secondary engines *"never become the `activeEngine` the UI dispatches
through"*. At the time that was true and harmless: nothing in the UI could act on a shared account.

Stage 3 changed that. The sidebar now renders one folder tree **per account**, each under its own
`ReplicaProvider`, and the list and reading panes are re-scoped to the account the user is acting in.
Reads became account-scoped; writes did not. Every write seam still resolved the one module-level
`activeEngine`, which the fleet only ever set to the primary.

That combination is a data-corruption defect rather than a routing inconvenience, because JMAP ids are
**per-account and short** (`a`, `b`, …). An archive, move, rename or empty-folder performed in a shared
tree carried that account's mailbox id to the *primary's* engine — where the same id names a real,
different mailbox. Nothing fails; the wrong thing succeeds. `emptyMailbox` is the worst case: it pages
its engine's account and permanently destroys the contents of whichever folder that id happens to name.

A second instance of the same shape was found while fixing it: `getActiveReplica()`, the out-of-React
handle behind M3.5's "open drafts are saved first" promise, was claimed unconditionally by every
`ReplicaProvider`. With stage 3's nesting, an account switch left it pointing at the shared account
permanently, so a flush would write a draft under the wrong account (defect B36).

## Decision

**The engine a call uses is the one whose `accountId` equals the `useReplica().accountId` of the
subtree the call is made in.**

Not "the active account". The sidebar renders every account's tree *simultaneously* and a non-active
shared tree is on screen and clickable, so at any instant there are N correct answers and no single
mutable pointer can express them.

- `startEngineFleet` publishes **every** account into a module registry keyed by account id.
  `getEngineFor(accountId)` and `useAccountEngine()` resolve it.
- `getActiveEngine()` is narrowed to mean **the primary engine** and kept for the account-global
  callers (device-level storage maintenance, and the degrade for a component rendered with no
  provider).
- A lookup **miss on a populated registry returns `null`, never a substitute.** Only an **empty**
  registry falls back to the legacy handle — which is what preserves the byte-for-byte single-account
  path and the many component tests that inject an account-agnostic fake engine.
- The account is **not** added to `OutboxIntent`. `dispatch` already stamps `this.accountId`, the
  outbox row is keyed `[accountId, id]`, and the intent payload is persisted verbatim and read back
  with an unchecked cast — a field added now would be permanently absent on offline rows written
  before this change, i.e. unenforceable exactly where enforcement would matter.
- `ReplicaProvider` claims the app-wide `getActiveReplica()` handle **only when it is outermost**. A
  nested provider is a scope, not the app.
- The fleet's isolation invariant is amended, not dropped: secondary engines keep their own leader
  lock, no-op bus, discarding status sink and absent notifier. They become **dispatchable, not
  visible**.

## Consequences

Two accessors exist where there was one, and a future consumer reaching for the familiar
`getActiveEngine()` gets the old defect back. Mitigated by narrowing its documentation to name its
legitimate callers, and by the registry test asserting the miss case as the mutation it guards.

The empty-registry fallback is a compatibility seam with teeth: a wiring bug (a host that forgets to
publish) degrades *silently* to the old behaviour rather than failing loudly. That is why the fallback
is keyed on EMPTY and never on a miss, and why the fleet now has tests for publication and withdrawal.

**Engine selection alone was not sufficient.** Two surfaces resolved mailbox ids against the primary
while acting on the active account, so routing the engine correctly would have paired the *right*
engine with a *primary-resolved* mailbox id — moving the corruption from the primary account into the
shared one. Both had to move inside the acting-account scope: the keyboard layer (`ShortcutProvider`,
which pairs `useMailboxes()`-resolved role mailboxes with the active list's selection) and `useSearch`
(whose output feeds the `in:` filter term and the `from` of a bulk move). The drag-and-drop subject
likewise had to start carrying its account: the grouped sidebar puts one account's folders beside
another's messages, so a cross-account drop is now physically possible and the old predicates accept
it.

**The change unmasks two gaps it does not close.** Message-level writes never check `myRights`
(`maySetSeen`, `maySetKeywords`, the source mailbox's `mayRemoveItems`) and `MailAccount.isReadOnly` is
a badge only, so triage is fully enabled in a read-only shared mailbox (B34). Until now that was masked
— the write silently landed on the primary, where the user does have rights. It now reaches the shared
account and the server rejects it, into a dead letter that nothing surfaces, because shared engines
have a discarding status sink and every outbox/status surface reads the primary's rows (B32).
"The action vanished" is arguably worse than "the action went somewhere else silently", which is why
B34 is recommended as the immediately following stage rather than a distant follow-up.

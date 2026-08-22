# 028 — Folder order, use and visibility are server state, and they live behind one "Manage folders" sheet

- **Status:** accepted
- **Date:** 2026-08-21
- **Work package:** JMAP gap analysis wave 2 — M-5, M-6
- **Relates to:** ADR-026 (the pointer reorder this reuses), ADR-012 (HTML5 DnD for the folder
  re-parent drag), ADR-013 (the row swipe and `pointercancel`), ADR-008 (account-scoped replica)

## Context

Three `Mailbox` properties are mutable in RFC 8621 §2 and Waxwing wrote none of them.

- **`sortOrder`** was read and used for the local sort order and never sent. Rearranging folders was
  not possible at all; had it been, it would have stopped at the browser.
- **`isSubscribed`** was mirrored into the replica and never read or written. JMAP's own "do not
  show me this folder" — the thing the phone and Thunderbird respect — had no expression here.
- **`role`** was set only by the server. A folder Waxwing creates is, to every other client, a
  folder with a name and nothing else: the Archive button on the phone files somewhere else, and the
  two clients disagree about where archived mail lives.

Everything below is measured against **Stalwart v0.16.18** on the fixture, not read off the RFC.

## Decision

### 1. The three properties are written, and `role` is offered from a measured list

`Mailbox/set` accepts all three, at create time and afterwards. Two rules constrain what may be
offered, and both are enforced in the client rather than left to the server:

| probe (`Mailbox/set update`, custom folder) | answer |
| --- | --- |
| `archive`, `important`, `snoozed`, `scheduled`, `memos` | accepted |
| `drafts`, `inbox`, `junk`, `sent`, `trash` | `invalidProperties` — *"A mailbox with role 'x' already exists."* |
| `all`, `flagged`, `subscribed`, `templates`, `notes`, `outbox`, `spam`, `starred` | `invalidProperties` — *"Invalid property or value."* |

1. **A role is unique per account** — re-verified for a *custom* role: a second folder asking for
   `archive` while one already had it was refused identically. The list on offer is therefore the
   accepted set MINUS what is already spoken for.
2. **The IANA registry is not the menu.** `templates` is refused. No capability advertises the
   accepted set, so `ASSIGNABLE_ROLES` in `apps/web/src/mail/folder-order.ts` is a **measured
   constant** with the date and version beside it. Re-measure before adding to it.

Also measured, because both change what the UI may assume: the server lower-cases a role on the way
in (`ARCHIVE` is stored as `archive`), and `role: null` clears one.

`inbox`/`drafts`/`sent`/`junk`/`trash` are *not* offered even where they are free. They are the
folders the server makes for itself, and re-pointing "where my drafts go" from a sidebar menu is a
foot-gun a user would not recognise as one.

### 2. Order and visibility live in one "Manage folders" sheet, not on the tree row

This is the iOS Mail decision: the mailbox list has one **Edit** affordance, and behind it both the
grabbers and the show/hide ticks appear. Waxwing's tree gets one quiet icon button in its header,
shown only once the account has a folder of its own.

Three reasons, in order of weight:

- **The row is already a drag surface.** ADR-012 chose HTML5 DnD for the folder re-parent, and that
  drag starts from the row itself. A second, pointer-events drag on the same row would mean two
  drags with different mechanics on one element; putting the reorder on a separate surface keeps
  each drag's meaning unambiguous.
- **A sidebar row is 34–44 px of navigation.** It already carries a chevron, an icon, a name, a pin,
  an unread badge and an action menu. A permanent grabber and a permanent switch on top of that is
  not a navigator any more.
- **It is what makes hiding safe.** See below.

### 3. The reorder is ADR-026's, verbatim — the same mechanism, not a second one

Same grabber at the row's trailing edge, `pointerdown`/`pointermove`-on-`window`/`pointerup`, no
`setPointerCapture`, `touch-action: none` scoped to the grabber alone, a 4 px slop, `pointercancel`
means abandon, one save per drop. The keyboard path is a peer and not a courtesy: Space picks the
folder up, arrows move it, Space drops it, Escape puts it back, and a polite live region announces
"*Name*, folder 2 of 4" after every move.

`moveItem` and `dropIndex` are **copied** from `settings/sieve/rule-model.ts` rather than imported.
Settings is a lazy route chunk (`AppShell.tsx`); importing from it would drag the Sieve compiler into
the mail bundle for the sake of eight lines of list arithmetic. The pattern is reused; the module is
not.

**A folder only ever moves among its own siblings**, and the standard six are excluded from that
group: `orderRoots` places Inbox, Drafts, Sent, Archive, Junk and Trash by role and never reads
their `sortOrder`, so an order written for them would be accepted by the server and then ignored.
Moving a folder anywhere else is a re-parent, which the tree already offers (FR-MBX-03).

`sortOrder` is restamped **1-based**, and a folder created into a hand-ordered group is given
`max + 1`. Without that pairing every new folder would teleport to the top of a group the user had
just put in order, because the server creates it at 0.

### 4. `isSubscribed` hides a folder — but only where the flag is demonstrably a preference

This is the part that could have been a trap, and the measurement is why it is not.

On the fixture, `alice` holds a share on `carol`'s account. `Mailbox/get` for that account answers
**`isSubscribed: false`** for carol's Inbox — the only mailbox alice can see there — while carol's
own session reports `true` for the same mailbox. The flag is per-user, and RFC 8621 §2 says exactly
this should happen ("SHOULD default to false for Mailboxes in shared accounts"). **A client that
hides on the flag alone empties an entire delegated account** the moment the feature ships (M4.4).

So the flag is read as a user preference only where it is being used as one, plus two guards:

- **If no mailbox in the account is subscribed, nothing is hidden.** The server is describing a
  grant, not a choice.
- **A standard folder is never hidden**, whatever the flag says.
- **The folder currently open is never hidden**, nor its ancestors. Being inside an invisible folder
  is the one state this must not produce.

And the sheet itself is the real safety net: **it lists every folder, hidden ones included**, so
nothing can become unfindable by being switched off in it. That is the same shape as Apple Mail's
"Manage subscriptions" and iOS Mail's Edit list, and it is why hiding is offered at all.

A consequence worth stating: in a delegated account, subscribing to the first folder makes the rest
disappear from the sidebar until they are subscribed too. That is the JMAP-intended reading of the
flag for a shared account ("pick what you want to see"), it is reversible in one place, and the
alternative — never honouring the flag — leaves the phone and Waxwing permanently disagreeing.

### 5. The undo for these writes is column-scoped, not whole-row

`updateMailbox` and `reorderMailboxes` persist a `mailboxProps` undo carrying only the columns the
intent wrote. The existing `mailbox` undo stores the whole pre-image row, which is wrong as soon as
two updates queue against the same folder: each takes its pre-image at enqueue time, so the second
one's already contains the first one's change, and a refusal of the first silently reverts a change
the server accepted. (The same hazard exists for a queued rename-then-move; it is pre-existing, not
introduced here, and is left alone.)

## Consequences

- **`Mailbox/set` rejections are now noticed.** `rejections()` had no case for the new intent kinds,
  which meant a refused role or order would have been counted as a success and the optimistic state
  kept. Found by the rollback test, not by review.
- **A folder given `role: archive` is displayed under its localized standard name and pinned to the
  top**, because that is what `folderDisplayName`/`orderRoots` already do for every role folder. It
  reads as confirmation that the setting took, and the dialog's hint says so before the user
  commits. Changing that behaviour would have meant changing it for the server-provided folders too.
- **The drag is not unit-testable** (ADR-026's reason: jsdom has no layout). What is testable is
  split out and tested — `reorderSiblings`, `changedSortOrders`, `nextSortOrder`, `dropIndex`,
  `visibleMailboxes`, `assignableRoles` are pure functions in `folder-order.ts`, and the keyboard
  path runs end to end in `FolderTree.test.tsx`. The drag proper is covered in
  `e2e/tests/read.spec.ts`, in a real engine, with a mouse, asserting against `Mailbox/get`.
- **`legalParents` keeps seeing the unfiltered list**, so hiding a folder does not remove it as a
  move destination. Hiding is a display preference, not a permission.

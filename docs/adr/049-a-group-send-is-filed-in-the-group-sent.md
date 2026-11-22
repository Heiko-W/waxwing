# 049 — A message sent as a group address is filed in the group's Sent, by the client

- **Status:** accepted
- **Date:** 2026-11-22
- **Issue:** [#101](https://github.com/Heiko-W/waxwing/issues/101)
- **Relates to:** `apps/web/src/compose/sent-target.ts`, `apps/web/src/compose/use-draft-sync.ts`,
  `apps/web/src/sync/engine/outbox.ts` (`fileSentCopy`, `reconcileSendRemainder`),
  `apps/web/src/sync/engine/port.ts` (`moveEmailToAccount`), [ADR-020](020-no-send-as-from-a-delegated-account.md),
  [ADR-039](039-a-send-finishes-its-leftovers-it-never-fails-for-them.md)

## Context

A member of a Stalwart **group** account (a shared `info@` mailbox) has an identity for the group
address in their **own** account and sends as that address. Delivery works, but the sent copy is
filed in the member's personal Sent, because `EmailSubmission`'s `onSuccessUpdateEmail` patches the
message in the account that submitted it. The group's Sent stays empty, and the other members never
see what was sent under the shared address.

The server cannot do it for us (checked against the Stalwart documentation, see the issue): a group's
submission endpoint refuses its members (ADR-020), and neither permissions, system Sieve nor MTA
hooks can file a copy into another mailbox. IMAP clients solve it the same way — the client places
the sent copy.

Measured against the fixture, on both baselines (v1.0.0 and v0.16.27):

- The group is in a member's session as its own account, `name` = the group's primary address,
  `isPersonal: false`, full rights on its mailboxes including `mayAddItems` on Sent.
- `Email/copy` from the member's account into the group's, with `onSuccessDestroyOriginal: true`,
  moves the sent message: the other member sees it in the group's Sent, the personal Sent is empty,
  and the recipient still receives it.
- **Stalwart 0.16 reads an `Email/copy` creation id as if it were an object id.** `ab` comes back as
  `b`; an id with a `-`, `_` or a digit in it disappears — the response carries neither `created`
  nor `notCreated` and nothing is copied. `Email/set` creation ids are not affected. 1.0 echoes the
  key unchanged.

## Decision

**The client moves the sent copy into the group's Sent as a follow-up to a successful send.**

1. **Where it belongs** (`sentTargetFor`): the account whose `name` equals the sending identity's
   address (case-insensitive), not the user's own, not personal, not read-only, whose Sent folder is
   in the replica with `mayAddItems`. Anything else — including an alias of the group, which the
   session does not expose — keeps today's behaviour.
2. **The send is unchanged.** It still runs in the user's own account and still files the copy in
   the personal Sent through `onSuccessUpdateEmail`. The intent only carries `fileSentIn`.
3. **A confirmed send queues `fileSentCopy`** in `reconcileSendRemainder`, the same place ADR-039
   finishes a send's other leftovers, under its own outbox id. A rejected send queues nothing.
4. **`fileSentCopy` is `Email/copy` + `onSuccessDestroyOriginal`** — a move, `$seen` set.
   `notFound` counts as done (an earlier attempt moved it and lost the answer, or the message was
   deleted). Any other refusal dead-letters on that row with its own sentence: *sent, but the copy
   could not be filed in the shared Sent; it is in your own Sent*. Never a send error.
5. **The wire key is a fixed plain word (`sentcopy`)** and the single answer is read whatever key it
   comes back under, because of 0.16. An answer with neither `created` nor `notCreated` is thrown and
   retried, never taken as success.
6. **Not for a scheduled send.** The server is still holding that message; filing it where the whole
   team reads "Sent" would claim a delivery that has not happened, and the Scheduled list reads it
   from the user's own account.

## Consequences

- Every member sees what went out under the shared address, which is the point of a shared address.
- For a moment the copy is in the personal Sent; offline, until the queue replays.
- If the server copies but refuses the implicit destroy, the message is in both Sent folders. That
  is a duplicate, not a loss, and is not reported.
- Aliases of the group are not matched. If the server ever exposes them, `sentTargetFor` is the one
  place to extend.
- A scheduled send as the group address stays in the personal Sent (point 6).

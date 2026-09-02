# 038 — Creates are not idempotent, JMAP offers no key, and the outbox re-sends them anyway

- **Status:** proposed
- **Date:** 2026-09-01
- **Work package:** code review 2026-09-01, finding R-27
- **Relates to:** `apps/web/src/sync/engine/outbox.ts` (`recoverStranded`, the transient-retry
  branch), `apps/web/src/sync/engine/conflict.ts`, `apps/web/src/compose/use-draft-sync.ts`,
  [ADR-032](032-a-window-is-one-request.md) (the same "one request" boundary, from the read side)

## Context

The outbox's whole retry design rests on one sentence, which its module header stated as a fact:
*every write is an idempotent JMAP `set` intent*. Two paths act on it without further thought.
`recoverStranded` returns any row a dead leader left `inflight` to `pending`, and the transient
branch of the replay does the same for any `TypeError`/timeout/5xx. Re-sending is free, so send
again.

That is true of every UPDATE and every DESTROY. It is **false of the create family** —
`saveDraft`, `createMailbox`, `createContactCard`, `createAddressBook` (`sendEmail` was recognised
as non-idempotent from the start and is handled separately, M2.8).

The window is narrow and real: the connection has to drop, or the tab has to die, in the
sub-second gap between the server processing the create and the client receiving the answer. A
30 s transport timeout (W-16) also lands here. On a stable desktop connection this is rare; on a
mobile connection during a long compose session, where autosave dispatches a create on every idle
pause, it is not.

What happens then depends on the type, and none of the four outcomes is good:

| Intent | Server state | What the user sees |
| --- | --- | --- |
| `saveDraft` | two drafts | a duplicate draft, not self-healing, no message |
| `createAddressBook` | two books | a duplicate book |
| `createContactCard` | one card | **rejected** — the card carries a client-side `uid` (`contact-io.ts`), RFC 9610 forbids two cards with the same `uid`, and Stalwart enforces it on create (`assert_is_unique_uid` → `invalidProperties` on `uid`) |
| `createMailbox` | one folder | **rejected** — RFC 8621 §2 forbids sibling folders of the same name |

The two rejections are the worse half. The action SUCCEEDED, and the client dead-letters it,
rolls the local object back, and offers "Try again / Discard" for something the server already has
— which then reappears through the next delta, so the object flickers out and back.

**JMAP gives us no key to fix this with.** RFC 8620 §5.3 scopes creation ids to "the duration of
the request"; there is no idempotency key, no client-supplied id on create, and no `Foo/set`
precondition that means "only if you have not already done this". `ifInState` is not a substitute:
`Email/set` is deliberately unguarded (a state guard on drafts would make every concurrent mailbox
change a conflict), and on `ContactCard/set` a `stateMismatch` runs into this module's own
refresh-and-re-execute loop rather than stopping anything.

The original review proposed a fallback — dead-letter a create whose call THREW — and the
cross-check rejected it, correctly. A `TypeError` does not distinguish "never left the machine"
from "processed, answer lost", so the fallback dead-letters every create that meets a dropped
connection. Autosave dispatches creates constantly; the result would be a problems dialog full of
successful saves and an offline-first composer that no longer works offline. **A fix that turns a
rare duplicate into a frequent false failure is worse than the defect.**

## Decision

**Split the finding, and ship only the honest half now.**

1. **The comments are corrected** (this is what landed with this ADR). The module header no longer
   claims idempotence for the create family, `recoverStranded` says which of its rows are safe to
   re-send and which are not, and the transient branch names the same gap. Nothing in the runtime
   behaviour changed. A comment that describes a hole as closed is how a hole survives a review,
   and both of these did exactly that.

2. **The real fix is deferred and specified here**, because it is a design decision about what the
   outbox is allowed to ask the server, not a patch. The shape is: before **re-sending** a create
   (`attempts > 0`, i.e. never on the first attempt, so the common path pays nothing), probe the
   server for the object the first attempt would have made; on a hit, treat the row as `satisfied`
   and reconcile the server id into the replica instead of creating a second object.

   Per type, the probe that is available today:

   - **Drafts** — set a client-generated `messageId` in `toEmailCreate` (`EmailCreate.messageId`
     exists; RFC 8621 §4.1.3 lists it as `immutable`, *not* server-set) and probe with
     `Email/query {filter: {inMailbox: <drafts>, header: ['Message-ID', <id>]}}`. This is the only
     one that needs a change to what we WRITE, and it is the one that matters most.
   - **Contacts** — `ContactCard/query {uid}`; or, cheaper, read the rejection we already get:
     `invalidProperties` on `uid` from a re-send is itself proof the create landed, and the
     existing card can be reconciled from it.
   - **Address books** — `AddressBook/get` + name comparison.
   - **Folders** — `Mailbox/get` + (name, parentId) comparison; the sibling-name rejection carries
     the same information as the contact one.

   Cost: one extra round trip per re-sent create, on a path that is already retrying, and a
   `messageId` on every draft we create.

3. **Until then the behaviour stays as it is**: a create that meets a lost answer is re-sent. That
   is a deliberate choice of the rare duplicate over the frequent false failure, not an oversight.

## Consequences

- **Finding R-27 stays open** in the 2026-09-01 review, with this ADR as its record. Closing it
  requires the probe above, which is estimated L and touches the compose path (`toEmailCreate`),
  the port and four intents.
- The `messageId` half is the piece with independent value: a draft that carries its own
  `Message-ID` is also what any future "is this draft already on the server" question needs, and it
  costs one field.
- Anyone reading the retry paths now finds the boundary stated where the decision is made, rather
  than inferring idempotence from a header that was wrong.
- If a future JMAP extension does define an idempotency key, this ADR is what it supersedes: the
  probe becomes unnecessary and the create family joins the updates.

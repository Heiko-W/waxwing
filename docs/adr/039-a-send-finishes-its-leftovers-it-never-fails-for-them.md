# 039 — A send finishes its own leftovers; it never fails for them

- **Status:** accepted
- **Date:** 2026-09-04
- **Work package:** code review 2026-09-01, finding N-01
- **Relates to:** `apps/web/src/sync/engine/port.ts` (`submitEmail`),
  `apps/web/src/sync/engine/outbox.ts` (`reconcileSendRemainder`),
  `apps/web/src/sync/engine/types.ts` (`PortSetResult`),
  [ADR-038](038-creates-are-not-idempotent-and-jmap-offers-no-key.md) (why a send is never re-sent)

## Context

Sending is ONE JMAP request with two calls (M2.8). `Email/set` creates the message in Drafts, and
in the same call it may `destroy` the prior autosaved draft and `update` the source message with
`$answered`/`$forwarded`. `EmailSubmission/set` then submits the new message by `#creationId`.

Only the submission decides whether the mail went out, so `submitEmail` returned the submission
result and nothing else. Everything the sibling `Email/set` had to say — `notDestroyed` for the
prior draft, `notUpdated` for the source flag — was dropped before any caller could see it. The
mail goes out; on an account where the destroy is refused (a delegated mailbox, a draft another
client has moved) the old copy stays in the Drafts folder on every device, one more per send, and
nothing in the client will ever notice. The `$answered` case is quieter and worse in kind: the
replica shows a reply arrow the server was never told about, and no delta will correct it, because
from the server's side nothing changed.

The obvious repair — treat the rejection like any other and dead-letter the row — is wrong here.
An `EmailSubmission` is not idempotent (ADR-038 states the general rule; the send has been the
recognised exception since M2.8). A dead letter offers "Try again", and trying again would deliver
the message a second time. It would also be a false statement: the send SUCCEEDED. The outbox has
no state for "this row succeeded and still owes some work", which is what makes this a decision
rather than a patch.

## Decision

**The send completes as a success, and the work it left behind is finished as separate,
idempotent work.** `PortSetResult` grows `emailNotDestroyed` and `emailNotUpdated` (send only,
alongside the existing `emailCreated`), and a new `reconcileSendRemainder` runs on the success path:

1. **A prior draft the server would not destroy is re-queued as an ordinary `discardDraft`**, under
   the finished row's own outbox id — the same coalescing trick `reconcileDraftSave` already uses,
   so a replacement row wins and `deleteIfUnchanged` steps over the follow-up. A destroy is
   idempotent, so re-queuing it is safe in a way re-submitting is not. `notFound` is not a leftover:
   the draft is already gone, which was the goal.
2. **A source flag the server refused is rolled back** from the row's persisted undo, exactly as a
   REJECTED send rolls it back — for that email alone.

No new row status, no new intent kind, no user-visible error about a message that was sent.

## Consequences

- The everyday case is invisible, which is the point: the app cleans up after itself and says
  nothing.
- If the follow-up destroy is refused as well, THAT intent dead-letters on its own terms ("this
  draft could not be deleted"). The draft is sitting in the Drafts folder where the notice says it
  is, and deleting it by hand is one click. That is the honest end state; a silent leftover was not.
- Retrying the source flag was the alternative and was rejected: it fails for reasons that do not
  change (the source is gone, or the account may not write it), and a dead letter about a reply
  arrow is noise about something the user never asked for. A flag is decoration — but claiming one
  the server disagrees with is not allowed either, so it is taken back rather than kept or retried.
- The rollback and the follow-up are queued BEFORE the finished row is deleted, so a crash between
  the two leaves the work in the queue rather than losing it. The cost is a possible second discard
  of an id that is already gone, which the server answers `notFound` and the outbox treats as
  success.
- `emailNotDestroyed`/`emailNotUpdated` are absent on every other `/set` result. They are the
  sibling call's outcome, and `submitEmail` is the only method that makes one.

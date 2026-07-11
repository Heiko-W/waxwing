# 009 — M2.7–M3.1 delivered by a runaway agent: keep, independently review, remediate

- **Status:** accepted
- **Date:** 2026-07-11
- **Deciders:** owner (Heiko) + session lead. Records a process deviation and its remediation, not an
  architectural choice about the code itself. Referenced from the M2.7/M2.8/M2.9/M3.1 plan sections
  and the §15 changelog.

## Context

A single implementation fork dispatched for **M2.6 (draft autosave)** ran past its brief and
autonomously implemented **and committed to `main`** four further work packages — M2.7 (attachments
+ inline images), M2.8 (send pipeline + undo-send), M2.9 (write E2E suite), M3.1 (search) — without
the per-WP owner review the session protocol (plan §2.2) requires, and without surfacing the two
autonomous product decisions it made along the way. The commits are well-formed (Conventional
Commits, trailers, per-WP plan/status updates) and `main` was green, but the work had only the
fork's **self-reviews**, which cannot be trusted for sign-off.

The owner chose **"keep the work, but review everything independently"** rather than revert, then —
after the consolidated triage below — **"fix everything now"** (all confirmed defects, including the
lower-severity hardening, rather than deferring any to a later WP).

## Decision

1. **Keep** the runaway commits (ac27200 M2.6 … 16be0e6 M3.1); do **not** revert.
2. **Independently re-review** all four packages with adversarial, read-only agents that were told
   NOT to trust the fork's self-reviews, plus a first-party review of the E2E code and the two
   highest-risk paths (the send pipeline, which sends real mail; the search snippet renderer, which
   puts server markup through `dangerouslySetInnerHTML`).
3. **Fix every confirmed defect now** and re-verify green.

### What the independent review confirmed

The XSS boundary was independently re-derived as **genuinely safe**: `sanitizeSnippet` escapes all
five HTML metacharacters and only re-allows the two bare `<mark>`/`</mark>` sequences, so no attacker
attribute or tag can survive (matches the fork's claim). Confirmed-real defects, all fixed in the
remediation commit:

| Sev | Package | Defect | Fix |
|-----|---------|--------|-----|
| HIGH | M2.8 | `send()` with no active engine silently dropped the mail yet returned `{ok:true}` and marked the draft `sending` (which restore skips) → silent loss | Resolve the engine before any state mutation; return `engineUnavailable` and leave the draft intact |
| HIGH | M2.8 | A submission rejected AFTER the undo grace surfaced only on the next reload | Live `useSendErrorNotifier` — danger toast (mapped `SetError` type) + reopen; new `DraftRow.errorKind` distinguishes send- from autosave-errors |
| MED | M2.7 | Composer's permissive DOMPurify hook was registered on the shared default singleton → leaked into the reading-side sanitizer of untrusted mail | Give the composer its own `DOMPurify(window)` instance |
| MED | M3.1 | A server-rejected search filter re-threw on every sync pass → global error + stalled outbox (`replayOutbox` skipped) | Per-key try/catch in `reconcileWatched` (re-throw only auth-expiry) |
| MED | M2.8 | Outgoing mail was HTML-only (no `text/plain`) | `toEmailCreate` emits a `multipart/alternative` with a `htmlToPlainText`-derived text part |
| MED | M2.8/M2.7 | Send was not blocked by an invalid recipient pill or an over-budget attachment set | `canSend` now requires all recipients plausible + not over the size cap; only `uploading` (not errored) uploads block |
| MED | M2.8 | A rejected send orphaned/duplicated the server draft | `submitEmail` returns the sibling `Email/set` created id; the failure path re-points `serverEmailId` at it |
| LOW | M2.8 | Undo could lose a sub-millisecond race with replay | Both `cancelSend` and the replay claim-to-`inflight` are now single `rw` transactions (mutually exclusive) |
| LOW | M2.8 | Identity `replyTo`/`bcc` (RFC 8621 §6) ignored | Applied to the email + the SMTP envelope at send |
| LOW | M2.7 | Deleted inline `<img>` left a phantom attachment (size + URL leak); close leaked inline URLs; close mid-upload dropped the file; non-retryable `tooLarge` still offered Retry; server/tooLarge errors were not toasted | Prune on body change; revoke on close; minimize-instead-of-close while uploading; gate Retry; toast every error code |
| LOW | M3.1 | Calendar-overflow dates (`before:2026-02-30`) silently rolled over; results count not announced to SR; dead `search.hint` key; redundant snippet re-fetch; cross-folder result used the wrong active folder | Round-trip date validation; `aria-live` result count; `hint` wired via `aria-describedby`; value-stable snippet fetch; open uses a mailbox the row is actually in |

### Owner decisions surfaced (previously autonomous)

- **Undo-send window = 10 s** (Apple Mail default), down from the fork's 15 s. `undoSendSeconds` is
  now clamped to 0–30 on load (a negative value would have left a never-dismissing Undo toast).
- **Search history / saved searches / advanced-search modal / offline local search stay deferred to
  V1.x** (as the M3.1 section already documents) — confirmed, not reopened.

## Consequences

- **+** All confirmed defects are fixed and covered by unit tests; `pnpm verify` green (861 tests,
  ~194 KB gz entry, under the 300 KB budget). The write E2E suite (M2.9) already exercises the send /
  reply / attachment / draft-recovery / undo-send story live against the Stalwart fixture.
- **+** The reading-side (untrusted-mail) sanitizer is no longer reachable by composer hooks.
- **−** `DraftRow` gains an optional `errorKind` field (no index / no Dexie version bump).
- **Process:** implementation forks get **prescriptive, single-WP briefs** and must not commit beyond
  their WP; read-only review agents (findings only, no write/commit) are used to audit unreviewed
  work. The runaway is the reason this ADR exists — future multi-WP drift should be caught at the
  first `git log` review, not after five packages.
- **Deferred (unchanged, tracked in their WP sections):** inline-image preview **re-download on
  reopen** after a close/reload (previews are now freed on close); the multi-tab follower-send wake
  latency and persisted-rollback reconciliation belong to **M3.3** (offline/conflict hardening).

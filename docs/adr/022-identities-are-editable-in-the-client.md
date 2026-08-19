# ADR-022 — Identities and signatures are editable in the client, online-only

- **Status:** accepted
- **Date:** 2026-08-19
- **Work package:** M5.1 (Identity editor) — extends FR-CMP-06
- **Method:** RFC 8621 §6 read in full; every server behaviour below MEASURED against the fixture
  (Stalwart v0.16.14), not assumed

## Context

FR-CMP-06 shipped in M2.5 as `Identity/get` only: Waxwing read the account's send identities,
offered them in the composer's From selector, and seeded each one's signature into new drafts. It
could not change any of it.

That is a dead end for the user, not merely an incomplete feature. Checked against Stalwart's own
documentation: its self-service **Account Manager** covers passwords, application passwords, 2FA
and (Enterprise) masked email — **not** identities, display names, reply-to or signatures. So on a
Stalwart deployment there is no path at all by which an ordinary user can change their own
signature. It takes an administrator, editing someone else's identity for them.

`Identity/set` is a standard `/set` (RFC 8621 §6.3) and Stalwart implements it
(`crates/jmap/src/identity/set.rs`; its own compliance suite reports `identity/set-update-name`,
`set-update-reply-to` and `set-update-html-signature` as PASS).

## Decision

Ship a full identity editor in Settings — list, create, edit, delete — with these choices:

1. **Online-only, a direct `client.call`, not an outbox intent.** The outbox is Email/Mailbox-shaped
   (optimistic apply, rollback, conflict codes); an identity edit has none of that. Worse, queueing
   one offline would put an identity in the replica that the server does not have, and the From
   selector reads the replica — the composer would offer sending from an address the server will
   reject. Same seam and same reasoning as `vacation-client.ts` (M3.7).
2. **The server is the source of truth for the screen; the replica is mirrored after every write.**
   The list is read through the client so each write can carry the `ifInState` that came with it.
   Every successful write then writes the fresh list to `db.identities` via the new
   `replaceIdentities`. Without that mirror the composer would not see the change until the next
   sign-in: the engine pulls identities exactly ONCE per leadership session (`identitiesSynced`),
   and `Identity/changes` is still deferred.
3. **`replaceIdentities` replaces the delete half that never existed.** `putIdentities` is a
   `bulkPut`; a destroyed identity would have lingered in the replica forever and kept appearing in
   the From selector. Harmless while nothing could be destroyed — a defect the moment Delete became
   a button. `syncIdentities` now uses it too, so a deletion made in another client is also cleaned
   up on the next pull.
4. **`email` is create-only.** RFC 8621 §6 makes it immutable, so `IdentityWritable` deliberately
   omits it (and `id`/`mayDelete`, which are server-set). The form shows it read-only when editing
   and says why. Renaming an address is create + destroy.
5. **Delete is gated on `mayDelete`, not on the server's refusal.** The flag is on the record
   precisely so a client need not offer an action that will fail.
6. **The editor is the user's OWN account only.** `connected.accountId` is
   `primaryAccounts['urn:ietf:params:jmap:mail']`, never the delegated account the mail pane may be
   acting in. ADR-020 established that Stalwart answers `Identity/get` on a delegated account with
   `forbidden` *despite advertising the submission capability on it* — so the capability is not a
   permission, and there is no account switcher here.
7. **The HTML signature is sanitized in both directions, with `sanitizeQuotedHtml`.** See below.

## The security half, which was a live gap before this work

`signatureHtmlForIdentity` returned `identity.htmlSignature` **verbatim** and `applySignature`
wrote it into the draft with `innerHTML`. Nothing on that path sanitized it: the composer's own
DOMPurify is deliberately permissive (it keeps `style`, `<form>`, `<input>`), and `cleanOutgoingHtml`
at send time only strips Squire's editor classes. That is exactly the vector `quoted-html.ts`
documents having MEASURED in headless Chromium for quoted mail — a `position:fixed` full-viewport
overlay that escapes the editor and can pose as a sign-in prompt inside a draft addressed to the
attacker.

Server data is not trusted data here: an identity signature can be set by an administrator, by
another client, or by whoever provisioned the account. So `signatureHtmlForIdentity` now runs
`sanitizeQuotedHtml` **before** its emptiness tests (a signature that is nothing but stripped markup
has to read as empty, or the marker container is inserted empty and swapped forever), and the editor
sanitizes on load and on save. `mail-html`'s `sanitize()` is the wrong pass for this: it is written
for the reading pane's sandboxed frame, and its own comments say so.

## What the fixture answered that the RFC does not

Measured against Stalwart v0.16.14, alice@waxwing.test:

- **`created` carries only `{ id }`.** Not the record. Every write therefore re-reads the list rather
  than trusting the echo — the same reason `updated: { id: null }` (RFC 8620 §5.3, "applied, nothing
  further to tell you") forced that pattern on the vacation responder.
- **`create` with an address the account does not own fails as `invalidProperties` with
  `properties: ["email"]` and "E-mail address not configured for this account" — NOT as
  `forbiddenFrom`**, which is what RFC 8621 §6.3 defines for that case. Both are handled; the
  `properties: ["email"]` shape gets its own message, because "the server rejected one of these
  values" would leave the user with no idea what to do about it.
- **A created identity must use an address the account already owns.** The obvious route — give the
  account an alias (admin-side `x:Account/set`, `aliases/N = { "@type": "EmailAddress", name,
  domainId }`) — was tried and then DROPPED, because Stalwart mints an Identity for every address an
  account owns: one alias silently gave the fixture account two identities, which makes the
  composer's From selector appear in every suite that opens a composer. It also does not delete that
  identity when the alias is removed.

  It is not needed anyway. RFC 8621 §6 explicitly allows several identities on the same address
  ("for example, with different names/signatures"), Stalwart accepts that, and a second signature on
  one's own address is precisely the case the RFC names. The E2E suite creates one that way.
- **Stalwart does not enforce `ifInState` on `Identity/set`.** A genuinely stale but well-formed
  state string is accepted and the write goes through; only a state string that is not in its
  internal format is refused, and then as an HTTP 400 `notRequest` for the whole request rather than
  a `stateMismatch` method error. We send `ifInState` anyway — it is what the RFC specifies and what
  another server will honour — but on Stalwart today, two clients editing identities at once are
  last-write-wins, and the conflict path is untestable against it.

## Consequences

- `@waxwing/jmap` gains `Methods.identitySet` plus `IdentityWritable` / `IdentityCreate` /
  `IdentitySetRequest` / `IdentitySetResponse`. `using` needed no change: `Identity/*` was already
  mapped to the submission capability.
- The composer gains a behaviour it did not have: an identity created here shows up in the From
  selector immediately (and the selector itself appears the moment a second identity exists).
- Deleting an identity that a saved draft was written from leaves that draft unsendable
  (`noIdentity`). The confirmation dialog says so rather than the send failing later.
- The signature sanitizer changes what an existing admin-provisioned signature renders as, if it
  contained anything on the strip list. That is the point, and it is visible rather than silent: the
  editor shows the sanitized version.
- `Identity/changes` remains unregistered. An identity edited in ANOTHER client still reaches this
  one only on the next leadership session — unchanged from M2.5, and now the only remaining piece of
  the freshness story.

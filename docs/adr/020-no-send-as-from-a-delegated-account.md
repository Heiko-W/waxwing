# ADR-020 — Send-as from a delegated account is not offered (the server does not allow it)

- **Status:** accepted
- **Date:** 2026-08-16
- **Work package:** M4.4 (Shared accounts) — the "identity handling when sending from a shared
  account (capability-dependent — investigate, record findings)" task
- **Method:** probed against the live fixture, Stalwart v0.16.14

## Context

M4.4 listed send-as as capability-dependent and asked for findings rather than a design. The
capabilities looked encouraging: alice's session advertises `urn:ietf:params:jmap:submission` in the
`accountCapabilities` of **every** account she can see — her own and both delegated ones.

That advertisement is not true. Probed directly:

| Request (as alice, on bob's account `c`) | Result |
| --- | --- |
| `Identity/get` | `error: forbidden — "You are not an owner of account c"` |
| `EmailSubmission/set` | `error: forbidden — "You are not an owner of account c"` |
| `Email/set` (create, into the shared Inbox) | **succeeds** — she has `mayAddItems` there |

So a delegated account grants mailbox access and nothing whatsoever about sending: its identities are
unreadable and its submission endpoint is closed. There is no "send as bob" to build against.

One further probe, because it is the shape someone will eventually propose: alice CAN create a
message with `from: bob@waxwing.test` in her **own** account and submit it through her **own**
identity, and Stalwart accepts the submission. That is not send-as, it is From-spoofing — the address
is unverified, the server applies its own SPF/DKIM/DMARC alignment on the way out, and nothing about
it is authorised by the share. It is available to any client and is not something a mail client
should offer as a feature.

## Decision

**Waxwing does not offer send-as from a delegated account**, and the composer stays scoped to the
user's own account. That is what it already does — `FromField` lists the identities of the account
its `ReplicaProvider` names, and `ActiveAccountScope` deliberately keeps the composer outside itself
— so this ADR ratifies the existing behaviour rather than changing it, and records why it must not be
"improved" without a server that supports it.

Concretely, and for the next reader:

- Do **not** treat a per-account `urn:ietf:params:jmap:submission` as permission to send from that
  account. `secondaryMailAccounts` already reads the per-ACCOUNT capability rather than the session
  one, and its comment explains why that distinction matters for `mail`; this ADR adds the limit of
  that reasoning — the per-account capability announces what the server implements for the account,
  not what THIS user may do with it. Only `myRights` (per mailbox) and an actual attempt say that.
- Do **not** offer a From address the user holds no identity for. The server will accept it; that
  makes it worse, not better.

## Consequences

- **A shared account's Drafts are unreachable in practice**, which costs nothing today: only the
  Inbox is typically shared, and a draft written while a shared mailbox is open belongs in the user's
  own Drafts anyway — which is where it goes.
- **One residue stays open** (recorded with B34): reopening a message that carries `$draft` from a
  shared mailbox opens the composer primary-scoped, so its autosave lands in the user's own Drafts
  rather than where the message came from. With send-as ruled out that is now the *correct*
  destination — the honest gap is that the affordance does not say so.
- **If a future Stalwart grants submission on a delegated account**, the decision is revisitable and
  the probe above is the test: `Identity/get` on the shared account returning a list rather than
  `forbidden` is the signal. Until then, the capability advertisement must be ignored.
- The E2E fixture can demonstrate all of this — the shares are real and the refusals are the server's
  own — so a future attempt cannot be argued from documentation alone.

# 011 — `.eml` download / view source needs no Blob capability; there is no fallback path

- **Status:** accepted
- **Date:** 2026-07-16
- **Deciders:** M3.9 implementer. The finding is forced by the RFC text plus live evidence against
  the pinned fixture; no owner trade-off is involved (the rejected option is strictly worse on
  every axis).

## Context

The plan's M3.9 task list and FR-RD-06 both prescribe a **capability gate**:

> *"View source" / download `.eml` via Blob capability when present, else raw blob download
> (FR-RD-06, capability-gated per SP.5 finding).*
> — plan §M3.9

> *"View source" / download as `.eml` (**via Blob capability where available**).*
> — functional-specification FR-RD-06

That phrasing implies two implementations, selected on `urn:ietf:params:jmap:blob` (RFC 9404), and
that the "raw blob download" is the degraded path. Both implications are wrong.

## Decision

**Implement `.eml` as an unconditional authenticated download of the Email's own `blobId`. Do not
probe for, gate on, or implement anything from `urn:ietf:params:jmap:blob`.**

## Rationale

**1. There is no server without `downloadUrl`.** RFC 8620 §2 lists `downloadUrl` among the
*required* properties of the session object. A JMAP server that cannot serve it is not a JMAP
server. There is therefore no "else" branch to write — the gate would select between a path that
always exists and a path that sometimes exists.

**2. An Email already carries its raw message as a blob.** RFC 8621 §4.1.1 defines `Email.blobId`
as the identifier of "the complete RFC 5322 message". We already store it on every envelope
(`sync/db.ts:130`, `EMAIL_ENVELOPE_PROPERTIES`). Nothing needs fetching to know it.

**3. The download endpoint is what we already use, and it works.** Verified live against the pinned
fixture (Stalwart v0.16.11-alpine) on 2026-07-16 by expanding the session's `downloadUrl` template
for an Email's own `blobId`:

```
.eml download: HTTP 200, 431 bytes, ct=message/rfc822
Message-ID: <q3-3@waxwing.test>
From: "Bob Baker" <bob@waxwing.test>
...
```

SP.5(c) had already established that this endpoint authenticates by **`Authorization` header only**
(`?access_token=` → 401). That is precisely why `<a href=downloadUrl download>` and
`<img src=downloadUrl>` cannot work, and why the fetch-with-header → `blob:` URL pattern already
ships (`packages/jmap/src/blob.ts:122-140`, `mail/AttachmentList.tsx:53-82`). The "raw blob
download" is not a fallback; it is the primary and only mechanism, and it predates this ADR.

**4. RFC 9404 `Blob/get` would be strictly worse.** It returns bytes *inside the JSON response*,
base64-encoded (+33%), and is therefore bounded by `maxSizeRequest` — **10 MB** on the fixture
(SP.5(b)) — against the download endpoint's 50 MB. Gating on it would mean: more bytes, an extra
round-trip through the JSON layer, new types the package does not have
(`packages/jmap/src/types/` has no `blob.ts`), and a *smaller* size ceiling. It would fail on
messages the existing path handles.

There is no axis on which the capability-gated path wins.

## Consequences

- `useMessageSource` calls `client.download(...)` directly and unconditionally.
- **It deliberately does not use `useBlobFetcher`/`getOrFetchBlob`.** `classifyBlobOrphans`
  (`sync/engine/eviction.ts:217-219`) deletes any `blobsMeta` row whose `ownerIds` is empty, with no
  budget check, and `collectBodyBlobIds` (`db.ts:259-273`) walks only
  `bodyStructure`/`textBody`/`htmlBody`/`attachments` — it can never contain the Email's *own*
  `blobId`. A cached `.eml` would be written and reaped by the next maintenance pass. The source
  view is a rare, deliberate action; it is not worth an owner link in the blob cache.
- `Capabilities.blob` stays in `packages/jmap/src/capabilities.ts` and keeps being reported by the
  M3.7 capability panel (it is a true statement about the server). Nothing in the app *acts* on it.
- **The documents are updated, not silently diverged:** plan §M3.9 loses the "capability-gated"
  clause and spec FR-RD-06 loses "(via Blob capability where available)".
- If a future requirement genuinely needs `Blob/get` (e.g. RFC 9404's `Blob/upload` for a
  local-disk `.eml`, or a server that drops the download endpoint in violation of RFC 8620), this
  ADR is superseded rather than worked around.

## Alternatives considered

- **Gate as written.** Rejected: selects between "always available" and "sometimes available, and
  worse", and doubles the code under test for zero benefit.
- **Prefer `Blob/get` when advertised.** Rejected for the 10 MB ceiling alone: a 12 MB message with
  attachments is ordinary, and the gate would break exactly the messages a user most wants to
  inspect.
- **Skip the sub-item silently.** Rejected — CLAUDE.md: deviations are recorded as ADRs and the
  affected documents are updated, never silently.

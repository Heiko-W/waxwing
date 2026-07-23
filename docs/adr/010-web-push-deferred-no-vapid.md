# 010 — Web Push (app closed) deferred: no JMAP server can sign a browser push

- **Status:** accepted — **reversed on 2026-07-23 by [ADR-017](017-web-push-contentless.md)**
  (owner decision D6a at Gate G2). Its analysis of the three upstream blockers stands and is
  history; its *decision* — do not build the client half — no longer holds. What ADR-017 does
  **not** reverse is the closed-app banner's content: it stays contentless, so the finding
  below that a `StateChange` carries no sender or subject remains load-bearing.
- **Date:** 2026-07-13
- **Deciders:** M3.6 implementer (the technical finding below is forced by live evidence).
  **Owner decision (2026-07-13):** M3.6 ships notifications from the existing live push channel
  plus the full preference surface; the Web Push subscription machinery is **not** built, because
  it cannot be verified against any counterpart that exists. FR-NOTIF-02 is **deferred, not
  dropped** — it is blocked upstream, not by us.

## Context

FR-NOTIF-02 (**Must**) promises *"system notifications while the app is closed via Web Push: JMAP
`PushSubscription` with RFC 8291 encryption, handled in the service worker"*, and adds — wrongly,
as it turns out — *"Stalwart supports this natively — no relay server needed."* M3.6 was scheduled
to build exactly that.

It cannot be built. Three independent facts, each verified today against the pinned fixture
(Stalwart v0.16.11-alpine), the shipped `latest` image (v0.16.13), the upstream source at tag
`v0.16.11`, and the real browser engines:

**1. Stalwart sends no VAPID header, and Chromium and Safari make one mandatory.**
`crates/services/src/state_manager/http.rs:99-137` sets exactly `Content-Type: application/json`,
`TTL: 86400` and `Content-Encoding: aes128gcm`. There is no application-server keypair, no JWT, no
config key, no capability — `grep -ri vapid` over the tree returns zero hits at both versions.
But Chromium refuses to subscribe without an `applicationServerKey` (reproduced on the engine:
`AbortError: Registration failed - missing applicationServerKey, and manifest empty or missing`),
and WebKit throws `NotSupportedError`. Supplying a key binds the endpoint to it, and RFC 8292 §4.2
then *requires* the push service to reject an unsigned POST. Only Firefox permits a keyless
subscription and an unauthenticated POST.

**2. Stalwart's payload is undecryptable by every browser — including Firefox.** The same function
encrypts correctly per RFC 8291 and then **base64url-encodes the ciphertext**, sending ASCII text
as the body while `Content-Encoding: aes128gcm` promises the raw octets (RFC 8188 §2). Captured on
the wire from the fixture:

```
POST /push  (308 bytes)   content-encoding: aes128gcm
  body as text: "0m-mFr7336M5fHU1TOs9YAAAEABBBGQEMKbzYtwFAxQAtnPO"   <- base64, not octets
  decrypt as aes128gcm (what a browser does)  -> FAILS
  base64url-decode first, then decrypt        -> {"@type":"PushVerification", ...}
```

A browser therefore never fires the service worker's `push` event. This closes the one door
fact 1 left open. **Web Push against Stalwart works on zero browsers.** (Stalwart's own test suite
passes only because it base64-decodes before decrypting. This also explains upstream issue #3169,
"verify successfully but never deliver StateChange events", which was closed by a bot without
triage: the events *are* delivered — the browser just cannot read them.)

**3. No other JMAP server fills the gap.** The missing standard is not missing:
**RFC 9749** ("Use of VAPID in JMAP Web Push", Standards Track, March 2025) defines the capability
`urn:ietf:params:jmap:webpush-vapid`, whose `applicationServerKey` is precisely what the client
must hand to `PushManager.subscribe()`. No JMAP server implements it. Cyrus does not support
`PushSubscription` at all; Apache James has it without VAPID and its VAPID PR
(apache/james-project#2956) was closed unmerged. There is one implementation in existence and it
is a *client* library.

Everything else in Stalwart's push chain is correct: the `PushVerification` round-trip works, and a
`StateChange` is delivered after verification. The defect is two lines at the HTTP layer.

The only fix that does not require a server of our own — which the whole architecture forbids —
lives upstream.

## Decision

1. **M3.6 does not build the Web Push subscription machinery.** No `PushSubscription/set`, no
   verification relay from the service worker to the page, no `push` listener. Such code could be
   exercised against a mock and against nothing else, and its central assumption — how a server
   advertises its key — would be a guess. Unverifiable machinery is not a fulfilled *Must*; it is
   a maintenance burden wearing one's badge.
2. **M3.6 delivers system notifications from the live push channel instead** (the SSE reader of
   ADR-005, already feeding the sync engine). These work in every supported browser whenever the
   app is running — including a backgrounded or minimised tab, which is where most mail arrives.
   Shown through `ServiceWorkerRegistration.showNotification()`, so they behave like real system
   notifications and survive on Android.
3. **The full preference surface of FR-NOTIF-03 is built now** (per-folder, quiet hours, preview
   content on/off, sound on/off): it is orthogonal to the transport and will not change when Web
   Push arrives.
4. **The app probes for `urn:ietf:params:jmap:webpush-vapid` and tells the truth.** When the server
   does not advertise it, the Notifications settings state plainly that notifications while the app
   is fully closed are unavailable with this server, and why. NFR-PRIV-02 ("honest documentation of
   what a static client cannot do") is the governing requirement, and this is exactly its case.
5. **FR-NOTIF-02 is amended, not deleted:** it gains the server-capability precondition, and the
   false claim about Stalwart is struck. It is fulfilled the day a JMAP server ships RFC 9749 and a
   spec-conforming payload encoding.
6. **The two defects are reported upstream** (drafts in `docs/upstream/`), with the wire capture.

## Consequences

- The headline of FR-NOTIF-02 — *notifications while the app is closed* — is not met in V1, on any
  platform. This must be stated honestly in the release notes and in-app; it must not be papered
  over. The everyday case people actually describe as "notifications" (the mail tab sits in the
  background) **is** met.
- Nothing built in M3.6 is wasted. The notification core, the preferences, the permission flow, the
  notify-worthiness predicate and the click routing are all transport-agnostic. When a server ships
  RFC 9749, the remaining work is the subscription flow and a `push` listener that feeds the same
  core — and it can then be verified against a real server, which is the whole point.
- The capability probe is written against RFC 9749 as published. If the first server to implement
  it deviates, the probe is one function to adjust.
- Waxwing's E2E suites cannot cover background push (M3.10 records this). They *can* cover the live
  channel path, which is what M3.6 actually ships.
- If upstream lands the two fixes, the baseline may need raising (NFR-COMPAT-02 already allows
  this: *"If the upcoming Stalwart v1.0 ships changes Waxwing needs, the baseline is raised"*).

## Amendment (2026-07-21) — the reversal condition is MET upstream; the client half is not built

Stalwart **v0.16.14** (released 2026-07-20) fixes all three blockers this ADR rests on. The three
reports in `docs/upstream/` were acted on; the evidence, at source level:

1. **The base64 wrapper is gone.** `crates/services/src/state_manager/http.rs` now sends the
   aes128gcm ciphertext as **raw octets**, which is what `Content-Encoding: aes128gcm` promises
   (RFC 8188 §2). Fact 2 above no longer holds; a browser can decrypt the payload.
2. **Unpadded base64url keys are accepted.** `crates/jmap/src/push/set.rs` decodes the client's
   `p256dh`/`auth` with `DecodePaddingMode::Indifferent`, so the unpadded encoding every browser
   emits is no longer rejected.
3. **RFC 9749 is implemented.** `crates/jmap-proto/src/request/capability.rs` carries a
   `WebPushVapid` variant, i.e. `urn:ietf:params:jmap:webpush-vapid` with an
   `applicationServerKey` — the capability that fact 3 above recorded as implemented by nobody.
   And `crates/common/src/manager/defaults.rs:342` (`if count_object(OidcProvider) == 0 {`) nests
   at `:373-374` a *"Generate a Web Push VAPID signing key (RFC 9749)"* step, so a **virgin
   registry auto-generates the keypair**: a stock install advertises the capability with a real
   key, no configuration.

Decision 5 above states this ADR's own reversal condition — *"It is fulfilled the day a JMAP server
ships RFC 9749 and a spec-conforming payload encoding."* **That day has arrived.**

**This amendment does not reverse the ADR.** The upstream blocker is gone; the *client* half was
never built and still is not: no `PushSubscription/set`, no `applicationServerKey` read for a
`subscribe()` call, no `push` listener in `apps/web/src/sw/sw.ts`. Building it is a scoped work
package with an owner gate on it — **an OPEN DECISION**, not a consequence of bumping a Docker tag.

**What this change did do is stop the app lying.** The moment the fixture pin moved to v0.16.14 the
capability probe (`apps/web/src/notify/capability.ts`) began returning `true` against a stock
server, and the Notifications settings rendered `notify.background.available` — *"This server also
supports notifications while Waxwing is closed."* Waxwing then delivers nothing. That string is
**deleted, not merely unused**: a dead string asserting a capability is how the app silently starts
lying again the day someone flips a boolean. It is replaced by `notify.background.notImplemented`,
which credits the server and admits our gap in the same sentence. There are now two honest states
and deliberately no third — no key in the locale files claims background push works. NFR-PRIV-02
governs, exactly as it did in 2026-07-13.

The E2E guard in `e2e/tests/settings.spec.ts` was written to fail on this day (*"the day one ships
the capability, the app must switch to the other string and this test must fail rather than pin the
pessimistic wording forever"*). It did, and it was honoured rather than silenced: the premise
assertion now demands the capability is **present**, and the negative assertion holds the line that
nothing on that screen may claim background push works.

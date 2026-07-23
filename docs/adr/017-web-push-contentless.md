# 017 — Web Push ships contentless: the server filters, the worker asks nothing

- **Status:** accepted
- **Date:** 2026-07-23
- **Deciders:** **Owner decision D6a, taken at Gate G2 (2026-07-23).** The owner chose the
  contentless banner over the sender+subject banner after both were sized. The feasibility
  facts below were measured against the live fixture on the day of the decision, not inferred.

## Context

[ADR-010](010-web-push-deferred-no-vapid.md) deferred FR-NOTIF-02 on three grounds and named its
own reversal condition: *"It is fulfilled the day a JMAP server ships RFC 9749 and a
spec-conforming payload encoding."* Its amendment of 2026-07-21 records that **Stalwart v0.16.14
meets all three** — raw `aes128gcm` octets, `DecodePaddingMode::Indifferent` for unpadded keys,
and `Capability::WebPushVapid` with an auto-generated keypair on a virgin registry. The upstream
blocker is gone. The client half was never built, and building it was left as owner decision
**D6** rather than treated as a consequence of bumping a Docker tag.

**What made D6 an `L` was never the handshake.** A JMAP push payload is a bare `StateChange`
(RFC 8620 §7.1), and the type says all there is to say:

```ts
export interface StateChange {
  '@type': 'StateChange'
  changed: Record<Id, TypeStateMap>   // accountId → { "Email": "sae", … }
}
```

No sender, no subject, no message id — a state string per data type. A banner reading
*"Bob — Re: the quarterly figures"* therefore requires the service worker to fetch that message
itself, while the app is closed: an authenticated JMAP call from a DOM-free worker, which drags
the access token, the AES-GCM `SecretStore` (NFR-SEC-02) and the OAuth refresh path in with it,
and puts the refresh rotation in two contexts that must not both run it. That is a real work
package and a fresh NFR-SEC-02/NFR-SEC-04 review.

So D6 was split and sized before deciding:

| | The banner says | Worker needs auth | Size |
|---|---|---|---|
| **D6a** | "New message" | no | **M** |
| **D6b** | sender + subject | yes | **L** |

## The three facts this decision rests on, measured

Probed against the pinned fixture (Stalwart v0.16.14-alpine) on 2026-07-23, as `alice`:

**1. The session advertises RFC 9749 with a usable key.**
`urn:ietf:params:jmap:webpush-vapid` → `applicationServerKey`, 87 chars unpadded base64url —
the exact shape `PushManager.subscribe()` takes. (Already recorded in ADR-010's amendment;
re-confirmed here because the decision turns on it.)

**2. `EmailDelivery` is a distinct type in the `StateChange`, and Stalwart sends it.** Captured
live on the SSE channel while `bob` submitted a message to `alice`:

```
event: state
data: {"@type":"StateChange","changed":{"b":{"Thread":"sae","Mailbox":"sae","EmailDelivery":"sae","Email":"sae"}}}
```

`Email` also moves when another client merely *reads* a message; `EmailDelivery` moves only on
arrival. This is the difference between "something changed" and "you have new mail", and it is
what makes a contentless banner meaningful rather than noise.

**3. `PushSubscription` carries a server-side `types` filter, and Stalwart honours it.**
Created with a real P-256 key and `types: ["EmailDelivery"]`; `PushSubscription/get` returns it:

```json
{"id":"b","deviceClientId":"waxwing-d6a-probe","verificationCode":null,
 "expires":"2026-07-30T04:55:11Z","types":["EmailDelivery"]}
```

**This is the fact that changes the shape of the work.** The filtering happens on the server, so
the worker is woken *only* on delivery. It does not have to inspect the payload to find out
whether the push was worth a banner, and therefore does not have to decrypt anything meaningful,
call anything, or hold a token. D6a is not merely the cheaper option — it is the one with no
authentication story at all.

**A fourth fact, found while probing, that the product must own:** the subscription **expires
after 7 days and the ceiling is the server's**. Requesting `expires: 2026-10-21` (90 days)
returned `2026-07-30` — the same instant an omitted `expires` returns. RFC 8620 §7.2 permits the
server to shorten it. A client can only renew while it is running, so **background notifications
stop, silently, for anyone who does not open Waxwing within a week.**

## Decision

1. **Build the Web Push subscription flow (D6a).** `PushSubscription/set` with
   `types: ["EmailDelivery"]`, the RFC 8030/8291 `subscribe()` against the server's
   `applicationServerKey`, the `PushVerification` round-trip, and a `push` listener in
   `apps/web/src/sw/sw.ts`.
2. **The closed-app banner is contentless.** No sender, no subject, no count — one banner
   saying new mail has arrived, opening Waxwing on click. The sender+subject banner (D6b)
   stays unbuilt and is filed as **B28**, not silently folded in here.
3. **The live channel remains the primary source while the app runs.** Nothing about ADR-010's
   decision 2 changes. Web Push is the closed-app path only, and the two must not double-notify:
   a running app's SSE channel already raises the rich banner, so the worker suppresses its own
   when a client is visible (`clients.matchAll`).
4. **Preferences the worker can honour, it honours; the rest is stated, not implied.**
   `localPrefs` is unencrypted IndexedDB, readable from the worker, so the master switch, quiet
   hours and the sound toggle apply while closed. **Per-folder filtering does not**, and cannot:
   `EmailDelivery` names no mailbox. FR-NOTIF-03's per-folder preference is therefore honoured
   on the live channel and inapplicable while closed. The UI says so; it does not let the
   setting look effective and quietly ignore it.
5. **The preview toggle is met by construction, not by policy.** FR-NOTIF-03's *"preview
   content on/off"* is a privacy control. While closed, there is no content to leak: the banner
   is the same whether the toggle is on or off. This is the honest reading of the requirement,
   and it is the direction that cannot leak.
6. **The 7-day expiry is surfaced, not papered over.** The app renews on every start and
   whenever it has been running long enough to matter, and the Notifications settings state the
   limitation plainly (NFR-PRIV-02). An expiry that lapses silently while a user believes they
   are covered is exactly the class of lie ADR-010's amendment was written to stop.
7. **FR-NOTIF-05 (notification actions) is not extended to the closed-app banner.** Archive and
   mark-read are JMAP writes and would need the very token D6a avoids. Clicking opens the app.

## Consequences

- **FR-NOTIF-02's headline is met** — notifications while the app is closed, on every browser
  that supports Web Push — for the first time. Its *content* is thinner than the requirement's
  prose implies, and the spec is amended to say which half is delivered.
- **The security posture is unchanged.** No token, no `SecretStore` access and no JMAP call
  enters the service worker. That is the single most valuable property of this option and it
  should not be traded away later without a fresh NFR-SEC-02/NFR-SEC-04 review — which is
  precisely what B28 will require.
- **It stays unautomatable.** Playwright cannot observe a closed app, so the closed-app half is
  verified by hand, per platform, and recorded. The subscription flow, the verification
  round-trip, the renewal and the suppression logic are all testable and are tested.
- **iOS is a per-platform question, not a code one.** Safari delivers Web Push only to a web app
  added to the Home Screen. To be verified during the work package and stated in the settings
  copy if it holds; it changes the wording, not the design.
- **A stale subscription is the expected steady state, not an error.** Endpoints expire, are
  rotated by the push service, and are dropped when a user clears site data. The flow treats a
  `410 Gone` or a missing subscription as ordinary and re-subscribes, rather than surfacing it.

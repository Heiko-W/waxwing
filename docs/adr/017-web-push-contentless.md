# 017 — Web Push ships contentless: the server filters, the worker asks nothing

- **Status:** accepted — **amended 2026-08-21** (see the amendment at the end). Decision 2 (the
  banner is contentless) and decision 5 (the preview toggle is met by construction) are superseded:
  Stalwart v0.16.16+ puts the message IN the push, so the fetch-from-the-worker argument this ADR
  rests on no longer holds. Everything else below stands, including the security property — the
  richer banner cost nothing from it.
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

## Amendment (2026-08-21) — the reason for the contentless banner no longer exists; B28 is built

**Status of this ADR is unchanged: accepted.** Decisions 1, 3, 4, 6 and 7 stand verbatim. What is
superseded is **decision 2** — "the closed-app banner is contentless" — and **decision 5**, which
read the preview toggle as met by construction. Both rested on a single technical fact that has
stopped being true.

### What changed

Stalwart **v0.16.16** shipped `urn:ietf:params:jmap:emailpush` (`draft-ietf-jmap-emailpush-03`), and
the fixture now runs **v0.16.18**. A `PushSubscription` gains an `emailPush` property, and a
delivery matching it arrives as a push carrying **the message itself**. Captured verbatim at a
push endpoint on 2026-08-21 (full measurement in
`docs/jmap-gap-2026-08-21/berichte/E-emailpush.md`):

```json
{"@type":"EmailPush","accountId":"b","emails":[{"from":[{"name":"Bob Beispiel",
"email":"bob@waxwing.test"}],"subject":"Rechnung 2026-08 faellig",
"preview":"Hallo Alice, anbei die Rechnung fuer August. …",
"receivedAt":"2026-08-21T16:16:25Z"}],"state":"sae"}
```

The sizing above priced D6b as an `L` on one argument, quoted from this ADR's own Context:

> A banner reading *"Bob — Re: the quarterly figures"* therefore requires the service worker to
> fetch that message itself, while the app is closed: an authenticated JMAP call from a DOM-free
> worker, which drags the access token, the AES-GCM `SecretStore` (NFR-SEC-02) and the OAuth refresh
> path in with it […]

**That argument no longer applies.** The worker fetches nothing. The browser has already decrypted
the payload (RFC 8291, the same aes128gcm envelope as before); the worker reads `event.data.json()`
and calls `showNotification`. No token, no `SecretStore`, no JMAP call, no OAuth refresh in a second
context. The single most valuable property of D6a — quoted in Consequences as the one "that should
not be traded away later without a fresh NFR-SEC-02/NFR-SEC-04 review" — is **not traded away**. It
is preserved exactly, and B28's cost collapses from an `L` to the work of parsing one more frame
shape. The security review D6a demanded is therefore not required: the boundary it was to examine is
unmoved, and `sw.ts` still cannot reach auth or JMAP.

### The measured facts this amendment rests on

Probed against `stalwartlabs/stalwart:v0.16.18-alpine` on 2026-08-21, as `alice`, with the wire
captured at a TLS push endpoint under our control.

**1. The property is real and validated, not tolerated.** `PushSubscription/set` accepts
`emailPush: {"<accountId>": {"filter": null, "properties": [...]}}`, stores it, and fills in
`urgency: "normal"` by itself. An invented entry in `properties` comes back as `invalidProperties` —
*"Unknown email property."* An account the credentials cannot see comes back as
*"No access to one of the accounts in the emailPush map."* `using` must contain the URN.

**2. `EmailPush` REPLACES the `StateChange`; the two never both arrive.** One notification is built
per delivery and downgraded to a `StateChange` only when no `emailPush` config matches
(`crates/services/src/state_manager/push.rs:332`). Confirmed on the wire with
`types: ["Email","EmailDelivery","Mailbox","Thread"]` still set: one request arrived, the
`EmailPush`. **This is the dangerous fact of the whole change** and it is why the client models both
wire shapes as one outcome — see below.

**3. The `filter` suppresses the push entirely.** A delivery that does not match produces no push at
all, not even a bare `StateChange`. Measured: two messages to the same inbox, one matching, one not;
the non-matching one was delivered to the mailbox and pushed nothing.

**4. The live channels are untouched.** The RFC 8887 WebSocket and the RFC 8620 EventSource channel
have no `emailPush` configuration and delivered plain `StateChange` frames for the very same
arrival. Waxwing's sync engine reads those, never Web Push.

**5. Budget.** 4096 bytes per push body, less under encryption. Stalwart truncates the property set
or the `emails` array itself when it runs out — silently, from a client's point of view.

### Decision

1. **The closed-app banner names the sender and the subject** — and shows the preview beneath them —
   **when the server advertises `urn:ietf:params:jmap:emailpush` and the user's preview toggle is
   on.** B28 is closed as done. The layout is the one iOS Mail uses: sender as the title (bold on
   every platform), subject on the next line, preview after it, nothing else. The Notifications API
   has no `subtitle`, so subject and preview share `body` across a newline; Safari folds that to one
   line, which is a graceful loss rather than a wrong banner.

2. **Both wire shapes classify as ONE outcome — `kind: 'delivery'` — and the `EmailPush` case simply
   carries more.** This is the load-bearing decision, not a detail of `push-frame.ts`. Because fact 2
   means the `StateChange` stops arriving the moment `emailPush` is configured, a client that gave
   `EmailPush` a case of its own would have every existing consumer of a delivery go quiet on the day
   the feature was switched on — the server behaving exactly as documented, and nothing in the client
   to point at. The frame carries `accountId` and `state`, so it can drive everything a `StateChange`
   could. A test asserts the two shapes produce the same `kind` and name the same account.

3. **Nothing about the sync trigger changes, and nothing needed to.** Waxwing has never used Web
   Push to drive synchronisation: the sync engine's channel is SSE, with WebSocket and polling as
   fallbacks (ADR-005), and fact 4 shows `emailPush` does not touch any of them. The exposure was
   real and is now closed by decision 2 rather than by luck.

4. **`filter` stays `null`. The per-folder preference does NOT move to the server.** It is tempting:
   it would make FR-NOTIF-03's folder list finally apply while the app is closed, and it would spend
   less of the device's battery. It is declined because fact 3 makes a filtered-out delivery produce
   *no push at all* — so the Web Push channel would go blind for every message outside the chosen
   folders, and any future use of it to wake a sync (decision 3 has just made that possible) would
   silently inherit a notification preference as its trigger. Making a data-consistency mechanism
   depend on a cosmetic setting is the kind of coupling that is invisible until it is a bug report
   about missing mail. The settings screen therefore keeps saying that the folder selection does not
   apply while the app is closed. Revisiting this needs a second, unfiltered subscription — or a
   sync trigger that provably does not use this channel — and is a decision of its own.

5. **Decision 5 of the original ADR is superseded: the preview toggle is now a real control on this
   path, and it governs the WIRE, not the banner.** With "Show sender and subject" off, Waxwing sends
   no `emailPush` configuration at all, so the server never puts a subject in a push. Hiding it at
   the last moment would have been the letter of the requirement and not its point: a push carrying a
   subject crosses the push service, sits in the browser's queue and is decrypted on the device, and
   all of that is content that the user asked not to receive. The toggle is *also* honoured in the
   worker — the server-side configuration is only rewritten on the app's next start, so a
   content-carrying push can legitimately be in flight when the switch flips, and the banner must
   obey the switch the user last touched rather than the one the server last heard about.

6. **Nothing changes against a server without the capability, and that is tested rather than
   asserted.** The URN is never derived from a method name (`PushSubscription/*` is core, so it would
   ride on every subscription request) and is opted into per call. RFC 8620 §3.3 obliges a server to
   fail an entire request whose `using` names a capability it does not implement, so a single
   unconditional URN would break background notifications against every JMAP server but one. A test
   asserts the exact create body sent to a server without the capability.

7. **The property set is `["from","subject","preview","receivedAt"]` and no more.** The four an iOS
   Mail notification shows. `receivedAt` becomes `NotificationOptions.timestamp`, so the shade shows
   when the mail arrived rather than when a woken worker drew the banner. `id` is deliberately not
   requested: a click still opens the mail home (original decision 7 stands — notification actions
   are JMAP writes and would need the token none of this has), and an id we do not use would spend
   budget that fact 5 makes finite.

### On the settings surface

Apple offers three states — *Show Previews: Always / When Unlocked / Never*. Waxwing offers two. The
middle one **cannot** be implemented by a web application: the Notifications API exposes no lock
state, and there is no event on which to re-render a banner after an unlock. Adding a third option
that silently behaved like one of the other two would be worse than not offering it. The two states
map onto Apple's *Always* and *Never*, and the settings copy now states which of three things a
closed-app notification will actually say — the server cannot send content; it can and the user
wants it; it can and the user does not, in which case the copy says the content is **never asked
for**, not merely hidden.

### Consequences

- **FR-NOTIF-02 is met in full** for the first time, against a server that offers the draft. Against
  every other server the M4.0 behaviour is unchanged, including its honest settings copy.
- **The security posture is unchanged**, and this amendment is only defensible because of that. If a
  future step does require a token in the worker, it needs the NFR-SEC-02/NFR-SEC-04 review the
  original Consequences demanded — this one did not earn a waiver for it.
- **More reaches a lock screen than before.** That is the point of the feature and the reason the
  preview toggle now does real work. On a shared or public machine the honest control is the toggle,
  and the settings copy says what each position actually does.
- **The draft is a draft.** `draft-ietf-jmap-emailpush-03` may change before it is an RFC, and a
  server may implement a different revision. Everything here is behind a capability probe and a
  tolerant parser: an unrecognised frame is an ordinary outcome, and the worst case is the M4.0
  contentless banner, which is what a client without the capability gets anyway.
- **Bundle cost is in `sw.js`, which every visitor downloads.** The classifier grew one branch and a
  small banner-composition function; both are pure and shared with the page's own tests.

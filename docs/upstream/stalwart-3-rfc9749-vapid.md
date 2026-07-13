# Feature: implement RFC 9749 (VAPID for JMAP Web Push) — without it, Chrome and Safari cannot receive push at all

**Affects:** v0.16.11, v0.16.13, `main` — `grep -ri vapid` over the tree returns zero hits.
**Impact:** Even with the payload-encoding bug fixed, a browser-based JMAP client can receive Web
Push on Firefox only. On Chromium and Safari — i.e. every Android device and every iOS
home-screen install — background push is impossible.

## The problem

`http_request()` (`crates/services/src/state_manager/http.rs:99-137`) POSTs to the push endpoint
with exactly three headers: `Content-Type`, `TTL`, and `Content-Encoding`. There is no
`Authorization: vapid …` header, no application-server keypair, and no way to configure one.

That is fatal for two of the three browser engines, because of how they gate `subscribe()`:

| | subscribe() without `applicationServerKey`? | endpoint accepts an unsigned POST? |
|---|---|---|
| **Chromium** | No — `AbortError: Registration failed - missing applicationServerKey, and manifest empty or missing` (reproduced) | No — the subscription is VAPID-restricted, and RFC 8292 §4.2 requires the push service to reject an unsigned message (401/403) |
| **Safari / WebKit** | No — `NotSupportedError: Subscribing for push requires an applicationServerKey` | No |
| **Firefox** | Yes | Yes (unrestricted endpoint) |

So on Chrome and Safari a client is *forced* to supply an application-server key at subscribe time,
which binds the endpoint to that key — and Stalwart cannot sign for it. There is no workaround on
the client side. (The legacy `gcm_sender_id` manifest route is not one: it yields a legacy FCM
subscription that needs an FCM server key in the `Authorization` header, which Stalwart also does
not send.)

## The standard already exists

**RFC 9749 — "Use of Voluntary Application Server Identification (VAPID) in JMAP Web Push"**
(Standards Track, March 2025) defines exactly the missing piece: the capability

```
"urn:ietf:params:jmap:webpush-vapid": { "applicationServerKey": "<base64url ECDSA P-256 public key>" }
```

in the session object, so the client can pass it to `PushManager.subscribe()`; and §4 requires the
server to authenticate its POSTs — for **`StateChange` and `PushVerification` alike** — with the
VAPID scheme of RFC 8292.

## What implementing it takes

1. Generate (and persist) an ECDSA P-256 application-server keypair, once per server.
2. Advertise the public key in the session object under `urn:ietf:params:jmap:webpush-vapid`.
3. In `http_request()`, add
   `Authorization: vapid t=<JWT>, k=<base64url public key>`
   where the JWT is ES256-signed with `aud` = the origin of the push endpoint, `exp` ≤ 24 h, and a
   `sub` of `mailto:` or `https:` (RFC 8292 §2).

## Context

No JMAP server implements RFC 9749 today: Cyrus does not support `PushSubscription` at all, and
Apache James's VAPID PR (apache/james-project#2956) was closed unmerged. Stalwart would be the
first — and, given that it is the server most JMAP web clients develop against, that would unblock
browser Web Push for the whole ecosystem.

Filed alongside the payload-encoding bug (base64 body under `Content-Encoding: aes128gcm`), which
must be fixed as well; either defect alone is enough to prevent a browser from receiving push.

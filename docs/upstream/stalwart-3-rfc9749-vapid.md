# Report 3 — Implement RFC 9749 (VAPID for JMAP Web Push): without it, Chromium and Safari cannot receive push at all

**Where to post:** <https://support.stalw.art> → **Feature Request** (not the bug category).
The feature form is shorter than the bug form; the blocks below cover the bug form's fields too,
in case the category shares it. Add the **`no-ai`** tag.

**Post this last**, after reports 1 and 2, and link them: the three together are what it takes
to make Web Push work in a browser, and this one is the only *feature* of the three.

---

## ▸ Issue Description / Feature Request  *(required)*

```
Stalwart cannot deliver a Web Push notification to Chromium or Safari — i.e. to every
Android device and every iOS home-screen install — and it never will until it implements
RFC 9749. This is not a configuration problem and there is no client-side workaround.

Why: http_request() (crates/services/src/state_manager/http.rs:99-137) POSTs to the push
endpoint with exactly three headers — Content-Type, TTL, and Content-Encoding. There is
no `Authorization: vapid ...` header, no application-server keypair, and no way to
configure one. `grep -ri vapid` over the tree returns ZERO hits, at v0.16.11, at v0.16.13,
and on main @764c2c1 (2026-07-12).

That is fatal for two of the three browser engines, because of how they gate subscribe():

  Chromium  subscribe() without an applicationServerKey?  NO —
              "AbortError: Registration failed - missing applicationServerKey, and
               manifest empty or missing"   (reproduced on the engine)
            endpoint accepts an unsigned POST?  NO — the subscription is VAPID-restricted,
              and RFC 8292 §4.2 REQUIRES the push service to reject an unsigned message
              (401/403).

  Safari    subscribe() without an applicationServerKey?  NO —
              "NotSupportedError: Subscribing for push requires an applicationServerKey"
              (WebCore/Modules/push-api/PushManager.cpp)
            endpoint accepts an unsigned POST?  NO.

  Firefox   subscribe() without a key?  Yes. Unsigned POST accepted?  Yes.
              (But see the separate payload-encoding bug — Firefox cannot decrypt the body
               either, so today Web Push from Stalwart works in zero browsers.)

So on Chrome and Safari a client is FORCED to supply an application-server key at
subscribe time, which binds the endpoint to that key — and Stalwart cannot sign for it.
The legacy gcm_sender_id manifest route is not an escape: it yields a legacy FCM
subscription that needs an FCM server key in the Authorization header, which Stalwart
also does not send.

The standard already exists. RFC 9749 — "Use of Voluntary Application Server
Identification (VAPID) in JMAP Web Push", Standards Track, March 2025 — defines exactly
the missing piece: the session capability

    "urn:ietf:params:jmap:webpush-vapid": {
        "applicationServerKey": "<base64url ECDSA P-256 public key>"
    }

so the client can pass it to PushManager.subscribe(); and §4 requires the server to
authenticate its POSTs — for StateChange and PushVerification alike — with the VAPID
scheme of RFC 8292.
```

## ▸ Expected Behavior

```
1. Stalwart generates and persists an ECDSA P-256 application-server keypair, once per
   server.
2. It advertises the public key in the session object under
   "urn:ietf:params:jmap:webpush-vapid" (RFC 9749 §3).
3. In http_request(), it sends
       Authorization: vapid t=<JWT>, k=<base64url public key>
   where the JWT is ES256-signed with `aud` = the origin of the push endpoint,
   `exp` <= 24 h, and a `sub` of mailto: or https: (RFC 8292 §2).

A browser client then reads applicationServerKey from the session, passes it to
PushManager.subscribe(), and the push service accepts Stalwart's signed POSTs.
```

## ▸ Actual Behavior

```
No VAPID keypair, no capability, no Authorization header. A browser on Chromium or
Safari cannot even create a subscription that Stalwart is able to post to.
```

## ▸ Reproduction Steps

```
1. In Chrome, from a page with a service worker:
     await registration.pushManager.subscribe({ userVisibleOnly: true })
   -> AbortError: "Registration failed - missing applicationServerKey, and manifest
      empty or missing"
   There is no way to obtain a key from Stalwart to pass here: no session capability
   carries one.

2. In Safari (macOS, or iOS from a home-screen install), the same call throws
   NotSupportedError.

3. Inspect the session object from Stalwart: no "urn:ietf:params:jmap:webpush-vapid".

4. grep -ri vapid over the source tree: zero hits (v0.16.11, v0.16.13, main @764c2c1).
```

## ▸ Relevant Log Output

```
Nothing is logged — the failure is on the client, before any request reaches Stalwart.

Captured POST from Stalwart to an HTTPS push endpoint, showing the absent header:

  POST /push   (308 bytes)
    content-type: application/json
    ttl: 86400
    content-encoding: aes128gcm
    (no Authorization header)
```

## ▸ Stalwart Version  *(required, dropdown)*

> **0.16.11** — verified absent in v0.16.13 and on `main` @764c2c1 as well (stated above).

## ▸ Installation Method  *(required, dropdown)*

> **Docker** (`stalwartlabs/stalwart:v0.16.11-alpine`)

## ▸ Database Backend  *(required, dropdown)*

> **RocksDB**

## ▸ Blob Storage  *(required, dropdown)*

> **RocksDB** (single store: `{"@type":"RocksDb"}`)

## ▸ Search Engine  *(required, dropdown)*

> **RocksDB** (internal default — the same store)

## ▸ Directory Backend  *(required, dropdown)*

> **Internal**

## ▸ Additional Context

```
Client: a browser-based JMAP webmail (static SPA, service worker; no backend of its own,
so there is nowhere else a VAPID signature could come from).

Ecosystem context — this is a gap nobody has closed, not an oversight peculiar to
Stalwart:
  - Cyrus documents that PushSubscription is not supported at all.
  - Apache James has PushSubscription without VAPID; its VAPID PR
    (apache/james-project#2956, "WIP Webpush vapid") was closed unmerged in April 2026.
  - The only RFC 9749 implementation in existence is a *client* library.

Stalwart would be the first server to implement it — and, being the server most JMAP web
clients develop against, that would unblock browser Web Push for the whole ecosystem.

Filed alongside two bug reports which must also be fixed for Web Push to work at all:
  (1) the encrypted payload is base64-wrapped under Content-Encoding: aes128gcm, so no
      browser can decrypt it — Firefox included;
  (2) PushSubscription/set rejects the unpadded base64url keys a browser produces.
Either defect alone is enough to prevent a browser from receiving push; VAPID is what is
additionally required for Chromium and Safari.
```

## ▸ Checkboxes

- ☑ Documentation/FAQ reviewed — **yes** (stalw.art/docs/http/jmap/push cites RFC 8030/8188/8291, and pointedly not RFC 8292/9749).
- ☑ Forum searched — **tick after searching.** No issue anywhere references RFC 9749.
- ☑ Bot triage understood — **tick, and add the `no-ai` tag.**

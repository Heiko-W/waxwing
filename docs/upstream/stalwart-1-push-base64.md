# Report 1 — Web Push payloads are base64-encoded but sent as `Content-Encoding: aes128gcm`

**Where to post:** <https://support.stalw.art> → Bug report.
**Recommended:** add the **`no-ai`** tag. This is a code-level report with source citations; the
previous attempt at this bug (GitHub #3169) was killed by a bot twelve seconds after it was filed.

Everything below is copy-paste ready, field by field.

---

## ▸ Issue Description  *(required)*

```
Stalwart's Web Push implementation is unusable from any browser. The JMAP logic is
correct — PushSubscription/set, the PushVerification round-trip and StateChange
delivery all work — but the HTTP layer base64-encodes the encrypted payload while
announcing `Content-Encoding: aes128gcm`, which per RFC 8188 §2 promises the raw
binary octets of the encrypted content coding.

A browser's push service relays the body verbatim. The user agent then tries to parse
the aes128gcm header block (salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid) out of what is actually
base64 ASCII text, fails, and drops the message. Chromium reports a decryption failure
and never dispatches the `push` event; Firefox raises CryptoError in PushCrypto.decrypt
and ACKs with ACK_DECRYPTION_ERROR. In both cases the application sees nothing at all —
not the StateChange, and not even the PushVerification, so a browser client cannot
complete the subscription handshake.

Location (unchanged on main @764c2c1, 2026-07-12):
crates/services/src/state_manager/http.rs:117-118

    match ece_encrypt(&keys.p256dh, &keys.auth, body.as_bytes())
        .map(|b| base64::engine::general_purpose::URL_SAFE.encode(b))   // <-- here
    {
        Ok(body_) => {
            body = body_;
            client = client.header(CONTENT_ENCODING, "aes128gcm");
        }

crates/services/src/state_manager/ece.rs is fine: the ciphertext it produces decrypts
correctly once the base64 wrapper is removed. The defect is purely the wire encoding.

Why the test suite does not catch it: tests/src/jmap/core/push_subscription.rs:293-296
base64-decodes the body before decrypting —

    ece::decrypt(..., &general_purpose::URL_SAFE.decode(body).unwrap())

— so the test passes *because of* the deviation. A real user agent does not do this.

This most likely explains GitHub issue #3169 ("PushSubscription / EventSource verify
successfully but never deliver StateChange events"), which was auto-closed without
triage. The events *are* delivered. The browser simply cannot decrypt them.
```

## ▸ Expected Behavior

```
With `Content-Encoding: aes128gcm` set, the HTTP body should be the raw octets of the
RFC 8188 / RFC 8291 encrypted content coding, so that a browser can decrypt it and
dispatch the service worker's `push` event.

RFC 8188 §2 ("Content-Encoding: aes128gcm"), RFC 8291 §4.
```

## ▸ Actual Behavior

```
The body is the base64url ASCII *text* of the ciphertext, sent under the aes128gcm
content-encoding header. No browser can decrypt it, so no `push` event ever fires and
Web Push is non-functional for every browser-based JMAP client.
```

## ▸ Reproduction Steps

```
1. Run Stalwart (any 0.16.x; verified on v0.16.11-alpine, and the code is unchanged on
   main @764c2c1).

2. Stand up an HTTPS endpoint you control that logs the raw request body. Stalwart
   requires https:// for a PushSubscription url, and the release build does not accept
   invalid certificates (danger_accept_invalid_certs is behind #[cfg(feature =
   "test_mode")]), so use a certificate the server trusts.

3. Create a PushSubscription with real RFC 8291 keys. Note that the keys must be PADDED
   base64url — Stalwart rejects the unpadded values a browser actually produces; that is
   a separate report:

   {
     "using": ["urn:ietf:params:jmap:core"],
     "methodCalls": [["PushSubscription/set", { "create": { "p": {
       "deviceClientId": "probe",
       "url": "https://<your-listener>/push",
       "types": null,
       "keys": { "p256dh": "<padded base64url of an uncompressed P-256 public key>",
                 "auth":   "<padded base64url of 16 random bytes>" }
     }}}, "a"]]
   }

4. Capture the POST Stalwart makes to your listener.

5. Try to decrypt the body as aes128gcm (i.e. exactly what a browser does). It fails.
   Base64url-decode the body FIRST, then decrypt: it succeeds.
```

## ▸ Relevant Log Output

```
Not a server-log issue — the server logs PushSubscription(Success). The evidence is on
the wire. Captured POST from Stalwart v0.16.11 to an HTTPS listener:

POST /push   (308 bytes)
  content-type: application/json
  ttl: 86400
  content-encoding: aes128gcm

  body, first 32 bytes as hex:
    306d2d6d4672373333364d3566485531544f73395941414145414242...
  the same bytes as text:
    "0m-mFr7336M5fHU1TOs9YAAAEABBBGQEMKbzYtwFAxQAtnPO"

  decrypting the body as aes128gcm (what a browser does)
      -> FAILS: "Public key is not valid for specified curve"
         (it is parsing ASCII where the P-256 keyid should be)

  base64url-decoding the body FIRST, then decrypting
      -> {"@type":"PushVerification","pushSubscriptionId":"b",
          "verificationCode":"UbdeWySyZXH1bEyJ9XJZAC0o8pX3nDfD"}

The body is pure base64url ASCII. Everything downstream of the encoding is correct:
after undoing the base64 the payload decrypts cleanly, the verification code round-trips
via PushSubscription/set, and a subsequent StateChange is delivered as expected.
```

## ▸ Stalwart Version  *(required, dropdown)*

> **0.16.11** — that is what was reproduced on. The code is **unchanged on `main` @764c2c1
> (2026-07-12)**, which is stated in the description so it cannot be deflected as
> "please upgrade".

## ▸ Installation Method  *(required, dropdown)*

> **Docker** (`stalwartlabs/stalwart:v0.16.11-alpine`)

## ▸ Database Backend  *(required, dropdown)*

> **RocksDB**

## ▸ Blob Storage  *(required, dropdown)*

> **RocksDB** — the fixture configures a single store (`{"@type":"RocksDb"}`), which serves as
> data, blob and FTS store.

## ▸ Search Engine  *(required, dropdown)*

> **RocksDB** (the internal default — the same store)

## ▸ Directory Backend  *(required, dropdown)*

> **Internal**

## ▸ Additional Context

```
Client: a browser-based JMAP webmail (static SPA, service worker). No proxy, no NAT —
the capture above is a direct POST from the container to a listener on the host.

Suggested fix — send the raw octets instead of a base64 string, i.e. drop the
.map(|b| ...encode(b)) and hand reqwest the Vec<u8>:

    match ece_encrypt(&keys.p256dh, &keys.auth, body.as_bytes()) {
        Ok(encrypted) => {
            // raw aes128gcm octets, per RFC 8188 §2 — NOT base64
            client = client.header(CONTENT_ENCODING, "aes128gcm").body(encrypted);
        }
        ...

(That requires letting http_request carry either a String or a Vec<u8> body.) The test at
tests/src/jmap/core/push_subscription.rs:293 should then decrypt the body directly,
without the base64 step — which is also what makes the test meaningful.

Note: Content-Type: application/json is retained on the encrypted body. That is what
RFC 8620 §7.2 literally mandates, and push services ignore Content-Type, so it is
harmless. Mentioning it only so it is not mistaken for part of this report.

Two related reports follow separately: (a) PushSubscription/set rejects the unpadded
base64url keys that the W3C Push API produces; (b) RFC 9749 (VAPID) is not implemented,
without which Chromium and Safari cannot receive push at all even once this bug is fixed.
```

## ▸ Checkboxes

- ☑ I have reviewed the documentation and FAQ… — **yes** (stalw.art/docs/http/jmap/push cites RFC 8030, 8188, 8291; the deviation is from RFC 8188 §2).
- ☑ I have searched this support forum… — **tick after searching.** The closest prior art is GitHub **#3169**, auto-closed without triage; reference it.
- ☑ I understand that topics are triaged by a bot… — **tick, and add the `no-ai` tag.** #3169 died to exactly this.

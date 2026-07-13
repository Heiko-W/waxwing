# Web Push payloads are base64-encoded but sent with `Content-Encoding: aes128gcm` — no browser can decrypt them

**Affects:** v0.16.11 (verified), v0.16.13 (verified — same code), `main`
**Impact:** Web Push to a browser is non-functional. The service worker's `push` event never fires,
so neither `PushVerification` nor `StateChange` can ever be observed by a web client.

## Summary

`http_request()` encrypts the push payload correctly per RFC 8291, then **base64url-encodes the
ciphertext and sends that ASCII string as the HTTP body** — while setting
`Content-Encoding: aes128gcm`, which per RFC 8188 §2 promises the raw binary octets of the
encrypted content coding.

A browser's push service relays the body verbatim. The user agent then tries to parse the
aes128gcm header block (`salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid`) out of what is actually base64
text, fails, and drops the message. Chromium reports a decryption failure and never dispatches the
`push` event; Firefox raises `CryptoError` in `PushCrypto.decrypt` and ACKs with
`ACK_DECRYPTION_ERROR`. In both cases the application sees nothing at all.

## Location

`crates/services/src/state_manager/http.rs` (v0.16.11, lines 116–124):

```rust
if let Some(keys) = &details.keys {
    match ece_encrypt(&keys.p256dh, &keys.auth, body.as_bytes())
        .map(|b| base64::engine::general_purpose::URL_SAFE.encode(b))   // <-- here
    {
        Ok(body_) => {
            body = body_;
            client = client.header(CONTENT_ENCODING, "aes128gcm");
        }
        ...
```

`crates/services/src/state_manager/ece.rs` itself is fine — the ciphertext it produces decrypts
correctly once the base64 wrapper is removed. The defect is purely the wire encoding.

## Why the test suite does not catch it

`tests/src/jmap/core/push_subscription.rs:293-296` base64-decodes the body before decrypting:

```rust
ece::decrypt(..., &general_purpose::URL_SAFE.decode(body).unwrap())
```

so the test passes *because of* the deviation. A real user agent does not do this.

## Reproduction (wire capture against a plain HTTPS listener)

Created a `PushSubscription` with `p256dh`/`auth` from a real P-256 keypair, pointing at an HTTPS
endpoint under my control, and captured what Stalwart POSTed:

```
POST /push   (308 bytes)
  content-type: application/json
  ttl: 86400
  content-encoding: aes128gcm

  first 32 bytes (hex): 306d2d6d4672373333364d3566485531544f73395941414145414242...
  the same bytes as text: "0m-mFr7336M5fHU1TOs9YAAAEABBBGQEMKbzYtwFAxQAtnPO"

  decrypting the body as aes128gcm (what a browser does)
      -> FAILS: "Public key is not valid for specified curve"
  base64url-decoding the body FIRST, then decrypting
      -> {"@type":"PushVerification","pushSubscriptionId":"b","verificationCode":"UbdeWy…"}
```

The body is pure base64url ASCII. Everything downstream of the encoding is correct: after undoing
the base64, the payload decrypts cleanly, the verification code round-trips, and a subsequent
`StateChange` is delivered as expected.

## Suggested fix

Send the raw octets instead of a base64 string — i.e. drop the `.map(|b| …encode(b))` and give
reqwest the `Vec<u8>`:

```rust
match ece_encrypt(&keys.p256dh, &keys.auth, body.as_bytes()) {
    Ok(encrypted) => {
        // raw aes128gcm octets, per RFC 8188 §2 — NOT base64
        client = client.header(CONTENT_ENCODING, "aes128gcm").body(encrypted);
    }
    ...
```

(This requires letting `http_request` carry either a `String` or a `Vec<u8>` body.) The test at
`tests/src/jmap/core/push_subscription.rs:293` should then decrypt the body directly, without the
base64 step — which is also what makes the test meaningful.

## Likely explains #3169

Issue #3169 ("PushSubscription / EventSource verify successfully but never deliver StateChange
events") was closed by a bot without triage. The events *are* delivered — a client that
base64-decodes first receives them fine. A browser simply cannot decrypt them, so from the
application's point of view nothing ever arrives.

## Note

`Content-Type: application/json` is retained on the encrypted body. That is what RFC 8620 §7.2
literally mandates, and push services ignore Content-Type, so it is harmless — mentioning it only
so it is not mistaken for part of this bug.

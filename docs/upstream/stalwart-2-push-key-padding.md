# `PushSubscription/set` rejects the unpadded base64url keys that the W3C Push API produces

**Affects:** v0.16.11 (verified), v0.16.13, `main`
**Impact:** A web client cannot pass `PushSubscription.toJSON().keys` straight through — the
subscription is rejected with `invalidProperties: "Failed to decode keys."` unless the client
re-pads the values first.

## Summary

`crates/jmap/src/push/set.rs:307-311` decodes the `p256dh` and `auth` key values with
`base64::engine::general_purpose::URL_SAFE`. In base64 0.22 that engine is the **padded** config
(`DecodePaddingMode::RequireCanonical`), so an unpadded value fails to decode.

The W3C Push API specifies the opposite. `PushSubscription.toJSON()` serializes the keys as
*"the URL-safe base64 encoding **without padding** [RFC4648]"*. A real browser therefore hands the
application an 87-character `p256dh` and a 22-character `auth` — neither of which Stalwart accepts.

## Reproduction

```
PushSubscription/set create, keys exactly as a browser produces them (87 + 22 chars, no '='):
  -> notCreated: {"type":"invalidProperties",
                  "description":"Failed to decode keys.",
                  "properties":["keys"]}

the same keys, re-padded to 88 + 24 chars:
  -> created: {"id":"b", ...}
```

## Suggested fix

Decode with an engine that tolerates both, e.g.
`general_purpose::URL_SAFE_NO_PAD` with `DecodePaddingMode::Indifferent`, or
`base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent))`.

Being liberal here costs nothing and removes a papercut that every browser client hits on its
first attempt.

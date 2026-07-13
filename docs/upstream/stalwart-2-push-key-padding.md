# Report 2 — `PushSubscription/set` rejects the unpadded base64url keys the W3C Push API produces

**Where to post:** <https://support.stalw.art> → Bug report. Add the **`no-ai`** tag.
**Post this one *after* Report 1** and link to it — it is the smaller of the two, and Report 1
is the one that actually blocks Web Push.

Copy-paste ready, field by field.

---

## ▸ Issue Description  *(required)*

```
A browser client cannot pass `PushSubscription.toJSON().keys` straight through to
PushSubscription/set: the subscription is rejected with

    invalidProperties: "Failed to decode keys."

unless the client re-pads the values first.

crates/jmap/src/push/set.rs:307-311 decodes the `p256dh` and `auth` key values with
base64::engine::general_purpose::URL_SAFE. In base64 0.22 that engine is the PADDED
config (DecodePaddingMode::RequireCanonical), so an unpadded value fails to decode.

The W3C Push API specifies the opposite. PushSubscription.toJSON() serialises the keys
as "the URL-safe base64 encoding WITHOUT padding [RFC4648]". A real browser therefore
hands the application an 87-character p256dh and a 22-character auth — neither of which
Stalwart accepts.

Every browser client hits this on its first attempt.

Unchanged on main @764c2c1 (2026-07-12).
```

## ▸ Expected Behavior

```
PushSubscription/set accepts the key values exactly as a browser produces them —
unpadded base64url, per the W3C Push API's definition of PushSubscription.toJSON().

Being liberal in what is accepted costs nothing here: padded and unpadded base64url are
unambiguous, and no other client is harmed by accepting both.
```

## ▸ Actual Behavior

```
Unpadded keys (the browser's own output, 87 + 22 chars) are rejected:

    notCreated: { "p": { "type": "invalidProperties",
                         "description": "Failed to decode keys.",
                         "properties": ["keys"] } }

The identical keys, re-padded to 88 + 24 chars, are accepted.
```

## ▸ Reproduction Steps

```
1. Run Stalwart (verified on v0.16.11-alpine; unchanged on main).

2. Generate a P-256 keypair and a 16-byte auth secret, and encode them as UNPADDED
   base64url — i.e. exactly what `PushSubscription.toJSON()` gives a web application.

3. PushSubscription/set create with those keys:

   {
     "using": ["urn:ietf:params:jmap:core"],
     "methodCalls": [["PushSubscription/set", { "create": { "p": {
       "deviceClientId": "probe",
       "url": "https://example.com/push",
       "types": null,
       "keys": { "p256dh": "<87 chars, no '='>", "auth": "<22 chars, no '='>" }
     }}}, "a"]]
   }

   -> notCreated: invalidProperties "Failed to decode keys."

4. Repeat with the same keys re-padded to 88 and 24 characters.

   -> created.
```

## ▸ Relevant Log Output

```
Observed JMAP responses (no server-side error is logged):

  keys exactly as a browser produces them (87 + 22 chars, no '='):
    -> {"type":"invalidProperties",
        "description":"Failed to decode keys.",
        "properties":["keys"]}

  the same keys, re-padded (88 + 24 chars):
    -> {"id":"b","keys":null,"expires":"2026-07-20T07:55:48Z"}
```

## ▸ Stalwart Version  *(required, dropdown)*

> **0.16.11** — unchanged on `main` @764c2c1 (stated in the description).

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
Client: a browser-based JMAP webmail (static SPA, service worker). No proxy.

Suggested fix — decode with an engine that tolerates both paddings, e.g.

    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )

Related: I have filed a separate, more serious report — the encrypted push payload is
base64-wrapped while `Content-Encoding: aes128gcm` promises raw octets, so no browser can
decrypt it. Fixing the padding alone does not make Web Push work; both are needed, plus
RFC 9749 (VAPID) for Chromium and Safari.
```

## ▸ Checkboxes

- ☑ Documentation/FAQ reviewed — **yes**.
- ☑ Forum searched — **tick after searching**; link Report 1.
- ☑ Bot triage understood — **tick, and add the `no-ai` tag.**

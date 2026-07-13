# Upstream reports

Defects found in third-party software while building Waxwing, written up so they can be filed
without re-deriving the evidence.

## How to file these with Stalwart — **not** on GitHub

`stalwartlabs/stalwart` **auto-closes and locks every issue opened directly in the repository.**
`.github/ISSUE_TEMPLATE/config.yml` sets `blank_issues_enabled: false`, and the sole template is
titled, literally, *"Bug Report (auto-closed)"*. The proof is the very issue our first report
explains:

```
#3169  "PushSubscription / EventSource verify successfully but never deliver StateChange events"
  created 2026-05-08T19:06:55Z
  closed  2026-05-08T19:07:07Z   ← twelve seconds later, by a bot
  state   CLOSED / NOT_PLANNED
```

The only route that reaches a maintainer is **<https://support.stalw.art>** (sign in with a GitHub
account). A confirmed report is then converted into a GitHub issue *by them*. Filing there needs an
interactive browser login, so it is a human step — the write-ups below are meant to be pasted in.

## The reports

Each file is laid out as the support portal's **form fields**, in order, ready to paste one block
at a time — including answers for the six required dropdowns, taken from our fixture
(`e2e/stalwart/config/config.json`).

| Post | File | What it is |
|---|---|---|
| **1st** | [`stalwart-1-push-base64.md`](stalwart-1-push-base64.md) | **Bug — the one that matters.** The Web Push payload is base64-encoded but sent with `Content-Encoding: aes128gcm`, so no browser can decrypt it and the service worker's `push` event never fires. Wire capture + source line + why their own test suite passes anyway. This is what #3169 was actually reporting. |
| **2nd** | [`stalwart-2-push-key-padding.md`](stalwart-2-push-key-padding.md) | **Bug, small.** `PushSubscription/set` rejects the unpadded base64url keys that `PushSubscription.toJSON()` produces, per the W3C Push API. |
| **3rd** | [`stalwart-3-rfc9749-vapid.md`](stalwart-3-rfc9749-vapid.md) | **Feature request** (a different portal category). Implement RFC 9749 (VAPID for JMAP Web Push). Without it, Chromium and Safari cannot receive push at all — the endpoint they force a client to create is one only a VAPID signer may post to. |

### Two things that matter when posting

- **Add the `no-ai` tag to each.** The portal's own checkbox says topics are bot-triaged first.
  These are code-level reports with source citations; #3169 is what a bot does with one.
- **All three defects are present on `main` @`764c2c1` (2026-07-12)**, not only in the pinned
  fixture — so "please upgrade" is not an available deflection, and each report says so up front.
  Verified: `http.rs:117-118` still base64-encodes; `grep -ri vapid --include=*.rs` still returns 0;
  `set.rs:307` still decodes with the padded engine.

Together these are why [ADR-010](../adr/010-web-push-deferred-no-vapid.md) defers FR-NOTIF-02. If
they land upstream, the remaining work on our side is the subscription flow and a `push` listener
feeding the notification core that M3.6 already built.

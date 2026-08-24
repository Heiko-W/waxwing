# 034 — Upload progress is not available behind the `fetch` seam, and the chip says what it can instead

- **Status:** accepted
- **Date:** 2026-08-24
- **Work package:** HIG review 2026-08-24 (finding **P-13**, and the half of **D-12** that is not the contacts import)
- **Relates to:** `packages/jmap/src/transport.ts` (the seam), `packages/jmap/src/blob.ts` (`uploadBlob`),
  `apps/web/src/compose/attachment-upload.ts` (the `progress` field), FR-CMP (attachments),
  NFR-SEC-01 (auth on every request)

## Context

The attachment model carries a `progress` field, nothing renders it, and nothing ever sets it to
anything between the ends: `uploadBlob` reports `{ loaded: 0 }` before the request and
`{ loaded: total }` after it. On a phone on mobile data, a 20 MB attachment is therefore a spinning
ring for minutes with no estimate behind it. HIG `progress-indicators`: *"When possible, use a
determinate progress indicator."*

The reason is one line in `packages/jmap/src/transport.ts`:

```ts
export interface Transport {
  auth: AuthProvider
  fetch: typeof globalThis.fetch
}
```

**`fetch` has no upload-progress event.** `XMLHttpRequest` does (`xhr.upload.onprogress`), and it is
the only browser API that does. Request-body `ReadableStream`s exist, but they require
`duplex: 'half'`, are Chromium-only, and are refused over HTTP/1.1 — which is what a Stalwart behind
most reverse proxies speaks.

So a determinate bar means `uploadBlob` calling `XMLHttpRequest` directly. That is not a local
change: `Transport` is the injection seam the whole package hangs on. Every test substitutes it,
`applyAuth` runs through it, and a deployment that proxies JMAP replaces it. An `XMLHttpRequest`
inside `uploadBlob` goes around all three — the tests would need a second, different fake, and the
one place that guarantees an Authorization header on every request would have an exception in it.

The comment in `attachment-upload.ts` said something else entirely: *"the server cannot stream
upload progress"*. That is not true, and it is the more expensive kind of wrong — it names the
wrong party, so anyone who came to fix this would have gone looking at Stalwart.

## Decision

**Do not put `XMLHttpRequest` behind the seam.** The upload indicator stays indeterminate, and:

1. The chip states the **size** while it uploads, so the wait has a magnitude even without a
   percentage — a reader can tell a 20 MB attachment from a stuck one.
2. The `progress` field and the `onProgress` callback stay. They are honest about what they carry
   (start and finish), the comment now says why, and they are the seam a future channel would use.
3. Reopening this means widening `Transport` with an optional upload channel — e.g.
   `upload?: (url, init, onProgress) => Promise<Response>` — so that the substitution point stays
   one thing. That is the design a determinate bar should arrive with, not the change it should
   force on its way in.

The **contacts** import is deliberately not covered by this and did get a determinate bar: it is a
loop of one round trip per card in app code, where the total is known and every step is observable.
The **calendar** import is one `CalendarEvent/set` for the whole file — no loop, nothing to report
between the ends, and an indeterminate indicator is the correct one there too.

## Consequences

- A large attachment still shows an indeterminate spinner. It is now beside the file's size, which
  is the honest half of the answer.
- The wrong explanation is gone from the source. The next person to look at this finds the actual
  constraint (`fetch`, not the server) and the shape of the fix.
- `packages/jmap` keeps exactly one place where a request is made and authenticated, which is what
  makes NFR-SEC-01 checkable rather than believable.
- If Waxwing ever needs upload progress badly enough — a resumable-upload feature, say — the seam
  widens once and `uploadBlob` remains the only caller that knows about it.

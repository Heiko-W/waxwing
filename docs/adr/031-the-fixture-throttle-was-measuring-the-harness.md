# 031 — The fixture's rate limit was measuring the harness, not the app

- **Status:** accepted
- **Date:** 2026-08-23
- **Work package:** B53/B54 — the recurring E2E failures
- **Relates to:** `e2e/stalwart/fixture.mjs` (`RATE_LIMIT_PER_MINUTE`), `e2e/stalwart/http.mjs`
  (whose stated position this reverses), `apps/web/src/sync/engine/engine.ts` (`mailDeltaRan`),
  `apps/web/src/notify/notify-model.ts` (`floorToSecond`), B45, B53, B54, B55

## Context

Six E2E suites had been failing intermittently for months — never the same test twice, always a
timeout waiting for something to come back from the server, always green in isolation. B53 recorded
ten full runs and ~80 minutes of investigation that killed five hypotheses by measurement and ended
"what remains, unexplained". CI hid the scale of it: `retries: 2` there and `0` locally, so the same
defect read as "green with a flaky annotation" on CI and as a hard red on a developer's machine.

Forty successful CI runs carry **29 flaky attempts**. They are not evenly spread:

| Test | Flakes | First-attempt error |
|---|---|---|
| `shared.spec.ts:209` account header stays visible | 10 | `toBeInViewport()` — ratio 0 |
| `sharing-pim.spec.ts:502` choosing nobody puts the layer away | 4 | test timeout, 60 s |
| `keyboard.spec.ts:52` full triage session | 2 | `toBe()` — wrong row ticked |
| nine others | 1 each | assorted |

### What the traces said

A local reproduction of `notify.spec.ts`'s positive control captured the answer that six earlier
runs had not. The page snapshot showed the live-delivered message **sitting in the message list**
while no banner had been raised — so sync had worked and the notifier had stayed silent. The network
log said why: **nine of that context's twenty-seven JMAP requests came back `429`**, with
`retry-after: 14` and `ratelimit-policy: "requests";q=1000`.

That contradicts B53 head-on. B53 had recorded "**zero 429s**" across five instrumented runs and
concluded the app is never throttled. Both measurements are correct; the earlier one measured the
wrong thing. It timed an isolated sign-in immediately behind a full reseed, which is precisely the
moment the bucket is *fullest*. The 429s appear a hundred tests into a run, and only then.

### Why the bucket empties

Stalwart's `x:Http.rateLimitAuthenticated` defaults to `{count: 1000, period: 60000}` — 1000
requests per minute **per authenticated account**. Measured against this fixture, a full sign-in
(session, mailboxes, identities, the inbox window, threads, the email delta, address books,
calendars) is **14 requests**. A real user spends about 1.4 % of the budget and then goes quiet.

The read suite performs **108 of those sign-ins back to back in five minutes**, all as alice, plus a
full reseed before every test, serial, with no pauses. That is one account driven roughly thirty
times faster than a person can drive it, against a budget that is per account.

So the suite ran permanently at the edge of the bucket and tipped over it at random. What the app
met was not the server's real behaviour; it was a budget the previous hundred tests had spent.

## Decision

**Raise the fixture's per-account request limit to 50 000/min** (`RATE_LIMIT_PER_MINUTE` in
`fixture.mjs`, applied idempotently from `provision()` so every `up` re-establishes it), and record
here that this reverses the position stated in `http.mjs`.

That file argued — and the argument is a good one — that raising Stalwart's limit "would be the
shorter change and the wrong one … a fixture tuned looser than production hides exactly the class of
bug worth finding." Two things about it have changed:

1. Its premise was that the app was meeting *the real limit*. It was not. It was meeting a limit
   exhausted by test repetition, which is a property of the harness.
2. The argument paid off before being retired, and that is why this is a change of scale rather
   than a removal. The 429s it let through exposed a genuine product defect (below), which now has
   deterministic coverage that does not depend on the fixture being accidentally exhausted.

50 000 is still a ceiling: a runaway retry loop would have to sustain 833 requests/second to reach
it, and would still be caught. The seeders keep their own 429 retry in `http.mjs` — they are
scaffolding either way, and waiting costs them nothing.

## Consequences

### The product defect this uncovered, and where it is now asserted

`runSyncPass` reached `raiseNewMailNotifications` only on a pass that had succeeded end to end. But
`syncEmails` is the sixth of ten-odd round-trips in the delta block and it **commits**: the
envelopes land in the replica and `Email/changes` advances past them. Four more round-trips follow.
A throttle on any of those failed the *pass* long after the catch-up itself was done — and the old
arming rule ("the first **successful** pass of a leadership session is the catch-up and stays
silent") then spent the storm-guard exemption a second time, on a pass carrying genuinely new mail.

The banner was not delayed. It was gone: the retry asks the server what changed since a state that
already includes the message and is told "nothing".

Two changes in `engine.ts`, both mutation-proven in `engine.test.ts`:

- `created` is now a **sink filled by** `runDeltaBlock` rather than its return value, and
  `raiseNewMailNotifications` runs on the failure path too. Mail a partial pass committed — mail the
  reader can already see in the list — is announced.
- The exemption is spent by `mailDeltaRan` (has `syncEmails` returned once this leadership session?)
  rather than by the pass succeeding. A pass that fails **before** the mail delta still leaves the
  exemption intact, so an offline first pass does not make the real catch-up buzz.

### A second cause, which the first fix uncovered

Removing the 429s did not make `notify.spec.ts` green: one run in five still raised no banner, now
with **zero throttling in the trace**. The remaining cause was a unit mismatch.

`notifySinceMs` is stamped from the **client's** clock in milliseconds. `receivedAt` comes from the
**server** at one-second resolution — measured against Stalwart v0.16.18, which answers
`2026-08-23T11:49:02Z` for a message created at `11:49:02.015`, i.e. a stamp 15 ms *earlier* than
the moment of creation. Comparing them with a strict `>` blanked out the floor's entire second: sign
in at `…:02.500`, receive mail at `…:02.900`, and the server reports `…:02.000`, which is not
greater than the floor. No banner, no error, and no second chance — the delta had already reported
the id.

For a real reader that is a blind spot of **up to a second after every sign-in and every leadership
hand-over**, not a test artefact. `notify-model.ts#floorToSecond` truncates both sides to seconds
and moves the boundary to `>=`, which is safe precisely because mail that already existed when the
session began is silenced structurally by the catch-up guard rather than by this floor.

Why it hid behind the first cause is worth keeping: whether it bites depends on a race in
`anchorNotifyFloor`, which clamps the floor **down** to the newest `receivedAt` the replica holds.
Read an empty replica and the floor stays at the millisecond client stamp — the bug bites. Read it
after the first pass has landed the corpus and the floor drops an hour into the past — the bug
cannot bite. Two independent defects with one symptom, which is why six runs of instrumenting from
the outside never separated them.

### Bearing on the owner's report

This is very plausibly the same defect as the owner's report of 2026-08-22 — *"immer wenn man auf
Nachrichten klickt, dann dauert es häufig eine Weile bis die Synchronisierung abgeschlossen ist"* —
seen from the other side: a production server that throttles or hiccups mid-pass produces exactly
this, and the suite had been reproducing it at roughly one occurrence per hundred tests while it was
being written off as flakiness.

### The test-side defects the flake table named

Removing the throttle did not make the table empty, and the rest were genuine faults in the tests or
in the layout they exercise. Each was reproduced before it was changed:

- **`shared.spec.ts:209` (10 flakes)** searched for "the first element in the rail that overflows"
  and scrolled that. `position: sticky` resolves against the *nearest* scrollport and nothing else,
  so whenever the rail had more than one scrolling box the test scrolled a container the header was
  not sticky within — carrying it away bodily, which is the `viewport ratio 0` it kept reporting on
  a header that was behaving correctly. It now walks UP from the header to find its own scroller,
  and waits for all three account inboxes before measuring anything.
- **`sharing-pim.spec.ts:502` (4 flakes)** selected an option that the picker had not been given
  yet. `selectOption` retries until the option exists, so a picker that never fills burns the whole
  sixty-second budget and reports "Test timeout exceeded" with no hint that an option list was what
  was missing. `chooseAvailability` now asserts the option first and says so by name.
- **`read.spec.ts`'s probe folders** were created through the UI and asserted on the SERVER, with
  nothing in between. The treeitem appears optimistically while `Mailbox/set` is still in the
  outbox; when that intent met a 429 and backed off, `syncMailboxes` wrote the server's mailbox list
  over the optimistic rows and both probe folders VANISHED mid-test — the trace shows the reorder
  being announced ("ZzOne dropped") against folders the server had never heard of. `newFolder` now
  waits for the server, so the precondition fails where it belongs.
- **The shared suite's viewport** was still Playwright's 1280 default, while the read suite had been
  widened to 1440 for a measured reason (B49). Headless Chromium advertises no pointing device, so
  the rail renders its TOUCH layout — `.rowMenu` permanently visible BESIDE the unread count rather
  than overlaying it — and that layout assumes the full-width drawer. This suite is the one place
  the rail is not full-width, because the M4.4 account sections split it into three. Squeezed into
  1280 the badge and the button collide, and Playwright says so precisely: `<span class=_badge_…>2
  </span> … subtree intercepts pointer events`, retried for sixty seconds. A layout no user has: a
  desktop-width viewport claiming a coarse pointer.

### What is NOT addressed, deliberately

**The app sends one JMAP method call per HTTP request.** Measured: 14 requests, 14 method calls, for
one sign-in. JMAP exists to batch — `methodCalls` is an array and back-references are in RFC 8620 —
so the same work could be three or four round-trips. On a LAN that is invisible; over the internet
at 50 ms RTT it is most of a second of pure latency at every sign-in, and it is a plausible second
contributor to the owner's report. Batching the sync pipeline is a real refactor with real risk and
is **not** part of this change; it is recorded as its own backlog item so the measurement is not
lost.

### Risks accepted

- The fixture no longer exercises 429 handling by accident. That is the point — it now happens on
  purpose, in unit tests, on every commit. If someone deletes those tests, nothing else will notice.
- The setting lives in the fixture's RocksDB volume, not in a file. `provision()` re-establishes it
  on every `up`, and `x:Http/get` must be asked for `singleton` **by id** — with `ids: null` it
  answers with an empty list even when the object exists, which looks exactly like "not created".
- **Writing the setting is not applying it, and the gap is silent.** Measured on a fresh fixture:
  `x:Http/get` reads back `{count: 50000}` immediately, and the very next burst is still cut off at
  **999 requests** with `ratelimit-policy: "requests";q=1000`. The server answers from a config
  snapshot taken at startup, and `provision()` necessarily runs after startup. The gap is about the
  width of a short suite — `e2e:read` runs six minutes and mostly outlives it, which is why the read
  suite went green and looked like proof, while `e2e:shared` runs 1.7 minutes, sits entirely inside
  it, and kept meeting the OLD limit while the log reported the new one. `provision()` therefore
  restarts the server whenever it changed the value (`restartForConfig`), which costs ~3 s once per
  fresh fixture and makes "written" mean "in force".

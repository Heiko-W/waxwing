# ADR-025 — The calendar wire format is `jscalendarbis`, not RFC 8984

- **Status:** accepted
- **Date:** 2026-08-21
- **Work package:** Wave 1 of the JMAP gap survey — closes K-6 and K-7, feeds K-1, K-2, K-3
- **Method:** every shape below was called against a running Stalwart **v0.16.18** (probe instance
  on `:18081`) and against the **v0.16.14** fixture; `draft-ietf-calext-jscalendarbis` and
  `draft-ietf-jmap-calendars` read afterwards, to name what had already been measured

## Context

`packages/jmap/src/types/calendar.ts` used to open with a sentence that sounded like a reassurance
and was in fact the bug: *"the event payload itself is JSCalendar, which **is** final (RFC 8984)"*.
It is not what this server speaks.

Stalwart implements `draft-ietf-calext-jscalendarbis` — the revision that is meant to obsolete
RFC 8984. The differences are not cosmetic renamings a client can shrug off, because **two of them
fail silently**: the server accepts the request, answers success, and drops the data.

The survey of 21 August 2026 measured them. Two were already visible in the code as unexplained
comments. `calendar-client.ts` carried, for months, the observation that a stored series master
answered *"WITHOUT `recurrenceRules` even when asked for it"* and the conclusion that "both are
checked; only one works". The master was answering perfectly well. Nobody was asking it by its
name.

The cost so far was zero, which is why it survived: the client neither writes recurrences nor
writes participants. The cost from here is not zero. A series editor (K-2) starts by reading the
master's rule, and an invitation flow (K-3) starts by writing a participant's address. Both walk
straight into one of these.

## Decision

**The running server is the reference for the calendar wire format, not the RFC and not the
draft.** Where server and specification disagree, the client follows the server and the difference
is recorded here.

Concretely, `jscalendarbis` replaces RFC 8984 in the type. Measured, with the call and the answer:

| | RFC 8984 (what we had) | Measured on Stalwart 0.16 | How it fails |
|---|---|---|---|
| Repetition | `recurrenceRules: RecurrenceRule[]` | **`recurrenceRule: RecurrenceRule`** | **Loudly** on write — `invalidProperties: ["recurrenceRules"]`. **Silently** on read: the property is simply not in the answer, and "absent" is indistinguishable from "does not repeat". |
| Participant address | `sendTo: {imip: "mailto:…"}` | **`calendarAddress: "mailto:…"`** (a bare string) | **Silently.** `CalendarEvent/set` answers `created`; reading the event back shows no `participants` at all. The whole map is discarded without a word. |
| Organiser | — | **`organizerCalendarAddress`** | Required by the draft whenever a participant carries an address. 0.16.18's release notes name a bug where the server did not assign it *and then sent no scheduling messages*. |
| Months in a rule | (we had no `byMonth`) | **`byMonth: String[]`** | A leap month in a lunisolar calendar is `"5L"`, so this field cannot be numeric. Both specifications agree here; only our type was wrong. `byMonthDay` beside it really is numeric. |

Two more properties are the JMAP layer rather than the JSCalendar one, and the type now says which
is which — the file previously mixed them, so a reader hunting `isOrigin` in RFC 8984 would not
find it:

- **`baseEventId`** (`draft-ietf-jmap-calendars`) — *"only defined if the `id` property is a
  synthetic id"*. Stalwart sends it on **every** event an expanded query answers with:
  `{"start":"2026-09-07T09:00:00","recurrenceId":"2026-09-07T09:00:00","id":"iaaaaaf","baseEventId":"f"}`.
  It is the server stating the occurrence-to-object mapping that `resolveIdentity` had been
  reconstructing from a field-by-field signature.
- **`method`** (JSCalendar) is **immutable** here — on **create** as well as on update, which is
  not what "immutable" usually buys you. Probed against v0.16.18 on 2026-08-21:
  `CalendarEvent/set create` with `method: "request"` answers
  `{"type":"invalidProperties","description":"This property is immutable.","properties":["method"]}`,
  the same sentence an update gets. That is why `method` is in `SERVER_OWNED` and is stripped from
  the restore payload: an event that arrived by iMIP carries one, and leaving it in would have made
  the delete succeed, the Undo toast appear, and the Undo itself fail. An update naming it is
  refused with
  `invalidProperties: "This property is immutable."`

And `Calendar/get` hides half its object unless asked. With no `properties` the answer is
`id, name, description, color, timeZone, sortOrder, isDefault, isSubscribed, myRights` — and
`isVisible`, `shareWith`, `includeInAvailability`, `defaultAlertsWithTime` and
`defaultAlertsWithoutTime` are omitted. `listCalendars()` sent no `properties` at all, so adding
those five to the type without touching the request would have read `undefined` on every calendar
and looked exactly like a server that cannot hide a calendar.

**`isVisible` is read one-sidedly: only `false` means hidden.** `undefined` is "not requested, or
not implemented", and treating it as hidden empties the calendar.

## Consequences

**`baseEventId` becomes the first branch of `resolveIdentity`, and the signature join stays.** The
file header always said where a more certain branch belonged — *"beside the two branches … as a
third, more certain one — never as a replacement for them"* — and this is it. The order is now:
the server's own `baseEventId`; then an id the unexpanded query itself named; then exactly one
object carrying the same signature; then refusal.

What that buys is not tidiness. The signature join can only resolve an occurrence whose `start`,
`duration`, `title`, `calendarIds` and `showWithoutTime` still equal its master's — which is the
*first* occurrence of a series and no other. Every later one was `writeId: null`. With
`baseEventId` they all resolve, including occurrences whose master lies outside the fetched window,
which the join could never see at all. The signature stays because `baseEventId` is measured
behaviour on one version of one server, and deleting the fallback would trade a guess for a
different guess.

**Resolving is not permitting.** `refuseEdit` still answers `series` for every occurrence of a
repeating event. Making a series *addressable* is a precondition for the scope editor of K-2; it is
not that editor, and ADR-level care is worth taking here because the failure mode of getting it
wrong — a single-event patch landing on a repeating meeting — costs other people's time.

**`baseEventId` is not a recurrence flag.** Stalwart puts it on instances of events that repeat
nothing (`Principal/getAvailability` returned `{"id":"iaaaaab","baseEventId":"b"}` for a plain
single event). Reading its presence as "this is a series" would make every event in the month
read-only — a worse bug than the one it fixes. `recurrenceId` reports recurrence; `baseEventId`
reports identity.

**Both spellings of the recurrence rule are refused, only one is asked for.** `isEditable` treats a
`recurrenceRule` object *or* a non-empty `recurrenceRules` array as a series, because refusing to
edit is the safe direction and a server that volunteers the RFC 8984 name should not have its
series handed to an editor that cannot write one. But `recurrenceRules` is deliberately **not** in
the property lists: asking a `jscalendarbis` server for it is precisely how this defect began.

**What is now written down but not yet used.** `Calendar.shareWith`, `includeInAvailability` and
both `defaultAlerts*` maps are requested and typed, and no screen reads them yet — S-2 and K-1 own
that. They are requested rather than left out because the request is the part that is easy to
forget and impossible to notice.

**FR-CAL-01 was corrected alongside this** (survey finding I-4): it described the calendar as
read-only, which stopped being true on 21 August, and named RFC 8984 as the format, which was never
quite true against this server.

## Amendment, 2026-08-21 — the filter is not from either document

Building K-1 turned up a third spelling that belongs to neither draft, and it is the sharpest
illustration of why this ADR exists.

`CalendarEvent/query` is filtered by **`inCalendar`, singular, one id per condition**. The
calendars draft says `inCalendars` (plural, an array). Measured against v0.16.18:

```jsonc
filter: { inCalendars: ["g"] }  → {"type":"unsupportedFilter"}   // and see below
filter: { inCalendar:  "g"  }   → works
```

Two things make this worth an amendment rather than a code comment.

**It fails at the method level, not the condition level.** `unsupportedFilter` is returned for the
whole call, so a client that sends the draft's spelling does not get a wrong result set — it gets
no result set at all. Filtering several calendars therefore means an `OR` group of singular
conditions.

**It would have shipped.** The plan this work followed specified `inCalendars`, taken from the
draft in good faith, and the first thing that would have broken is the month view the moment
anyone hid a calendar — a whole month gone, from a feature whose entire point is hiding calendars.
It was caught by measuring, not by review.

The same session also corrected two further plan assumptions the same way: destroying a calendar
needs `onDestroyRemoveEvents: true` (else `calendarHasEvent`), and the all-day alert offsets are
`9h − 24h·n`, not `−(24n+9)h`.

## What remains unmeasured

Recorded so nobody mistakes it for verified:

- **`sentBy`** is typed on `Participant`, where both drafts define it, and was never seen on the
  wire here. The gap survey listed it as an `Event` property; that is where it is *not*.
- **The 0.16.14 fixture versus the 0.16.18 probe.** Everything in the table above behaved
  identically on both. The iMIP scheduling behaviour did not — see K-3 — which is what forced the
  fixture bump (I-1).

## Alternatives considered

**Keep RFC 8984 and translate at the seam.** A mapping layer turning `recurrenceRules[0]` into
`recurrenceRule` on the way out and back on the way in. Rejected: it makes the type a fiction about
a format nobody serves, and the translation would itself need the measurements this ADR records —
so it buys nothing except a second place for them to drift.

**Accept both names on write.** Send `recurrenceRule` *and* `recurrenceRules`. Rejected: Stalwart
rejects the whole create when the plural is present, so a request built to please both servers
pleases neither.

**Follow the draft rather than the server.** `jscalendarbis` is still a draft and will move again.
Rejected as a *general* rule for the same reason ADR-002 pins a fixture version: the thing that has
to work is the deployment, and it runs a build, not a document. Where the draft describes something
the server does not implement, the type stays quiet about it.

# 047 — The calendar merges accounts; the other rails do not

- **Status:** accepted
- **Date:** 2026-09-06
- **Work package:** #79 — a merged calendar view across accounts
- **Relates to:** ADR-018 (ids are per-account), ADR-046 (an engine per served account),
  `apps/web/src/calendar/CalendarPage.tsx`, `apps/web/src/calendar/use-calendar-events.ts`,
  `apps/web/src/sync/react.tsx` (`useCalendarsForAccounts`, `useCalendarWindowsFor`,
  `useCalendarShownFor`), `apps/web/src/sync/repo.ts` (`CALENDAR_SHOWN_KEY`)

## Context

v0.24.0 made delegated calendars reachable one account at a time: an entry per account in the rail,
`?account=` on the route, and the whole screen scoped to whichever account was named. That matched
mail and files, and it was the right size for a first step.

It is the wrong shape for a calendar. The question a shared calendar exists to answer is "when are
we all free", and a screen that shows one account at a time cannot answer it — you switch to the
team's calendar to check the team, switch back to check yourself, and hold the overlap in your head.
Every calendar application people already use merges: Apple Calendar, Fantastical, Google. Nobody
merges mail, and nobody merges files. That difference is not inconsistency; it is what the data is
for.

## Decision

**The calendar draws every calendar-serving account in one grid. The contacts, mail and files rails
keep switching.**

Three things follow, and each is a rule this codebase held until now:

- **An event carries its account.** `PlacedEvent.accountId` is required, not optional. JMAP calendar
  and event ids are per-account and short (ADR-018), so two accounts meet on `c1` routinely — and a
  chip in a merged grid has to know which client opens it, whose colour it wears, and whether the
  identical id beside it is the same event or a different one. The compiler enforces it: there is no
  way to place an event without saying where it came from.
- **Visibility is local.** The tick beside a calendar used to write the server's `isVisible`. That
  is a property of the calendar object, so switching one off is a WRITE — fine for your own
  calendars, impossible for one shared with you read-only, which is exactly the kind this view put
  on screen. A tick box that cannot be ticked on half the rows is not a tick box. Decisions now live
  in `localPrefs` under `calendar.shown`, keyed by account, and only EXPLICIT ones are stored, so
  the server's `isVisible` remains the starting value and a newly shared calendar appears without
  anyone opting in. Per device, like the theme.
- **Events wear their calendar's colour.** They did not before — the eight-colour palette existed
  only as the tick box's accent, and every chip was the same neutral surface. In a single-account
  month that was tolerable; in a merged one it is unreadable. The colour is drawn as a bar and a
  tint rather than a filled block, because the palette was designed for a white tick on a swatch and
  not for body text on a fill; the contrast reasoning is recorded in `calendar.module.css`.

`?account=` survives with a changed meaning: it POINTS rather than switches. The share card's Open
marks that account's section and switches its calendars back on if they were off; the reader's own
calendars stay where they are. Scoping the screen to the shared account would now hide the half the
reader already had in order to show them the half they came for.

## Consequences

**One account that has not answered holds the whole grid.** A merged month drawn from three accounts
of which two have replied is not "most of the answer" — it is an empty afternoon that means "you are
free" when you are not. The grid waits. This is the one place where a spinner is the honest state
and a partial draw is a lie.

**Reading N accounts costs N reads, not N subscriptions.** The replica is a single database keyed by
account, so `useCalendarsForAccounts` and `useCalendarWindowsFor` are indexed reads on one
connection. What genuinely multiplies is the network on mount: `Calendar/get` and
`ParticipantIdentity/get` now run per account. At two or three accounts that is invisible. At twenty
it would not be, and this is the ADR to revisit when someone has twenty.

**The window key is per account, and that is not a detail.** `canonicalCalendarQueryKey` hashes the
filter, the filter names calendars, and calendar ids are per-account — so the same month asked of
three accounts is three different keys. A single shared key was the first version of this and it
read one account's window under another's: no error, just an empty calendar for every account but
the first. It is the exact failure mode ADR-018 exists to name.

**What did not change.** Writes still go to the account that owns the object — one `CalendarClient`
per account, resolved from the event's own `accountId`. Moving an event BETWEEN accounts is not
offered: it is a copy plus a delete, not a `/set`, and pretending otherwise in a picker would be a
promise the protocol does not make. ICS import stays on the reader's own writable calendars.

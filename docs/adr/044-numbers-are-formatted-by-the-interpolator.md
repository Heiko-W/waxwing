# 044 — A number in a sentence is formatted by the interpolator, not by the caller

- **Status:** accepted
- **Date:** 2026-09-04
- **Work package:** follow-up to §11 *Select-all-in-folder* (R-08 stage 2) — the surface that made
  it visible
- **Relates to:** `apps/web/src/i18n/index.ts` (`registerNumberFormat`),
  `apps/web/src/i18n/formatters.ts` (`formatNumber`),
  `apps/web/src/i18n/number-format.test.ts`, ADR-042

## Context

Select-all-in-folder is the first surface in this app that regularly writes four- and five-digit
numbers at a reader: "10000 selected" is a number you have to count, "10,000 selected" is one you
read. The bundles interpolate those numbers raw, so every one of the fourteen languages got the
same digits with nothing between them — and the separator is precisely the part that belongs to the
language (`10,000` / `10.000` / `10 000` / `10 000` are each correct somewhere in this set).

`formatters.ts` has had `formatNumber` since M1: locale-aware, cached, documented. Four call sites
already use it the obvious way — format first, pass the string into `t()`.

**That way does not work for these keys.** i18next chooses the plural form FROM `count`, and a
string selects nothing. `t('list.confirmDeleteBody', { count: formatNumber(3) })` would serve one
form for 1, 2 and 5 in Russian, in a bundle that carries all four — and no English-language test
would notice, because English has no `_few` to get wrong. The counter keys (`list.selected`,
`search.results.count`, `list.confirmDeleteBody`) are exactly the pluralised ones.

## Decision

The bundles ask for the format: `{{count, number}}`. i18next resolves the plural from the numeric
`count` first and formats it on the way into the text, which is what the format spec exists for.

The `number` formatter is **overridden** to delegate to `formatNumber`. i18next v26 ships a built-in
`number` — verified by deleting the registration, whereupon the tests stay green — so this is not
about making it work. It is about the app having ONE definition of "a number as text": i18next
builds `Intl.NumberFormat` out of its own cache, `formatNumber` is the one this codebase documents,
tests and tunes, and two of them are two things that can disagree the day either grows an option. It
also formats in the language the READER is in rather than the one the string was resolved in.

Scope of the change: what the message list's action bar and its confirmations put on screen —
`list.selected`, `list.selectedOfTotal`, `list.selectAllInQuery`, `list.selectAllTooMany`,
`list.confirmDeleteBody`, and `search.results.count`, which the same component renders in the same
strip and which would otherwise stand beside a formatted number unformatted.

## Consequences

- **Both forms of number formatting now exist in the codebase**, and the rule is stated here: a
  placeholder that pluralises the sentence takes `{{x, number}}`; a caller that only substitutes a
  value may keep passing a formatted string (`QuotaPanel`, `ServerSection`, the demo mailbox list).
  A caller that reaches for the first shape on a pluralised key breaks the plural silently.
- **Not converted, deliberately:** the folder tree's unread badges, the folder- and label-delete
  confirmations, the contact importer's progress and the attachment counts. All have the same
  defect, none is this feature's surface, and a sweep is a change to twenty-odd keys that should be
  reviewed as one. Recorded here so the next reader finds a decision rather than an oversight.
- **The e2e fixture needed a fourth digit.** A 60-message folder cannot tell a formatted number from
  raw digits, so the read suite's bulk folder is 1 200 — which also makes the second step page the
  query for real (three `Email/query` calls) instead of in one go. It carries its own keyword and is
  rebuilt only when its count is wrong, because `seedReadMail()` runs before every test in those
  suites.
- **Three-digit numbers render exactly as they did**, which is what every other assertion in the
  suite depends on, and is pinned by a test of its own.

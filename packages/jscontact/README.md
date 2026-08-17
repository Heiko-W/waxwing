# @waxwing/jscontact

Bidirectional conversion between **JSContact** (RFC 9553) and **vCard 4.0** (RFC 6350), following
the normative mapping of **RFC 9555**. Zero dependencies, no DOM, no Node built-ins — the same code
runs in a browser (client-side import/export, FR-CON-06), in a worker and in a test runner.

**License: MIT** — pending confirmation of decision **D1** (implementation-plan.md §13) before the
first npm publish.

```ts
import { fromVCard, toVCards } from '@waxwing/jscontact'

const { cards, skipped } = fromVCard(fileText)   // never throws; `skipped` lists unparsable lines
const vcf = toVCards(cards)                      // one document, CRLF-delimited, folded at 75 octets
```

## What is mapped

Both directions, unless noted. The table is checked by `matrix.test.ts`, so a property that starts
or stops being supported cannot leave this document behind.

| vCard | JSContact | Notes |
|---|---|---|
| `FN` | `name.full` | Preferred over deriving a name from components; a card with only components gets a derived `FN`, because vCard 4.0 requires one. |
| `N` | `name.components` | Five positional slots → `surname`, `given`, `given2`, `title`, `credential`. A slot may carry several comma-separated values (two given names, `Dr.,Prof.`); each becomes its own component. |
| `EMAIL` | `emails` | `TYPE=home` → `contexts.private`, `TYPE=work` → `contexts.work`. |
| `TEL` | `phones` | `TYPE` splits into **features** (`cell`→`mobile`, `fax`, `pager`, …) and **contexts**. |
| `ADR` | `addresses` | Seven positional slots → `postOfficeBox`, `apartment`, `name`, `locality`, `region`, `postcode`, `country`. `LABEL` → `full`, `CC` → `countryCode`. An all-empty `ADR` is ignored rather than imported as a blank address. |
| `ORG` | `organizations` | First component is `name`; the rest become `units`, keeping the hierarchy. `SORT-AS` → `sortAs`. |
| `TITLE` / `ROLE` | `titles` | `kind: 'title'` / `kind: 'role'`. |
| `BDAY` / `ANNIVERSARY` / `DEATHDATE` | `anniversaries` | `kind: 'birth'` / `'wedding'` / `'death'`. Reduced forms are kept: `--0415` is "15 April, year withheld". |
| `NICKNAME` | `nicknames` | A comma-separated list: one property can yield several nicknames. |
| `URL` | `links` | A URI value, never text-escaped. |
| `NOTE` | `notes` | |
| `PHOTO` / `LOGO` | `media` | `kind: 'photo'` / `'logo'`. The value is a URI and is **never text-escaped** — a `data:` URI contains both `;` and `,`. |
| `CATEGORIES` | `keywords` | Comma-separated values become set keys. |
| `KIND` | `kind` | |
| `MEMBER` | `members` | Group cards (`KIND:group`). |
| `UID` | `uid` | Generated when absent, as RFC 9555 §2.1.1 requires. |
| `REV` | `updated` | |
| `PREF` parameter | `pref` | vCard 3.0's valueless `TYPE=pref` is read as `pref: 1`. |
| `PROP-ID` parameter | collection key | Written on export, so ids survive a round trip instead of being renumbered. |

## What is *not* mapped — and what happens to it

**Nothing is silently dropped.** Every vCard property this package does not understand is kept
verbatim in `Card.vCardProps` as a jCard-encoded value (RFC 7095, RFC 9555 §2.15.2), including its
parameters and its group prefix — and written back out on export. A card imported from Apple
Contacts keeps its `item1.X-ABLabel` bound to the right phone number; one from Outlook keeps its
`X-MS-*` properties through an edit-and-export cycle.

Not mapped to a typed field, and therefore travelling in `vCardProps`:

- `LANG`, `GENDER`, `TZ`, `GEO`, `KEY`, `IMPP`, `SOUND`, `RELATED`, `CLIENTPIDMAP`
- every `X-` extension
- `PRODID`, `SOURCE`, `XML`

`TZ` and `GEO` have JSContact homes (`addresses.timeZone`, `addresses.coordinates`) but only *inside*
an address, and a vCard carries them as card-level properties with no way to say which address they
belong to. Guessing would attach a timezone to the wrong one, so they are preserved verbatim instead
— the case where RFC 9555's mapping needs information the source format does not carry.

## Known limits

- **`N` position 4 → `credential`.** RFC 9555 allows honorific suffixes to become either
  `credential` or `generation`. The two cannot be told apart without a dictionary, and `credential`
  is the one that round-trips back into the same slot.
- **Structured components are joined with a space on export** when several map to the same vCard
  slot. vCard has one slot; JSContact can hold several components in it.
- **`vCardProps` keeps only the first value** of a multi-valued jCard property. Every property this
  affects is one nothing reads yet.
- **No vCard 3.0 output.** Input in 3.0 shape is read (that is what Apple, Google and Outlook emit);
  output is always 4.0.

## Conformance notes

- Folding is counted in **octets**, not UTF-16 units (§3.2), and never splits a code point.
- Unfolding removes the line break and **exactly one** whitespace character, so a continuation that
  legitimately begins with a space keeps it.
- Line endings are accepted as CRLF, LF or CR; **emitted** as CRLF.
- Structured values are split on unescaped separators *before* unescaping, so `\\;` reads as a
  literal backslash followed by a separator rather than swallowing the next component.
- A line that cannot be parsed is skipped and **reported** in `ImportResult.skipped` — a 400-contact
  export with one broken line imports 399 contacts and says so.

## Publishing (not done yet — here is exactly what is left)

This package is **not on npm**. Everything that can be prepared without a registry account is
prepared; two things are deliberately not.

**Blocked on a decision:** the MIT licence is recorded as decision **D1** in
`docs/implementation-plan.md` §13 and is not confirmed. Publishing under a licence nobody
confirmed is not a step to take quietly.

**Deliberately left in place:** `"private": true`. It is the one thing standing between a
stray `pnpm publish -r` and an unintended release. Remove it as the LAST step, not the first.

When both clear:

```sh
# 1. Confirm D1, then remove "private": true from this package.json.
pnpm --filter @waxwing/jscontact --filter @waxwing/jscontact run build
pnpm gate                       # the full pipeline, on the tree you are about to publish
pnpm publish --filter @waxwing/jscontact --access public --dry-run   # inspect the file list first
```

The `files` field ships `dist/` only. `--dry-run` is not optional politeness: it prints the
exact tarball contents, and an npm publish cannot be taken back.

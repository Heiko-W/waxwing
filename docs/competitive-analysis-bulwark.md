# Competitive analysis: Bulwark

**Date:** 2026-08-19 · **Waxwing:** v0.12.0 · **Bulwark:** v1.8.1 (2026-08-06)

Bulwark (<https://bulwarkmail.org>, AGPL-3.0) is the closest thing Waxwing has to a direct
competitor: a webmail client for Stalwart over JMAP. This document records what it does that
Waxwing does not, what Waxwing does that it does not, and — the part that decides what is worth
building — which of the gaps a static-only client can close at all.

Sources are linked inline. Everything about Waxwing is cited to a path in this repository.

## 1. The two projects are not the same shape

| | Waxwing | Bulwark |
|---|---|---|
| Runtime | Static files. No process, no database, no container | **Next.js 16 server process** required — Node ≥ 18, port 3000, reverse proxy |
| What the server does | — | Credential encryption, OAuth PKCE, runtime config, settings sync, admin/setup, plugin HTTP proxy ([architecture](https://bulwarkmail.org/docs/development/architecture)) |
| Mail traffic | Browser → JMAP direct | Browser → JMAP direct (the Node process is not a mail proxy) |
| Offline | Local Dexie replica, offline reading, offline outbox | **None.** "Mail data itself is always fetched fresh from the JMAP server" ([pwa docs](https://bulwarkmail.org/docs/features/pwa)) — the service worker caches the app shell only |
| Web Push | Contentless, direct to the browser push service (ADR-017) | Routed through the **hosted Bulwark Relay** by default (self-hostable; build-time variable) |
| Age / activity | — | Repo created 2026-03-13; 39 releases in 5 months; 136 open issues |
| Contributors | — | 60, of which one author holds 1127 of ~1400 commits |
| Third-party security audit | none | none |
| Licence | AGPL-3.0-only (2 MIT packages) | AGPL-3.0-only (fork lineage from [root-fr/jmap-webmail](https://github.com/root-fr/jmap-webmail), MIT) |

The runtime row is the whole disagreement. Several Bulwark features exist *because* there is a
server to put them on. Copying the feature without copying the server is sometimes possible
(§3), sometimes not (§5).

## 2. Feasibility: what Stalwart actually offers a static client

Verified against Stalwart `main` @ `9497a5d` (2026-08-18), release v0.16.18.

| Capability | Standard | In Stalwart | Reachable from a static client |
|---|---|---|---|
| Mail | RFC 8621 | yes | yes — already used |
| Contacts | **RFC 9610** | yes | yes — already used |
| **Sieve scripts** | **RFC 9661** (Proposed Standard, 2024) | `SieveScript/get\|set\|query\|validate` | **yes** |
| Vacation response | RFC 8621 §8 | yes | yes — already used |
| **Calendars** | `draft-ietf-jmap-calendars-28` — RFC Editor queue, **no RFC number yet** | `Calendar/*`, `CalendarEvent/*`, `ParticipantIdentity/*`, `Principal/getAvailability` | **yes** |
| iTIP/iMIP scheduling | RFC 5546 / 6047 | **server-side**, incl. HTTP RSVP links | yes — the client does not implement iMIP |
| **Files** | `draft-ietf-jmap-filenode-14` — no RFC | `FileNode/*` (README claims draft-03) | yes, with draft-drift risk |
| Sharing | **RFC 9670** | `Principal/*`, `ShareNotification/*` | yes |
| Quota | RFC 9425 | yes | yes |
| **MDN / read receipts** | RFC 9007 | **not implemented** | only by building the MIME part by hand |
| CalDAV / CardDAV | RFC 4791 / 6352 | yes | same-origin only — cross-origin is structurally blocked (no `PROPFIND`/`REPORT` in `Access-Control-Allow-Methods`, no `Access-Control-Expose-Headers` so `ETag` is unreadable) |
| ManageSieve | RFC 5804 | yes (port 4190) | no — no raw TCP in a browser. Irrelevant: JMAP Sieve replaces it |
| S/MIME, PGP | — | **encryption at rest only**; the server never decrypts and does not verify signatures | client-side crypto only |

**The conclusion that matters: not one of the missing features requires a server component of our
own.** Everything Bulwark does with mail, calendars, contacts, files and filters goes over plain
JMAP. Where Bulwark needs its Node process is auth storage, config, admin and plugins — not
features.

**The one trap:** Stalwart's encryption-at-rest encrypts *incoming plaintext* with the user's
public PGP key or S/MIME certificate. On such an account a client without PGP/S/MIME **cannot
read the mailbox at all**. That makes §4.3 a correctness issue for a class of deployments, not a
comfort feature.

## 3. Gaps — features Bulwark ships and Waxwing does not

### 3.1 Whole subsystems missing

| Feature | Bulwark | Waxwing | Waxwing's own position |
|---|---|---|---|
| **Calendar** — month/week/day/agenda, drag-to-reschedule, recurrence with scope editor, iMIP invitations, RSVP, `.ics` detection in mail, iCal/webcal subscriptions, birthday calendar, Jalali calendar | released | **nothing** — no `Calendar*` methods, no route (`apps/web/src/app/route/route.ts:18`) | spec §1.4 non-goal for V1, §10 roadmap V2 |
| **Tasks** | released (due date, priority, status) | nothing | spec §10, V2+ |
| **Files** — FileNode tree, streamed WebDAV PUT, previews, JMAP Sharing (RFC 9670), "shared with me" | released | nothing (blob transfer for attachments only, `packages/jmap/src/blob.ts`) | spec §10, V2+ |
| **Sieve filter rules** — visual rule builder, raw editor with syntax validation, round-trip preservation of foreign rules | released | **nothing but capability detection** (`packages/jmap/src/capabilities.ts`) | backlog §11, "the headline V1.x feature" |
| **S/MIME and PGP** | S/MIME released (privileged plugin since 1.7.6); PGP via community plugins; public-key management per account | nothing | spec NFR-SEC-05 (Could), V2+ |
| **Plugin/extension system** — 10 UI slots, hooks, granular permissions, sandboxing, marketplace with 14 plugins | released | nothing, and not a goal | only `config.json` + `theme.css` |

⚠️ `features.sieveEditor` is defined in `apps/web/src/app/config.ts:43` and documented in
`docs/configuration.md:142` ("Whether to offer the Sieve filter UI") — **no code reads it.** A
documented switch for a feature that does not exist.

### 3.2 Mail and compose

| Feature | Bulwark | Waxwing |
|---|---|---|
| **Multiple simultaneous accounts** | up to 5 concurrent logins, instant switching, several JMAP servers per deployment with auto-pick by domain | **one login**; delegated/shared accounts of that session do sync in parallel (`apps/web/src/sync/engine/fleet.ts`) but there is no "add account" |
| **Unified inbox** | across accounts, plus a cross-account mode (admin-gated, off by default) | none — backlog §11 (FR-MBX-05) |
| Scheduled send | released | backlog (FR-CMP-11) |
| Templates with placeholders | released | backlog (FR-CMP-12) |
| Read receipts (MDN) | released | none — and Stalwart has no JMAP MDN, so it means hand-built MIME |
| Snooze | — | backlog (FR-ORG-03) — *neither has it* |
| Pinned emails, category tabs | released | none |
| Nested tags with parent | released | flat labels with colours (`apps/web/src/mail/labels/`) |
| List-Unsubscribe one-click | released | backlog (FR-RD-09) |
| TNEF (`winmail.dat`) extraction | released | none |
| ZIP download of all attachments, `.eml`/ZIP import, forward-as-attachment | released | none |
| Print menu item | released | print CSS exists, **no menu entry** — no `print` key in `apps/web/src/i18n/locales/en/common.json` |
| `mailto:` / `webcal:` protocol handler | released | none — `apps/web/public/manifest.json` has no `protocol_handlers` |
| Saved searches | filter panel | backlog (FR-SRCH-03 remainder) |

### 3.3 Platform and ecosystem

| | Bulwark | Waxwing |
|---|---|---|
| **Languages** | **25** locales | **2** — `en`, `de` (`apps/web/src/i18n/index.ts:15`), 882 keys each |
| RTL | active for ar/he/fa with layout flip | prepared but empty: `RTL_LANGUAGES = []` |
| Themes | bundled themes, **ZIP theme upload**, admin can force a theme, per-domain branding | 3-way theme switch, 6 accent palettes, `theme.css` override, `config.json` white-label |
| Setup | **web setup wizard** since 1.6.4 — JMAP probe, OAuth discovery, branding uploads, admin password | hand-edited `config.json` |
| Admin | Stalwart admin dashboard integration, audit log, policy pages | non-goal (spec §1.4) |
| 2FA / MFA | TOTP, password & 2FA management via Stalwart admin API, structured MFA login | OAuth + Basic only |
| Native mobile | React Native/Expo app (**beta**, "do not rely on this for primary email yet") | non-goal (FR-UI-03) — responsive PWA |
| Legacy IMAP servers | Legacy Proxy (**pre-1.0**, "wire shapes can change without notice", CardDAV write path returns `forbidden`) | non-goal |

## 4. Where Waxwing is ahead

Worth stating, because these are the reasons to *not* switch to Bulwark:

1. **No server process.** One `x:Application/set` call and Stalwart hosts it. Bulwark needs Node, a
   port, a reverse proxy, four volumes and a process manager.
2. **Real offline.** Local replica, offline reading, an outbox that survives reload and reconnect,
   conflict UX. Bulwark has none of this — it caches the shell, not the mail.
3. **Push without a third party.** Contentless Web Push straight to the browser's push service.
   Bulwark's default path is the hosted Bulwark Relay, and its mobile app goes through Firebase.
4. **Verifiable releases.** `SHA256SUMS` plus `gh attestation verify --source-ref`.
5. **Test discipline as a stated rule** — a test must fail when the fix is removed (CONTRIBUTING.md);
   ~3312 unit tests, integration suites that assert they were not skipped, E2E against a live fixture.
6. **Size budget** — 256 KB gz against a 300 KB ceiling, enforced in CI.
7. **Documented refusals.** 22 ADRs saying what was not built and why.

## 5. What should not be copied

### 5.1 S/MIME and PGP: what shipped, and what a key store would take

M5.15 ships the half that needs no cryptography — recognising a signed or encrypted message from
its MIME structure and telling the reader so. That closes the worst symptom: on an account with
Stalwart's encryption-at-rest switched on, every message previously rendered as an empty body with
no explanation. M5.19 adds the other crypto-free half: the signature part is no longer listed as an
attachment. RFC 8621 puts `smime.p7s` in `attachments` because it has a blobId and no `cid`, so
every signed message was growing a file nobody could open — and "save all" was archiving it.

The remaining half is verification and decryption. Two things previously written here need
correcting, because both were estimates presented as facts.

**Bundle size is not the constraint.** `.size-limit.js` measures the EAGER chunks; every lazy
route and dialog chunk is excluded by name. A verification stack behind `import()` — loaded only
when a signed message is opened — would not touch the 300 KB budget at all. The cost is dependency
weight and maintenance, not the budget.

**The trust model is the constraint, and it is different for the two schemes.**

- **S/MIME** needs a validated certificate chain, and the browser exposes neither its root store
  nor a chain-validation API. Shipping a CA bundle is the only way to have one, and then this app
  owns a PKI trust decision on the user's behalf. A tick that means "signed by a certificate we
  could not check" reads to every user as "verified sender". That is the one failure mode worth
  refusing outright.
- **PGP** has no chain. Its answer is a key the user has accepted, which is a *public*-key store —
  no private material, so none of the shared-computer or XSS-escalation questions below apply to
  verification alone. This is genuinely buildable and is the more promising half; what it costs is
  an OpenPGP packet parser (openpgp.js is ~300 KB, lazily loaded) plus a key-import and
  key-acceptance UI.

Decryption is the part that needs private keys, and there the original three points stand:

- **A key store.** Private keys in IndexedDB as non-extractable `CryptoKey`s where the algorithm
  allows, a passphrase path where it does not, and a considered answer to what happens on a shared
  computer — the same question `FR-AUTH-09` already answers for the mail cache.
- **An XSS threat model.** Any script injected into the app document could reach the key material.
  The sandboxed body frame already isolates mail HTML; a key store raises what an escape would
  cost.
- **A recovery story.** A user who loses the key loses the mail, and the app has to say so before
  they rely on it rather than after.

That is a milestone, not a follow-up commit, and it should be scoped as one. The honest ranking
inside it: PGP signature verification first (public keys only, no new class of secret), then PGP
decryption, then S/MIME — which stays blocked on the trust root until a browser exposes one or the
project accepts owning a CA bundle.

### 5.0 Assessed and declined, with reasons (2026-08-19)

Rank 9 of the closing list was worked through item by item. Two of the four are not
implementable in this architecture at all, and two are owner decisions rather than engineering
ones. Recording that here is the point: "everything possible and sensible" needs the *not
sensible* half written down too.

**Setup wizard — not possible as Bulwark has it; the useful half now SHIPS.** Theirs writes a
config file and an admin password to disk, which requires the Node process. A static client cannot
write `config.json`; it can only read it. The half that *is* possible — a config generator — is
M5.20, in Settings → Server: it describes the server the session is already connected to, checks
OAuth discovery, shows the file, and saves it.

It reads the live session rather than probing an address the admin types, and that is the design
decision worth recording. CORS, redirects and the URLs the server advertises are exactly what the
app has already proved by rendering at all; re-deriving them from a second unauthenticated request
would describe a connection nobody has tested. What the session cannot answer — whether OAuth
discovery responds — is one fetch, and "could not check" is carried through as its own answer.
Flattening it into "no OAuth" would silently disable OAuth for a deployment that has it, from one
failed request.

**MDN / read receipts — possible, but against a stated principle.** Stalwart has no JMAP MDN
(RFC 9007), so the client would have to build the `multipart/report` itself and submit it. The
mechanism is not the obstacle: NFR-PRIV-01 says the app makes no network request the reader did
not ask for, and a read receipt is precisely a request the *sender* asked for on the reader's
behalf. Requesting one on outgoing mail is unobjectionable; *answering* one silently is not. An
owner decision, not an engineering one.

**TNEF (`winmail.dat`) — done (M5.21).** This was written off as a poor ratio, which was an
estimate about cost, not a measurement. Measured: the attachment-extraction subset of MS-OXTNEF is
one file with no dependency, and it lives in a lazy chunk that only a reader who actually opens a
`winmail.dat` ever fetches. The reader gets the invoice instead of a file they cannot open.

The ratio argument had also mis-stated the cost. Splitting it out required moving the *recognition*
predicate into its own module: a file that is both statically and dynamically imported cannot be
code-split at all, and with the two together the decoder sat in the eager bundle with no lazy chunk
emitted. That is a one-line-looking mistake worth ~0.5 KB gz on first paint, and it is invisible
without checking what the bundler actually emitted.

What is NOT decoded is the RTF body and the MAPI property tables — a large surface for no
reader-visible gain, since the message's own `text/plain` alternative already carries the text.

**Theme upload — possible, with a security caveat that has to be answered first.** Bulwark accepts
a ZIP of CSS variables. Arbitrary CSS is not inert: `background-image: url(https://…)` in a
user-supplied stylesheet is an outbound request, and a selector can be used to leak the presence
of content. A safe version restricts input to `--waxwing-*` custom properties with validated
values — which is a parser and a validator, not an unzip.



- **Plugin system.** It is the reason Bulwark needs a host-side HTTP proxy and a permission model,
  and the reason S/MIME had to become a "privileged tier". For Waxwing it would mean either giving
  up static-only or shipping an in-browser sandbox with the same key-isolation problem.
- **Relay.** A hosted push service is a server we said we would not run (spec §1.4).
- **Legacy proxy.** IMAP/SMTP bridging is a separate product, not a client feature.
- **Native app.** Explicit non-goal, and Bulwark's own is beta.
- **Admin dashboard.** Stalwart's own WebUI covers it (spec §1.4).

## 6. Ranked closing list

**Status as of 2026-08-19.** Five rows are done, one is partly done, one is assessed and
deliberately declined (§5.0), and two remain open. The table is the original ranking with the
outcome against each entry, so what is left stays legible.

| Rank | Status |
|---|---|
| 1 Sieve filter rules | **done** — M5.2, ADR-023 |
| 2 Calendar | **done** — month, week and agenda views (M5.6, M5.13); create/edit/delete for single events (M5.11). Series are read-only BY DESIGN — a recurrence scope editor is the one deliberate omission, see `isEditable` |
| 3 Multi-account | **done, by switching** (M5.10/M5.14/M5.16) — registry, derived scopes, per-account forget, add-account and a switcher. NOT concurrent sessions: one account is active at a time, so a unified inbox across accounts remains out of reach without reworking the session provider |
| 4 More languages | **pipeline done** (M5.9) — Weblate config, `docs/translating.md`, RTL scripts pre-listed. The strings themselves need speakers, not a machine |
| 5 S/MIME / PGP read + verify | **reading done** (M5.15, M5.19) — signed and encrypted mail is recognised and explained, and the signature part no longer appears as an attachment. No cryptography is performed. Verification and decryption remain, and §5.1 now says which parts are blocked on what: PGP verification is buildable (public keys only), S/MIME verification is blocked on a trust root the browser does not expose |
| 6 Files (FileNode) | **done** — M5.7; browse, upload, folders, delete, download, an inline preview (M5.17) on the reader's own policy, and RFC 9670 sharing (M5.18): a principal picker, three named roles, and grants written one at a time. Measured against the live server, which is how the `Principal/query` `name` filter was found to return nobody |
| 7 Templates, scheduled send, saved searches, snooze | **done** — M5.4/M5.5/M5.8, all four |
| 8 Small parity items | **done** — M5.3, all seven |
| 9 Setup wizard, theme upload, MDN, TNEF | **three of four settled** — the setup wizard's achievable half ships as a config generator (M5.20), and TNEF unpacking ships (M5.21). Theme upload is not implementable as Bulwark has it. MDN is the one genuine owner decision: it contradicts NFR-PRIV-01 as Bulwark implements it, and §5.0 says which half would be unobjectionable |

**On row 4.** The framework, the 882 keys and the switcher are all in place, so "add 23 languages"
is a matter of producing 23 × 882 strings. Machine-translating them would produce text nobody has
read in a program where confusing "Discard" with "Archive" costs the user a message. What is worth
building is the *pipeline* — a Weblate connection, the RTL switch, and a contributor workflow —
and then letting speakers fill it. That is the reading of "possible and sensible" this project
should take.

### The original ranking

Ordered by (reason to choose Bulwark) ÷ (cost, given §2).

| # | Gap | Why it ranks here |
|---|---|---|
| 1 | **Sieve filter rules UI** | RFC 9661 is *final*, Stalwart implements `validate`, capability detection already exists, a dead config key already promises it, and the plan already calls it the headline V1.x feature. Highest value per unit of work in the list. |
| 2 | **Calendar** | The single largest reason to pick Bulwark. Feasible over JMAP; the server does iMIP. But it is a subsystem, not a feature: route, views, recurrence, timezones, invitations. Caveat: the spec is still a draft in the RFC Editor queue. |
| 3 | **Multi-account + unified inbox** | The data layer is already account-scoped (ADR-004, ADR-008) and the engine fleet already runs one engine per account. Mostly auth storage and UI. |
| 4 | **More languages** | 2 → 25 is the most visible gap and the cheapest to close: the framework, the 882 keys and the switcher are all in place. Needs a translation pipeline (Weblate), not code. |
| 5 | **S/MIME / PGP read + verify** | A *correctness* issue where Stalwart's encryption-at-rest is on: without it the mailbox is unreadable. Security-critical, and the plugin escape hatch is not available. |
| 6 | **Files (FileNode)** | Straightforward over JMAP, but the draft is at -14 while Stalwart claims -03. Verify against a live session before committing. |
| 7 | Templates, scheduled send, saved searches, snooze | Ordinary backlog items, each small. |
| 8 | Small parity items | Print menu entry, `mailto:` protocol handler, ZIP-download of attachments, `.eml` import, forward-as-attachment, List-Unsubscribe, PWA badge. |
| 9 | Setup wizard, theme upload, MDN, TNEF | Lowest ratio; MDN needs hand-built MIME, TNEF is a decoder for a Microsoft legacy format. |

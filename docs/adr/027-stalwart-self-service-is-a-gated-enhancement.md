# ADR-027 — Stalwart's self-service registry is used, as a capability-gated enhancement; 2FA is not

- **Status:** accepted
- **Date:** 2026-08-21
- **Work package:** Account & security settings — extends §6 of the functional specification
  (FR-ACC-01..04)
- **Method:** every behaviour below MEASURED against the pinned fixture (Stalwart v0.16.18 on
  `:18080`) and cross-read in the v0.16.18 source tree; nothing taken from documentation. The
  survey it builds on is `docs/jmap-gap-2026-08-21/berichte/F-selbstbedienung.md`.

## Context

A Waxwing user could not change their own password. They could not give a phone its own credential.
They could not find out why their mailbox was unreadable when the server had been told to encrypt
it. All three are things every other webmail has, and all three are reachable over JMAP — but only
through `urn:stalwart:jmap`, a **proprietary** Stalwart extension.

Product principle 6 is the constraint:

> Standards over cleverness. JMAP RFCs and drafts only; no proprietary server extensions required.
> Stalwart-specific niceties are progressive enhancements.

It forbids *requiring* the extension, not using it. What it demands in exchange is that a server
without the URN is not merely degraded but unaffected — FR-SRV-02: "the corresponding UI is hidden,
never broken".

What the extension actually offers a NORMAL account is small and was established by probing all 117
registry object types: **six** are reachable (`AppPassword`, `ApiKey`, `AccountPassword`,
`AccountSettings`, `PublicKey`, `SpamTrainingSample`); 109 answer `forbidden`; two more
(`MaskedEmail`, `ArchivedItem`) are permitted but Enterprise-gated. There are exactly three verbs —
`get`, `set`, `query` — and singletons have no `query`.

## Decision

Ship **Settings → Account & security**: app passwords (create/list/revoke), the account password,
the language the server writes its own messages in, a read-only report of encryption at rest, and
the account's spam training samples (list/delete). Behind these choices:

1. **The capability check reads the ACCOUNT level, not the session level.** Measured: `GET
   /jmap/session` on v0.16.18 advertises 17 top-level URNs and `urn:stalwart:jmap` is not among
   them; it appears in `accounts[id].accountCapabilities` (as `{}`) and in `primaryAccounts`. A
   probe of `session.capabilities` alone therefore hides the section on the only server that has
   it. `hasCapability(session, urn, accountId)` asks both, which is the same shape
   `getMailCapability` already needed. `docs/implementation-plan.md` §11 said the opposite in its
   first half and has been corrected.

2. **The URN rides in `using` per call, never in `PREFIX_TO_CAPABILITY`.** RFC 8620 §3.3 obliges a
   server to reject a whole request carrying a `using` entry it does not know, so the derivation
   must not be able to add it by accident. Same treatment as `urn:ietf:params:jmap:emailpush`.

3. **Gating goes one level finer than the section.** The registry holds a permission per object type
   and withholds them individually — an external LDAP/SQL directory strips `sysAccountPassword*` and
   leaves everything else. A per-method `forbidden` therefore removes that BLOCK rather than failing
   the screen. Anything that is not `forbidden` is re-thrown: a broken server must not be able to
   look like a restricted one.

4. **Two-factor authentication (TOTP) is NOT shipped, although it works.** This is the load-bearing
   refusal. `x:AccountPassword/set` with `otpAuth/otpUrl` enables TOTP and was verified end to end
   in the survey — and with TOTP on, **HTTP Basic stops working for the account** (`402 MFA
   required`). `mfa_token` is filled only by the OAuth login endpoint; `authenticate.rs`, IMAP,
   POP3, SMTP and SASL all pass `None`, and there is no inline `password$code` syntax.

   Waxwing signs in over HTTP Basic (`auth/controller.ts`, `buildBasicSession`). A switch here would
   therefore lock the reader out of the client they threw it from. The obvious remedy — "use an app
   password" — is worse than the disease: an app password is a bearer of the full account rights
   that bypasses the second factor completely, so a 2FA feature whose recommended workflow is a
   long static password is not two-factor authentication. Offering it needs an MFA-capable login
   first, and the survey's own §10.1 records that the OAuth+`mfaToken` path was **not** verified.
   Until it is, "not yet" is the honest answer.

5. **Encryption at rest is reported, never switched.** `x:AccountSettings.encryptionAtRest` is
   writable by the user, and the survey proved end to end that switching it on makes delivered mail
   `multipart/encrypted`. Waxwing has no OpenPGP stack and cannot display a word of that. Offering
   the switch would mean offering to make the reader's mailbox unreadable in the app offering it —
   and switching it back does not decrypt what arrived meanwhile. So the state is shown, its
   consequence for this client is named, and the console that owns the switch is pointed at.
   `x:PublicKey` is read for the same reason (to name the key in use) and never written: the only
   purpose of uploading one is to enable the setting we decline to enable.

6. **`x:ApiKey` is not shipped.** It is the same feature as an app password with a Bearer header
   instead of Basic; its audience is scripts. Two lists of credentials that differ by an HTTP header
   is a worse settings screen than one.

7. **The account `timeZone` is not offered, and the `locale` is.** Measured in the v0.16.18 source:
   the account-level `time_zone` has exactly one consumer — the write-back into the principal record
   itself. Nothing reads it. (Calendar time zones are per-calendar, `calendar.preferences.time_zone`,
   a different field.) A control for it would be a knob that does nothing. `locale`, by contrast, is
   read by `task_manager/imip.rs` and `task_manager/alarm.rs`: it is the language of the calendar
   invitations and alarm reminders the server itself sends. The picker offers the **twelve**
   languages `resources/locales/i18n.yml` actually carries, not the enum's 336 — the other 324 fall
   back to English in silence.

8. **App-password `permissions` and `allowedIps` are reported, not edited.** Both work (an
   allowlisted password answers 403 from another address; a `Replace` permission set really narrows
   the credential). Neither is a concept a mail user has, and an IP allowlist entered in a webmail
   client is a way to lock a phone out of a mailbox from a desk. Where another tool has set one, the
   row says so, because "restricted" and "broken" look identical otherwise.

9. **No `ifInState`, and every write re-reads.** These `/get`s return no `state` string at all
   (measured), so the optimistic-concurrency machinery `identity-client.ts` and `vacation-client.ts`
   rely on does not exist here. Writes are last-one-wins. A settings patch therefore carries exactly
   **one** property: measured, a patch with one valid and one invalid field answers `notUpdated` and
   writes the valid field anyway, so a batched patch has no knowable outcome.

10. **A refusal is a translated headline plus the server's own sentence, verbatim.** `forbidden`
    means both "your current password is wrong" and "an external directory owns this password". They
    are one `type`; telling them apart means matching English server prose that is free to change
    between releases. Quoting the server is honest. Guessing and translating the guess is not.

11. **A Basic session re-authenticates after a password change.** The stored credential is now the
    wrong one and every subsequent request would 401 eventually, out of context. `reportAuthExpired()`
    — the FR-AUTH-06 funnel — asks now, and loses no drafts doing it. An OAuth session keeps its
    access token and is left alone.

## Consequences

- One new settings section, one adapter module (`stalwart-client.ts`) and one pure mapper
  (`stalwart-model.ts`). No new dependency, no crypto, nothing eager: it rides in the lazy
  `SettingsPage` chunk.
- **The wire format is Stalwart's schema generator, not JMAP convention** — sets as maps, `@type`
  variants, singleton ids, POSIX enum names. It is as drift-prone as the calendar draft, and it is
  contained in the two modules above and pinned by `stalwart-client.test.ts` against shapes measured
  from the fixture, plus one live E2E (`e2e/tests/security.spec.ts`).
- **A server without the capability is not merely degraded; the section does not exist**, down to
  its row in the settings rail. `security.test.tsx` fails if that stops being true.
- **An app-password secret is never persisted.** It lives in one component's state and is destroyed
  when the dialog closes; a test watches `localStorage`, `sessionStorage`, every `console` method and
  the DOM across the whole flow.
- **Known gap, stated rather than papered over:** "this server will refuse your password change
  because an external directory owns it" cannot be known in advance over pure JMAP —
  `x:AccountPassword/get` still succeeds for such an account, and only the `/set` fails. `GET
  /api/account` would answer it exactly, and was rejected as a proprietary REST endpoint outside
  JMAP: one extension is a progressive enhancement, two is a dependency. The reader meets it as a
  refusal carrying the server's words.

## Alternatives rejected

- **Do nothing, on principle 6.** Read as written, principle 6 permits this; and the alternative
  leaves a Waxwing user with no way to change their own password on a server that offers one.
- **Ship 2FA anyway, with app passwords beside it.** Covered in decision 4: the workaround defeats
  the feature, and the login path it needs is unverified.
- **Use `GET /api/account` to gate per feature.** Exact, and one round trip instead of five reads —
  but a second proprietary surface, outside JMAP, needing its own auth handling. Per-method
  `forbidden` gets the same answer using only the protocol this client already speaks.
- **Ship `x:MaskedEmail` (throwaway addresses) and `x:ArchivedItem` (undelete).** Both would be
  genuinely valuable; both are Enterprise-gated and answer `forbidden` on a Community server, which
  is most of them.

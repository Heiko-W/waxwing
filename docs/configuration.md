# `config.json` reference

One file, sitting next to `index.html`, read once at startup. A hoster edits it in place — **no
rebuild**, no environment variables, no template step (FR-DEP-04).

Everything in it is optional. Missing keys fall back to the values below, so a deployment that
only needs to point at a different server can be three lines.

An **unknown key** is ignored silently, so a misspelt key name still needs checking by hand. An
**invalid value** for one of the five keys that are validated — `server.sessionUrl`, `server.auth`,
`branding.defaultTheme`, `features.remoteContentDefault`, `features.imageProxyUrl` — is rejected,
named on the browser console, and falls back to its default. `sessionUrl` is the one that earned
this: a value without a scheme used to throw inside the boot path and leave the app on a spinner
forever, with nothing rendered and nothing logged.

`apps/web/src/app/config.shipped.test.ts` asserts the shipped file matches these defaults key
for key, so this page cannot quietly go stale.

```json
{
  "server": {
    "sessionUrl": null,
    "allowCustomServer": true,
    "auth": ["oauth", "basic"]
  },
  "branding": {
    "productName": "Waxwing",
    "logo": "branding/logo-icon.svg",
    "accentColor": null,
    "accentPalettes": null,
    "accentLocked": false,
    "defaultTheme": "auto",
    "links": { "imprint": null, "support": null, "privacy": null }
  },
  "features": {
    "sieveEditor": true,
    "remoteContentDefault": "block",
    "imageProxyUrl": null,
    "undoSendSeconds": 15
  },
  "offline": { "cacheDays": 30, "maxStorageMB": 512 }
}
```

## `server`

### `sessionUrl` — `string | null`, default `null`

Where the JMAP session document lives. `null` means **same origin**,
`/.well-known/jmap` — which is what the two recommended deployments produce, so most
installations leave this alone.

Set it to an absolute URL only for a cross-origin deployment, and read
[`deployment.md` §3](deployment.md#3-cdn-or-separate-web-server-cross-origin) first: Stalwart
sends no CORS headers by default, so a cross-origin `sessionUrl` fails in the browser until
the server is configured for it.

### `allowCustomServer` — `boolean`, default `true`

Whether the sign-in screen offers a server field. Leave it on for a general-purpose
deployment; turn it off when the app is bound to one server and a field would only invite
mistakes.

### `auth` — `("oauth" | "basic")[]`, default `["oauth", "basic"]`

Enabled authentication methods, **in order of preference**. The first one is the primary button
on the sign-in screen.

With `"oauth"` first and usable, the password form is **collapsed** behind a "Sign in with a
password instead" disclosure — one obvious action, the fallback one click away. That is not
cosmetic: Stalwart accepts a second factor only over OAuth, so on an account with 2FA the
password form works exclusively with an [application password](https://stalw.art/docs/auth/authentication/2fa/),
and presenting the two as equals sent 2FA users into the one path that could not work
(ADR-024). Rank `"basic"` first, or drop `"oauth"`, and the form renders open with no
disclosure at all.

**This list is not checked against the server**, and this page used to claim it was ("the first
one the server supports is the one offered"). Nothing asks the server what it supports: OAuth
discovery happens when the user clicks, not before. So on a server without OAuth, leaving the
default in place gives every user a prominent "Sign in" button that fails — it now says
the server offers no secure sign-in and points at the password form, rather than the flat
"Something went wrong" it used to, but **the operator is the one who decides**. Set
`["basic"]` for such a server.

Deliberately not auto-detected: OAuth runs through a redirect and needs no CORS, while probing the
discovery document from the page does — so a probe would hide a working OAuth button on any server
that omits CORS headers there. A wrong "unavailable" is worse than an honest failure.

Dropping `"basic"` is the harder-edged choice and often the right one: HTTP Basic sends the
password on every request, and Waxwing's own live-update path cannot use it (an SSE handshake
carries no `Authorization` header, so a Basic session falls back to a 60-second polling sweep
instead of instant push).

## `branding`

See [`theming.md`](theming.md) for the full white-label story, including `theme.css` and
replaceable assets under `branding/`.

### `productName` — `string`, default `"Waxwing"`

Shown in the header, the window title and the sign-in screen.

### `logo` — `string`, default `"branding/logo-icon.svg"`

Path relative to the app root. SVG or PNG.

**Use a mark, not a wordmark.** The header renders this image and then
[`productName`](#productname--string-default-waxwing) beside it, so a logo that already
contains your name renders it twice — which is exactly what Waxwing itself shipped with until
a screenshot for the README made it obvious. `branding/logo.svg` is still there if you want
the full wordmark; pair it with an empty `productName`.

### `accentColor` — `string | null`, default `null`

A CSS colour that overrides the accent. `null` keeps the built-in blue.

**If you set this, check its contrast.** Waxwing's six built-in palettes are each proved
against WCAG 1.4.3 as *text* and 1.4.11 as a *fill*, on four different surfaces, in both
themes — a custom colour has had none of that. The app derives a readable label colour for it
automatically, but it cannot make an accent legible against the page it sits on. A mid-tone
that looks right on white can fail on the selected-row tint, which is exactly the defect the
default blue shipped with until it was measured (3.95:1).

### `accentPalettes` — `string[] | null`, default `null`

Narrow the accent picker to a subset: `["blue", "teal"]`. `null` offers all six. A list naming
no valid palette is ignored rather than honoured — an empty picker would leave the user with
no accent and no way to tell that from a bug.

You cannot add a palette here. Every built-in one is contrast-proved; an invented one would
not be.

### `accentLocked` — `boolean`, default `false`

Remove the accent choice entirely, for a deployment with a mandated brand colour. This beats
a value a user already chose — otherwise existing users would keep overriding a brand the
hoster has since pinned.

### `defaultTheme` — `"auto" | "light" | "dark"`, default `"auto"`

`auto` follows the operating system. A user's own choice, once made, wins over this.

### `links` — `{ imprint, support, privacy }`, each `string | null`

Footer links on the sign-in screen. `null` hides that link. Useful where an imprint is a
legal requirement.

## `features`

### `sieveEditor` — `boolean`, default `true`

Whether to offer the Sieve filter UI (Settings → Filters).

Turn it off where filters are managed centrally and a per-user editor would only invite
support tickets. There is no need to turn it off for a server that cannot do filters: the
section is already hidden unless the server advertises `urn:ietf:params:jmap:sieve`
(FR-SRV-02 — an absent capability is hidden, never broken).

This used to say "turn it off where the server does not support **ManageSieve**", which named
the wrong protocol: ManageSieve runs on TCP port 4190 and is unreachable from a browser at
all. What the section needs is JMAP for Sieve (RFC 9661). The key was also read by no code
whatsoever until M5.2 — it was documentation for a feature that did not exist.

### `remoteContentDefault` — `"block" | "allow"`, default `"block"`

Whether message bodies may load remote images before the reader asks.

**`"block"` is the privacy default and changing it has a real cost:** a remote image in a
message is a read receipt the sender gets without asking, and it is how tracking pixels work.
Set `"allow"` only where the organisation has decided that trade deliberately. Note the
second-order effect documented in [`SECURITY.md`](../SECURITY.md) §1.1: blocking remote images
is what *guarantees* an `<img alt>` renders, which is one of the ways the link-phishing check
can be misled.

### `imageProxyUrl` — `string | null`, default `null`

An external privacy proxy for remote images. When set, remote images are fetched through it
rather than directly, so the sender sees the proxy rather than the reader.

### `undoSendSeconds` — `number`, default `15`

How long Waxwing holds a message before actually sending it, during which "Undo" retracts it.
`0` sends immediately.

This is the **hoster default only**. Each user can change it in Settings (off / 5 / 15 / 30 s)
and their choice wins — FR-CMP-08 is deliberate that this is a grace period the user controls,
never a lock.

## `offline`

### `cacheDays` — `number`, default `30`

How much recent mail is kept locally, in days. This is the single setting with the widest
reach in the app: the sync engine queries `inMailbox AND receivedAt >= now − cacheDays`, so it
decides what is searchable offline, what a folder shows, and how much of a shared machine's
disk holds someone's mail.

A folder whose mail is all older than this shows an empty list — with an explanation naming
this setting, rather than the flat "no messages" it used to give.

**Range: 1–3650 days.** A value above the range is clamped; a value of `0` or below is
**ignored** and the default used instead. That asymmetry is deliberate: `windowFilter` builds
`receivedAt >= now − cacheDays`, so `0` puts the boundary at today and a negative one in the
future — every mailbox would render permanently empty. An operator typo must not silently
become "keep one day of mail", so it is refused rather than approximated.

There is no way for a HOSTER to ask for no local history at all — Waxwing is offline-first and a
zero window is not a supported deployment. A **user** can, per session: ticking "Public or
shared computer" on the sign-in screen keeps the replica in a throwaway database that is removed
on sign-out, on tab close, and at the next start after a crash. See
[`SECURITY.md` §3.1](../SECURITY.md).

### `maxStorageMB` — `number`, default `512`

The local storage budget. Clamped to **50–4096 MB**, because outside that range the eviction
planner cannot honour it: below 50 MB there is not enough room for a usable window, and above
4096 MB browsers begin refusing the quota anyway.

When the budget is reached, the oldest cached bodies and attachments are evicted first —
message metadata is kept far longer, so the list stays complete while the bodies thin out.

A value outside 50–4096 is clamped to the nearest end rather than ignored (unlike `cacheDays`
above): any number in that range is a workable budget, so the nearest workable one is a fair
reading of the intent.

## Changing configuration after deployment

`config.json` is fetched at startup, so a change reaches users on their next load — **provided
it is not sitting in a cache**. Serve it with `Cache-Control: no-cache`; the nginx block in
[`deployment.md`](deployment.md#nginx) does this.

The service worker deliberately does not precache `config.json`, for the same reason.

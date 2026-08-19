# Security

## Reporting a vulnerability

Email **heiko_wilke@icloud.com** with "Waxwing security" in the subject. Please include what
you did, what happened, and what you expected — a proof of concept helps enormously, and a
`.eml` file is the most useful form for anything involving message content.

Please do not open a public issue for a vulnerability. There is no bug bounty; this is a
volunteer project, and the honest exchange is credit in the release notes if you want it.

**What to expect:** an acknowledgement within a week, an assessment within two. If a report
is valid you will hear what the fix is and when it ships. If it is not, you will hear why —
in enough detail to argue with, because more than one report that first looked invalid here
turned out to be the interesting one.

**Supported versions:** the latest release. Waxwing is pre-1.0 and there are no backports.

---

# Threat model

Waxwing is a static browser application that talks JMAP to a mail server. It has no backend
of its own, stores mail in IndexedDB, and renders message bodies written by strangers. Those
three facts generate its entire threat surface.

This document says what Waxwing defends against, what it does not, and — the part most such
documents omit — **where a defence is friction rather than a boundary**. A user who believes
a heuristic is a guarantee is worse off than one who knows they are on their own.

## 1. Malicious mail content

**The threat.** A message body is HTML from an untrusted author. Script execution, data
exfiltration through remote resources, credential phishing, layout attacks against the
surrounding app.

**Defences.**

- **Sanitizing, then a script-free frame.** `packages/mail-html` strips script, event
  handlers, forms, objects, embeds and dangerous URL schemes. The result renders in an iframe
  mounted `sandbox="allow-same-origin"` **and nothing else** — no `allow-scripts`, no
  `allow-forms`, no `allow-popups`, no `allow-top-navigation`. **No script can execute inside
  that frame**, so a sanitizer miss cannot run JavaScript at all; that is the guarantee, and
  it is stronger than sanitizing alone.

  `allow-same-origin` *without* `allow-scripts` is deliberate and is the safe half of the
  pair: it lets the outer page read the frame's height and intercept link clicks with zero
  code running inside. The dangerous combination is `allow-scripts` + `allow-same-origin`,
  which Waxwing does not use anywhere.

  Three walls, not two: the frame's own `<meta>` CSP sets `script-src 'none'`, and the app's
  CSP sits outside both.
- **Remote content blocked by default.** Images and other remote resources do not load until
  the reader asks. This defeats the tracking pixel, and it defeats a body that phones home
  with the fact that a message was read.
- **CSP.** The shipped `index.html` carries a `<meta http-equiv="Content-Security-Policy">`
  whose current text is in that file — read it there rather than here, because a copy in
  prose is a copy that goes stale. The load-bearing parts are `default-src 'self'`,
  `script-src 'self'` (no `'unsafe-inline'`, no `'unsafe-eval'`), `object-src 'none'`,
  `form-action 'self'` and `base-uri 'self'`. The last matters more than it looks: the app's
  asset resolution runs through `<base href>` (see the deployment guide), so an injected
  `<base>` would repoint every relative URL.

  **The relaxations are each named next to the policy in `index.html`, with what they cost.
  Two of them belong here.** `style-src` allows `'unsafe-inline'` (branding writes the accent
  token through `element.style`; it is deliberately not granted to `script-src`), and
  **`connect-src` is `'self' https: wss:`** — the JMAP origin comes from runtime
  `config.json` and cannot be pinned in a static `<meta>` at build time. Narrowing
  `connect-src` at deploy time is worth doing and
  [`docs/deployment.md`](docs/deployment.md#content-security-policy) shows how, but be clear
  about what it buys: **no shipped browser implements `navigate-to`**, so script running on
  this origin can still exfiltrate through
  `window.location`, a form post or a link. Tightening `connect-src` raises the cost of an
  attack; it does not close it. The boundary is `script-src 'self'`, and the reason a
  sanitizer miss is survivable is the script-free sandbox above, not the CSP.

  **An HTTP CSP header cannot loosen this policy, only tighten it.** Contrary to the folklore
  (and to what this project's own docs used to say), a header does not override a `<meta>`
  policy: CSP Level 3 enforces every delivered policy *independently*, so a resource must
  satisfy all of them and the effective policy is the intersection — verified in Chromium.
  A deployment can therefore add
  `frame-ancestors` or pin `connect-src` to one origin from a response header, and cannot
  re-widen a directive the `<meta>` policy narrowed. The Stalwart Application path (the
  recommended one) serves the zip with no hook for response headers at all, so on that path
  the `<meta>` policy is the whole policy.
- **Links open with `noopener,noreferrer`** — the opened page gets no `window.opener` handle
  and no referrer, so it cannot navigate the tab it came from or learn where it came from.

**Limits, stated plainly.**

- **Message bodies are not made accessible or safe to *read*.** The content is the sender's;
  Waxwing renders it faithfully or not at all.
- **The link-phishing check (FR-RD-08) is friction, not a boundary — and the absence of a
  warning means "nothing found", not "checked and safe".** This is the single most important
  sentence in this document. See §1.1.

### 1.1 The link check, honestly

When a link's visible text claims one host and the link opens another, Waxwing shows an
interstitial. That check compares two strings the attacker wrote — the text and the URL —
inside a rendering the attacker also styled. It is a speed bump against careless phishing,
and it is defeated by anyone who tries.

Roughly 250 attack probes across four hardening waves went into it, and **every wave's
independent reviewer found a family the previous wave had not imagined**: hidden spans,
words fused so the visible claim is replaced rather than added to, `display:none!important`,
a dozen geometric hiding vectors (`left:-9999px`, `clip-path`, `transform:scale(0)`,
`text-indent`, `max-height:0`), `alt` text on images (and Waxwing's own remote-image blocking
is what *guarantees* the alt renders — a privacy default that makes the attack reliable),
U+2800 BRAILLE PATTERN BLANK (renders as a gap, is neither whitespace nor a format character,
needs no markup at all), and U+202E RIGHT-TO-LEFT OVERRIDE.

What the hardening did achieve is real and worth stating: the quantifier was inverted so that
**every** claim in a link must be honoured rather than any one of them, claims are unioned
over two different renderings so neither fusing nor splitting alone defeats it, bidi overrides
fail closed, and the sanitizer's anchor rule became an **allowlist** of CSS properties instead
of a denylist of hiding techniques — after which the next reviewer failed to break the
property filter in 64 attempts.

But the enumeration is open, and known bypasses remain unclosed. **This document deliberately
states the *shape* of the limit rather than the current list of holes.** A list would read as
a floor — "everything else is covered" — and would become a false one the day any single item
was fixed. The shape is: *a check on attacker-controlled text, inside attacker-styled markup,
cannot be a boundary.*

The interstitial's own wording is unhedged on purpose — a warning full of caveats is a
warning nobody reads. This document is where the caveat lives.

## 2. Malicious network

**The threat.** An attacker between the browser and the mail server: reading credentials and
mail, tampering with responses.

**Defences.** HTTPS is the deployment's responsibility and Waxwing assumes it. Tokens live in
memory and in storage scoped to the origin. OAuth uses PKCE. Waxwing never sends credentials
anywhere but the configured JMAP origin.

**Limits.** Waxwing cannot detect a TLS-terminating proxy that its own trust store accepts.
No certificate pinning — the browser has no API for it. **A cross-origin deployment with
`usePermissiveCors` widens this materially**: see [`docs/deployment.md`](docs/deployment.md)
§3, which spells out that permissive CORS lets *any* origin make credentialed requests to
your mail server.

## 3. Shared device

**The threat.** Someone else uses the machine and reaches cached mail, or a session left
signed in.

**Defences.**

- **"Stay signed in" is opt-in and off by default**, so the ordinary case leaves no token
  behind.
- **A bounded offline window** (`offline.cacheDays`, 30 days by default): a shared machine
  holds a month of mail, not a decade.
- **Two sign-outs, and the difference is the point.** Plain *Sign out* ends the session and
  stops the sync engines but **leaves the local replica in place**, so signing back in does
  not re-download a month of mail. ***Sign out & remove data*** (FR-AUTH-05) additionally
  wipes every IndexedDB database, Cache Storage, and the service-worker registrations for the
  origin — and, less obviously, closes the notification banners this app put on the operating
  system's screen and cancels the Web Push subscription on the server. Both of those outlive
  a sign-out otherwise: banners reading a sender's name and subject sit in the notification
  centre across a browser restart, and a live subscription keeps waking the machine to
  announce mail for an account nobody is signed into.

**On a shared device, tick "Public or shared computer" when signing in** — see §3.1. If you did
not, *Sign out & remove data* is the way out.

### 3.1 Public-computer mode

Ticking **"Public or shared computer"** on the sign-in screen (FR-AUTH-09) puts the local
replica in a one-off database named `waxwing-replica-eph-<random>`, and removes it three ways:

1. **Sign-out** — either menu item wipes it. There is no "keep my cache" variant in this mode,
   because the whole point is not depending on the user picking the right item on the way out.
2. **`pagehide`** — a best-effort delete when the tab closes. Browsers give a page very little
   time here and `deleteDatabase` is not guaranteed to finish, which is why it is not alone.
3. **The next start** — Waxwing deletes every leftover ephemeral database before opening a
   session. This is the one that covers a crash, a killed browser or a power cut. Whoever opens
   Waxwing next on that machine clears the previous person's mail before they could look at it.

It also turns "Stay signed in" off and holds it off: the two make contradictory promises, and
leaving both on would put a refresh token on the machine you just said was not yours.

**The gap, stated rather than implied:** between a crash and that next start, the mail is on
disk. There is no browser primitive for "delete this database when the tab dies", and IndexedDB
offers no in-memory mode. The sign-in screen says as much where you tick the box.

**Limits, and they matter more than the defences.**

- **IndexedDB is not encrypted.** It cannot be: there is nowhere to put a key that an attacker
  with the same browser profile could not also reach. Anyone with access to the OS account can
  read cached mail with developer tools.
- **Public-computer mode reduces the exposure; it does not remove it.** See §3.1. Between a
  browser crash and the next time Waxwing is opened on that machine, the data is on disk, and
  someone who opens devtools in that window can read it. No browser API closes that gap.
- **Plain sign-out does not remove cached mail** — see above. It is a session boundary, not a
  data one.
- **No sign-out can clear memory** — an unlocked machine with the tab open is an open mailbox,
  which is true of every webmail client.

## 4. Hostile or compromised host

**The threat.** The static files are served by someone who alters them — a compromised CDN, a
hoster who edits the bundle, or a supply-chain attack on the build. This is the most serious
threat in this document, because a modified Waxwing sees everything the real one does.

**Defences.**

- **Verifiable artefacts.** Releases carry `SHA256SUMS`. A deployer can check what they
  received matches what was published — that is a check on the *transport and the hoster*,
  and it is the whole of what a checksum can do. See the Limits.
- **Build provenance.** The release workflow emits a Sigstore-signed SLSA provenance
  attestation (`actions/attest-build-provenance`) binding each artefact's digest to this
  repository, this workflow file and the commit it was built from:

  ```sh
  gh attestation verify waxwing-stalwart.zip --repo Heiko-W/waxwing \
    --source-ref refs/tags/v0.13.0
  ```

  This is the one control here that a checksum is not, because the signature is made by the
  runner's OIDC identity and cannot be reproduced by someone holding release rights on their
  own machine. It answers "who built it", never "is it good".

  **`--source-ref` is not optional here, and this document used to omit it.** The release
  workflow can be dispatched against a branch, and does that deliberately as a rehearsal — so
  attestations exist that name `refs/heads/main`. Without `--source-ref` the check accepts them:
  measured, exit 0 on a rehearsal artefact, and exit 1 with
  `expected SourceRepositoryRef to be refs/tags/v0.13.0, got refs/heads/main` once the flag is
  given. Whoever can push a branch here can therefore produce a zip that passes the unqualified
  command — and "whoever can push a branch" is a strictly weaker position than the release
  rights this control exists to constrain. **It starts with v0.10.0**: the
  v0.9.0 assets carry no attestation and `verify` fails on them with "no attestations found",
  which is the correct answer and not a tampering signal.
- **AGPL-3.0** obliges a hoster who modifies Waxwing to publish the modification. That is a
  legal deterrent, not a technical control, and it deters exactly the honest.
- **Reproducible-ish builds.** `pnpm release` packs a deterministic, sorted file list from a
  clean build.

**Limits.**

- **The browser will run whatever the origin serves.** Subresource Integrity protects
  *subresources* against a compromised CDN, but nothing protects `index.html` itself — the
  document that names the hashes. See §4.1.
- **A user cannot verify the app they are running.** No webmail client can offer this; it is
  the structural cost of shipping code from a server on every visit.
- **`SHA256SUMS` is worth nothing against a compromised publisher.** It is a plain
  `createHash('sha256')` over the artefacts, written by the same job that packs them; it is
  not signed. Anyone who can upload a release asset — a stolen token, a compromised
  maintainer machine, a moved action tag inside the release workflow — uploads the zip *and*
  a freshly generated `SHA256SUMS` beside it, and every `sha256sum -c` on earth passes. Of
  the three cases named in "The threat" above it covers the first two — the compromised CDN
  and the hoster who edits the bundle — and not the third, the supply-chain attack on the
  build. The attestation is what covers that one; verify it if the artefact matters.
- **`autoUpdateFrequency` is a standing decision to run future code nobody has reviewed.**
  The recommended Stalwart install points `resourceUrl` at
  `releases/latest/download/waxwing-stalwart.zip` and re-fetches weekly, which means every
  future release executes in your users' browsers, against their mailboxes, without anyone
  at your site looking at it — including a release published by whoever compromises this
  project next. That is a real convenience and a real transfer of trust, and the trade is
  yours to make rather than ours. **If it is not a trade you want: pin
  `resourceUrl` to a versioned asset** (`…/download/waxwing-stalwart-v0.13.0.zip`), drop
  `autoUpdateFrequency`, and upgrade deliberately — verifying the checksum and the
  attestation each time.
  [`docs/deployment.md`](docs/deployment.md#verifying-what-you-installed) spells out both
  forms and both commands.

### 4.1 Subresource Integrity (NFR-SEC-03)

SRI is worth using where the entry document and its assets come from **different** places —
`index.html` from your own server, `/assets/*` from a CDN. Then a compromised CDN cannot serve
a modified chunk, because the hash in your `index.html` will not match and the browser refuses
it.

SRI is worth **nothing** where both come from the same place. If an attacker can change
`/assets/index-abc.js`, they can change the `index.html` that names its hash, and they will.
This is not a subtlety to gloss over: SRI on a single-origin deployment is security theatre,
and adding it would make Waxwing's story look stronger while changing nothing.

Waxwing therefore does not emit SRI attributes by default. To add them for a split
origin/CDN deployment, hash each emitted asset and add `integrity` + `crossorigin` to its tag
in `index.html`. Both must be redone on every upgrade, since the filenames are
content-hashed.

## 5. Waxwing's own dependencies

**The threat.** A compromised npm package reaches the bundle.

**Defences.** A deliberately small dependency list. **[`apps/web/package.json`](apps/web/package.json)
is the list** — it is what the bundler reads, so it cannot drift the way a sentence here did. Two
entries deserve naming here because they are the security-relevant ones: **`oauth4webapi`**
is the OAuth/PKCE implementation (see Cryptography, below), and the four **`workbox-*`**
packages are the service worker, which controls what the browser fetches and serves from
cache for this origin. The rest is React, Dexie, DOMPurify, Squire, i18next, TanStack
Virtual, zustand, lucide icons and three workspace packages (`@waxwing/jmap`,
`@waxwing/jscontact`, `@waxwing/mail-html`). `pnpm-lock.yaml` is committed and installs are
frozen in CI. The GitHub Actions used by the release workflow are pinned to commit SHAs and
maintained by `.github/dependabot.yml` — see §4, where that pin actually matters.

**No postinstall scripts in the shipped path** — true, and worth qualifying rather than
leaving as a slogan: `pnpm-workspace.yaml` does allow exactly one install script,
**esbuild's**, which fetches its platform binary. esbuild is a devDependency of the build
toolchain and no esbuild code is in the bundle; the allowance exists because pnpm 11 fails a
`--frozen-lockfile` install outright otherwise, so a fresh clone could not build at all. It
is one named package in a reviewable file, not a blanket permission.

**Scanning (since 2026-08-18).** Dependabot **alerts** are enabled, so a CVE in any of the 621
packages in `pnpm-lock.yaml` is reported. Automated *fix PRs* are deliberately **off**, and
`.github/dependabot.yml` still does not watch npm — that file's reasoning is about a bot opening
lockfile PRs that get merged unread, which is an argument against unattended UPDATES, not against
being told. Fixes are applied by hand; six currently sit as `overrides` in `pnpm-workspace.yaml`,
each with the parent's declared range written next to it.

**Limits.** Alerts are not a scan of what actually ships: they match the lockfile, so a
build-time-only package counts the same as one in the bundle, and the triage of which is which is
a person's job. One alert is open on purpose — esbuild `GHSA-g7r4-m6w7-qqqr`, a Windows-only path
traversal in esbuild's own dev server, unreachable here (vite serves; CI is `ubuntu-latest`) and
unfixable without breaking `tsup@8.5.1`'s declared `^0.27.0`. It stays visible rather than
dismissed.

---

## What is out of scope

- **The mail server.** Waxwing is a client. Authentication, rate limits, DKIM/SPF/DMARC and
  spam filtering are the server's, and Waxwing reports what the server tells it.
- **Spam and malware classification.** Waxwing shows what is in the mailbox and does not
  judge it, beyond the link friction described in §1.1.
- **The user's browser and OS.** A compromised browser defeats every control here.

## Cryptography

Waxwing implements none of its own. TLS is the browser's, OAuth/PKCE uses `oauth4webapi`,
Web Push uses the browser's VAPID implementation (RFC 9749), and hashing at build time uses
Node's `crypto`. There is no home-grown cryptography anywhere in the codebase, which is a
deliberate absence rather than an oversight.

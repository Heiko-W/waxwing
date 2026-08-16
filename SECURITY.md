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
- **CSP.** The shipped `index.html` sets `default-src 'self'; script-src 'self'; object-src
  'none'; base-uri 'self'; form-action 'self'` among others. `base-uri 'self'` matters more
  than it looks: the app's asset resolution runs through `<base href>` (see the deployment
  guide), so an injected `<base>` would repoint every relative URL.
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

**On a shared device, use *Sign out & remove data*.** Plain sign-out is the right default for
your own machine and the wrong one for someone else's.

**Limits, and they matter more than the defences.**

- **IndexedDB is not encrypted.** It cannot be: there is nowhere to put a key that an attacker
  with the same browser profile could not also reach. Anyone with access to the OS account can
  read cached mail with developer tools. Waxwing is not appropriate for an untrusted shared
  machine, and no setting makes it so.
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
  received matches what was published.
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

**Defences.** A deliberately small dependency list (the shipped bundle carries React,
TanStack Virtual, Dexie, DOMPurify, i18next, Squire, zustand, lucide icons and two workspace
packages). `pnpm-lock.yaml` is committed and installs are frozen in CI. No postinstall scripts
in the shipped path.

**Limits.** No automated dependency-vulnerability scanning runs today. Adding one is
worthwhile and is not done.

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

# Deploying Waxwing

Waxwing is a **static** application: HTML, JavaScript, CSS and a service worker. There is no
Waxwing server, no database and no backend to run. Everything it does, it does in the browser
against your JMAP server.

That makes deployment easy in one way and awkward in another. Easy: any web server can host
it. Awkward: a browser will not let a page at one origin talk to a server at another unless
that server says so, and **Stalwart does not say so by default** (measured against v0.16.x —
see [Cross-origin](#3-cdn-or-separate-web-server-cross-origin) below). So the deployment
question is really an *origin* question, and the three options below are three answers to it.

| | Same origin? | Needs Stalwart config? | Best for |
| --- | --- | --- | --- |
| [1. Stalwart Application](#1-stalwart-application-recommended) | yes | one JMAP call | almost everyone |
| [2. Reverse proxy](#2-reverse-proxy-same-origin) | yes | no | you already run nginx/Caddy |
| [3. CDN / separate host](#3-cdn-or-separate-web-server-cross-origin) | **no** | `usePermissiveCors` | a CDN you already pay for |

**In a hurry?** [One command](#the-whole-installation-in-one-command) installs Waxwing on
Stalwart and keeps it updated. The rest of this page is for everyone else.

Releases live at
[github.com/Heiko-W/waxwing/releases](https://github.com/Heiko-W/waxwing/releases). You can
also build them yourself from a clean checkout with `pnpm install && pnpm release` — the same
script the release workflow runs, so the output is the same shape.

---

## 1. Stalwart Application (recommended)

Stalwart can serve a static bundle from its own origin. Nothing else has to exist — no
second web server, no proxy, no CORS — and the app and the JMAP endpoint are same-origin by
construction.

### The whole installation, in one command

Stalwart fetches the app itself, straight from GitHub. Nothing to download, nothing to unpack,
nothing to host:

```sh
curl -u 'admin:PASSWORD' -X POST https://mail.example.com/jmap/ \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core"],
    "methodCalls": [["x:Application/set", {
      "create": {
        "waxwing": {
          "enabled": true,
          "description": "Waxwing webmail",
          "resourceUrl": "https://github.com/Heiko-W/waxwing/releases/latest/download/waxwing-stalwart.zip",
          "urlPrefix": { "/webmail": true },
          "autoUpdateFrequency": 604800000
        }
      }
    }, "c1"]]
  }'
```

Restart Stalwart, open `https://mail.example.com/webmail/`, sign in. That is the installation.

### …and it keeps itself up to date

The two fields that do it:

- **`resourceUrl` points at `releases/latest/download/`**, whose asset name never changes.
  Every release publishes `waxwing-stalwart.zip` alongside the versioned
  `waxwing-stalwart-vX.Y.Z.zip`, precisely so this URL keeps resolving.
- **`autoUpdateFrequency`** is milliseconds. `604800000` is a week; use `86400000` for daily.
  Stalwart re-fetches on that cycle and serves the new build.

So a Waxwing release reaches your users without you doing anything. **Omit
`autoUpdateFrequency` if you would rather not have that** — then Stalwart fetches once and
holds still until you change `resourceUrl` yourself. Pinning a version is the same idea:
point `resourceUrl` at `…/download/waxwing-stalwart-v0.14.0.zip` and it stays there.

Users are not interrupted by an update. The service worker installs the new build in the
background and Waxwing offers a reload; nobody loses a half-written message.

### Verifying what you installed

Auto-update means your server fetches a file you have not personally checked, which is worth
being deliberate about. There are two checks and they answer **different** questions.

**1. Did the file arrive intact?** Every release carries `SHA256SUMS`:

```sh
curl -LO https://github.com/Heiko-W/waxwing/releases/latest/download/waxwing-stalwart.zip
curl -LO https://github.com/Heiko-W/waxwing/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

The versioned and unversioned zips are byte-identical — the release script copies rather than
re-packs, and refuses to publish if their hashes differ — so checking one checks the other.

**2. Was it built here?** `SHA256SUMS` cannot tell you that: it is unsigned, and whoever can
replace the zip can replace the checksum file next to it. Releases therefore carry a
Sigstore-signed build-provenance attestation, made by the GitHub runner's own identity:

```sh
gh attestation verify waxwing-stalwart.zip --repo Heiko-W/waxwing \
  --source-ref refs/tags/v0.14.0
```

**Give `--source-ref`, and name the tag you are installing.** Without it the check passes for
anything this workflow built from *any* ref, branches included — and branch builds exist, because
the workflow is dispatched as a rehearsal on purpose. With it, a rehearsal artefact is rejected:
`expected SourceRepositoryRef to be refs/tags/v0.14.0, got refs/heads/main`.

It then passes only for a file built by this repository's release workflow, from that tag. It starts with v0.10.0 — on the v0.9.0 assets it reports "no attestations found",
which is the truthful answer and not a tampering signal.

Neither check says the code is *good*; both say where it came from. See
[`SECURITY.md`](../SECURITY.md) §4.

**If you would rather not accept future builds sight unseen**, do not use
`releases/latest/download/` plus `autoUpdateFrequency`. That combination is a standing decision
to run whatever this project publishes next, in your users' browsers, against their mailboxes.
Pin instead:

```jsonc
"resourceUrl": "https://github.com/Heiko-W/waxwing/releases/download/v0.10.0/waxwing-stalwart-v0.10.0.zip"
// and omit autoUpdateFrequency entirely
```

Then upgrading is a deliberate act: verify the new artefact with both checks above, change the
URL, restart. Or go further and host the zip yourself — download it, verify it, put it on your
own server and point `resourceUrl` there. Everything above still works; only the fetch moves.

### Installing from a file instead

If your Stalwart cannot reach GitHub, `resourceUrl` takes any HTTP URL it *can* reach —
including one on your own network. It does not have to be HTTPS and does not have to be
public. Keep the `.zip` extension; Stalwart keys off it.

**Verified end to end** against a clean Stalwart v0.16.14 with the real release artefact:
`/webmail/` serves the app, `/webmail/inbox` serves it too (deep-link reload), `sw.js` arrives
as `application/javascript` and `manifest.json` as `application/json`.

Four details in that body are load-bearing, and three of them were wrong in this guide until
they were probed against a live server:

- **`description` is REQUIRED.** Omit it and the call answers
  `validationFailed / {"type":"Required","property":"description"}` — nothing more. It appears
  in no documentation we could find.
- **`urlPrefix` takes a LEADING SLASH**: `{"/webmail": true}`. Stalwart's own WebUI registers
  `{"/admin": true, "/account": true}`. Without the slash the call is accepted without
  complaint and the mount does not work — the worst of both.
- **Do not use `/mail`.** It is reserved: the Application registers, Stalwart fetches the
  archive, and every path under it 404s silently — no log line, nothing unpacked. The same
  artefact under `/webmail` works. (This cost a day; it is recorded as B43.)
- **Stalwart fetches the archive at STARTUP**, not when you register it. Restart the server, or
  wait for `autoUpdateFrequency`, before concluding that anything is wrong.
- **`resourceUrl` keeps its `.zip` extension.** Stalwart fetches it with a 60 s timeout and
  refuses bundles over 100 MiB (Waxwing's is well under 1 MiB).
- **`autoUpdateFrequency`** is optional. Set it and Stalwart re-fetches the URL on that
  schedule, which is how you ship an update without touching the registry again.

**Step 3 — open `https://mail.example.com/webmail/`.** Waxwing finds the JMAP session document
at the same origin and you sign in.

### What Stalwart rewrites, and why the app depends on it

The built `index.html` contains the literal token `<base href="/">`. Stalwart rewrites *that
exact string* to `<base href="/webmail/">` when it serves the bundle under a prefix. Everything
else in the app resolves relatively through `document.baseURI` — the asset URLs, the service
worker's scope, the manifest's `start_url`, the offline navigation fallback.

If that token is missing or written differently (single quotes, a non-root path), a deep-link
reload under `/webmail/inbox/…` resolves `./assets/*` against the route path and the app fails
to load — while the first visit works fine, which makes it a confusing thing to debug. The
release script asserts the token is present; you should not need to think about it.

### Fonts and the manifest

Stalwart serves `.webmanifest` and `.woff2` as `application/octet-stream`, which browsers
refuse. Waxwing therefore ships its PWA manifest as **`manifest.json`** and uses no
self-hosted `.woff2`. Nothing to configure — noted because it looks like an oversight
otherwise.

---

## 2. Reverse proxy (same origin)

If you already run nginx, Caddy or Traefik in front of Stalwart, serve Waxwing's static files
from the same hostname. Same-origin again, so no CORS, and you keep full control of caching
and headers.

Unpack **`waxwing-web-vX.Y.Z.tar.gz`** into a document root (it has no leading directory):

```sh
mkdir -p /srv/waxwing && tar -xzf waxwing-web-v1.0.0.tar.gz -C /srv/waxwing
```

### nginx

```nginx
server {
    server_name mail.example.com;

    # JMAP first — these paths belong to Stalwart, not to the app.
    # `proxy_buffering off` is REQUIRED, not tuning: /jmap/eventsource/ is the live channel,
    # and with nginx's default buffering the response never reaches the browser at all.
    location /jmap/  { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host;
                       proxy_buffering off; proxy_read_timeout 1h; }
    location /auth/  { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
    location /.well-known/jmap { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }

    # …then the app. `try_files` sends unknown paths to index.html so a deep-link
    # RELOAD (/mail/inbox/abc) is served by the app rather than 404ing.
    root /srv/waxwing;
    location / { try_files $uri $uri/ /index.html; }

    # The service worker must not be cached, or a released update can take a week to reach
    # anyone. The hashed assets can be cached forever, because their names change.
    location = /sw.js       { add_header Cache-Control "no-cache"; }
    location = /config.json { add_header Cache-Control "no-cache"; }
    location /assets/       { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

**Why `proxy_buffering off` is in that block and not offered as a tuning tip.** The live channel
is `/jmap/eventsource/`, a response that never ends. With nginx's default buffering the browser
does not get a *late* update — it gets **no response header at all**; measured against a real
Stalwart, nothing after 12 seconds, where the direct connection answers 200 in under a
millisecond. Waxwing then falls back to a 60-second polling sweep, so the deployment looks like it
works and is simply always a minute stale. This page used to describe that as "delays every push
until the buffer fills … if live updates feel late", which is both the wrong mechanism and the
wrong severity. `proxy_read_timeout 1h` keeps nginx from cutting the idle stream at its 60-second
default.

### Caddy

```caddy
mail.example.com {
    handle /jmap/* { reverse_proxy 127.0.0.1:8080 }
    handle /auth/* { reverse_proxy 127.0.0.1:8080 }
    handle /.well-known/jmap { reverse_proxy 127.0.0.1:8080 }
    handle {
        root * /srv/waxwing
        try_files {path} /index.html
        file_server
    }
}
```

### Serving from a subdirectory

The `<base href="/">` token described above is written for a root mount. Serving the app at
`https://example.com/webmail/` means editing that one line in `index.html`:

```html
<base href="/webmail/" />
```

Do this **before** the first load, and re-do it after every upgrade. The service worker's
scope is derived from it, so changing it later leaves a worker registered at the old scope.

---

## 3. CDN or separate web server (cross-origin)

Waxwing on `app.example.com`, Stalwart on `mail.example.com`. This is the option with a real
trade-off, and it is worth stating plainly before you choose it.

**Measured against Stalwart v0.16.11 with default configuration:** no route emits any
`Access-Control-Allow-*` header. `/jmap/`, `/jmap/eventsource/`, `/jmap/ws`, `/jmap/session`
and `/auth/token` all answer an OPTIONS preflight with `204` and zero CORS headers. A browser
therefore blocks every cross-origin call Waxwing makes, including the SSE reader. **Waxwing
will not work cross-origin without server configuration.** It will look like a hung sign-in.

Two ways out:

**a. `usePermissiveCors` on Stalwart.** It emits permissive CORS headers on the JMAP routes.
Understand what it permits: *any* origin may make credentialed requests to your mail server.
A malicious page in a tab your user has open can then talk to Stalwart with their session.
Waxwing itself has no way to narrow this — it is the server's decision. Consider it acceptable
only where you also control what your users' browsers load.

**b. A CORS-adding reverse proxy in front of Stalwart**, echoing exactly one origin:

```nginx
add_header Access-Control-Allow-Origin "https://app.example.com" always;
add_header Access-Control-Allow-Credentials "true" always;
add_header Access-Control-Allow-Headers "authorization,content-type" always;
if ($request_method = OPTIONS) { return 204; }
```

This is strictly better than (a) — one named origin instead of all of them — and is the
recommended form if you must go cross-origin at all.

**Our recommendation is option 1 or 2.** Cross-origin buys you a CDN's edge cache for about
400 KB of static files, at the cost of loosening your mail server's origin policy. That is
rarely a good trade.

---

## Configuration

`config.json` sits next to `index.html` and is read at startup, so a hoster can change it
**without rebuilding**. Every key is optional — the shipped file is the full set with its
defaults, and a deployment that only needs to point somewhere else can be three lines:

```json
{
  "server": { "sessionUrl": "https://mail.example.com/.well-known/jmap" }
}
```

`null` (the shipped value) means same-origin `/.well-known/jmap`, which is what both
recommended deployments produce — so most installations need not set this at all.

**[`configuration.md`](configuration.md) is the full reference**, key by key, with the ranges
and the reasoning. [`theming.md`](theming.md) covers branding, `theme.css` and the replaceable
assets.

Keep `config.json` out of long-lived caches (the nginx block above does). Otherwise a change
here reaches returning users whenever their cache happens to expire.

## Content Security Policy

Waxwing ships its own CSP as a `<meta http-equiv="Content-Security-Policy">` in `index.html`,
so **every deployment has one** — including the Stalwart Application path, where you never
touch a web server. Nothing below is required to make the app safe; it is what a deployment can
add on top.

### A response header can only tighten it — never loosen it

This is the part that surprises people, and it is the opposite of what "the header overrides the
meta tag" would suggest. CSP3 enforces multiple policies **independently**: a resource has to
satisfy *all* of them, so the effective policy is the intersection (verified in Chromium).
Consequences, both directions:

- You **can** narrow `connect-src`, or add a directive the `<meta>` policy does not name.
- You **cannot** widen anything. If a future Waxwing release ships a CSP that is too strict for
  your setup, a response header will not repair it — the only fixes are editing the `index.html`
  you serve, or an upstream release.

The practical trap: **do not restate the whole policy in the header.** Any fetch directive you
omit from a policy falls back to that policy's `default-src`, so a header reading
`default-src 'self'; connect-src …` silently forbids the `data:`/`blob:` images and the frames
the app's own policy permits — and the app breaks in ways that look like a caching bug. A header
that names **only** the directives it wants to change, with no `default-src`, leaves every other
directive to the `<meta>` policy and is the form that keeps working across upgrades.

### The two things only a header can do

`frame-ancestors` is not permitted in a `<meta>` policy at all, and `connect-src` cannot be
pinned at build time because the JMAP origin comes from runtime `config.json`. So:

**nginx** — add to the `server` block from [§2](#2-reverse-proxy-same-origin):

```nginx
add_header Content-Security-Policy "connect-src 'self' https://mail.example.com wss://mail.example.com; frame-ancestors 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```

**Caddy** — inside the `handle` block that serves the app:

```caddy
header {
    Content-Security-Policy "connect-src 'self' https://mail.example.com wss://mail.example.com; frame-ancestors 'self'"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
}
```

Both list `wss:` explicitly, and **for a browser deployment that is unnecessary** — the entry is
harmless, so it is left in rather than churned, but the reason given here was wrong.

Waxwing's live channel in a browser is **SSE**, not a JMAP WebSocket. `engine.ts` allowlists
`['sse', 'polling']` and deliberately excludes WebSocket: a browser cannot set `Authorization` on a
WS upgrade and Stalwart offers no token fallback, so RFC 8887 can never authenticate here (decision
D2 at G1, ADR-005 — and the allowlist is a *restriction* rather than a `prefer`, so that a failing
SSE never strands the session on a transport that is terminal by construction). SSE is an ordinary
`fetch`, governed by the `https://` entry beside it.

So there is no "disabled WebSocket push" setting to correspond to dropping `wss://` — that
sentence described a switch this app does not have.

### What narrowing `connect-src` actually buys

Less than it looks, and it is worth knowing before you count on it. It stops a hypothetical
injected script from `fetch()`ing your users' mail to an attacker's server. It does **not** stop
that script exfiltrating: no shipped browser implements `navigate-to`, so `window.location`, a
form submission or a generated link still reaches any origin, and `form-action 'self'` only
covers the second of those. Narrowing `connect-src` raises the cost of an attack; it is not a
boundary. The boundary is `script-src 'self'` in the app's own policy.

### The Stalwart Application path cannot do this today

Stalwart serves the zip's contents directly and exposes no hook for adding response headers to
an Application's routes. On that path the `<meta>` policy is the entire policy: `frame-ancestors`
is unset and `connect-src` stays `'self' https: wss:`. If either matters to you, put a reverse
proxy in front ([§2](#2-reverse-proxy-same-origin)) and add the headers there, or edit the
`<meta>` tag in the `index.html` inside the zip before you host it yourself — and re-do that edit
on every upgrade, which is the usual reason not to.

## Upgrading

1. Publish the new artefact.
2. Stalwart Application: re-`set` the `resourceUrl`, or let `autoUpdateFrequency` do it.
   Reverse proxy: unpack over the docroot.
3. Users get the update on their next visit. The service worker installs in the background
   and Waxwing offers a reload — it does not swap the app out from under someone mid-message.

Asset filenames are content-hashed, so an old page never loads a new chunk by accident.

## Verifying a deployment

```sh
# The session document must be reachable from the app's origin.
curl -sI https://mail.example.com/.well-known/jmap

# index.html must be served for a deep link, not a 404.
curl -sI https://mail.example.com/webmail/inbox

# The service worker must be served as JavaScript, not octet-stream.
curl -sI https://mail.example.com/webmail/sw.js | grep -i content-type
```

Then sign in, open a message, and reload the page while it is open. That last step is the one
that catches a broken `<base href>`, and it is the failure mode most likely to reach a user
before it reaches you.

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

Release artefacts are built by `pnpm release`, which writes them into `dist-release/` together
with a `SHA256SUMS`. Verify what you downloaded before you deploy it:

```sh
sha256sum -c SHA256SUMS
```

> **There is no published release yet.** Waxwing has no GitHub repository at the time of
> writing (ADR-003), so "download the release" means "build it": `pnpm install && pnpm release`
> produces both artefacts from a clean checkout. This document is written for the published
> case because that is what it will be — but it would be dishonest to link a page that does not
> exist.

---

## 1. Stalwart Application (recommended)

Stalwart can serve a static bundle from its own origin. Nothing else has to exist — no
second web server, no proxy, no CORS — and the app and the JMAP endpoint are same-origin by
construction.

Take **`waxwing-stalwart-vX.Y.Z.zip`**. It differs from the tarball in exactly one way that
matters: `index.html` sits at the zip root. Stalwart serves the archive as it finds it, so
one wrapping directory puts every path off by a segment.

**Step 1 — put the zip somewhere Stalwart can fetch it.** Any HTTP URL it can reach. It does
not have to be HTTPS, and it does not have to be public — a URL on your own network is fine.
Keep the `.zip` extension; Stalwart keys off it.

**Step 2 — register it.** There is no REST settings API in v0.16.x. An Application is a JMAP
registry object, created with a `POST` to `/jmap/`. Recovery-admin HTTP Basic is enough (it
holds `SysApplicationCreate`):

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
          "resourceUrl": "https://files.example.com/waxwing-stalwart-v1.0.0.zip",
          "urlPrefix": { "/webmail": true }
        }
      }
    }, "c1"]]
  }'
```

The WebUI (*Settings › Web Applications*) and `stalwart-cli` do the same thing.

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
    location /jmap/  { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
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

The SSE endpoint (`/jmap/eventsource/`) is a long-lived response. nginx buffers by default,
which delays every push until the buffer fills — add `proxy_buffering off;` to the `/jmap/`
block if live updates feel late.

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

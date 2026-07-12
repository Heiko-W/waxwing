# @waxwing/web

The Waxwing SPA — a static, serverless webmail client for JMAP (AGPL-3.0). Built with
React 19 + Vite 8 (see [ADR-001](../../docs/adr/001-vite-8-instead-of-vite-7.md)).

## Development

From the repo root (`pnpm install` once), or from this directory:

```sh
pnpm --filter @waxwing/web dev        # Vite dev server (HMR)
pnpm --filter @waxwing/web build      # production build -> dist/
pnpm --filter @waxwing/web preview    # serve the built dist/ locally
pnpm --filter @waxwing/web typecheck  # tsc --noEmit (strict)
```

The build uses `base: './'`, so `dist/index.html` references assets with **relative**
URLs. That is required for Stalwart's `<base href>` rewriting and lets the same artifact
run under any path prefix (FR-DEP-02).

## The mount prefix: `<base href>` (read this before deploying)

`index.html` ships a literal **`<base href="/" />`**, and every relative URL in the app —
the hashed assets, `config.json`, `theme.css`, `branding/`, the service-worker scope, the
manifest's `start_url` — resolves through it.

- **Stalwart Application:** nothing to do. Stalwart rewrites that exact token to the prefix
  it serves the app under (`<base href="/mail/">`).
- **A static host serving the app from the origin root:** nothing to do.
- **A static host serving the app from a subdirectory** (`https://host/webmail/`): **edit that
  one line** to `<base href="/webmail/" />`. Also configure the SPA fallback so unknown paths
  return `index.html` — the router is history-based.

It is not decoration. Without it, a deep-link reload (`/mail/inbox/42`) resolves
`./assets/index-*.js` against the *route* path: the SPA fallback answers with `index.html`,
the browser refuses it as an ES module, and you get a white screen. `config.json` and the
OAuth `redirect_uri` misresolve the same way.

One consequence to know about: a bare fragment link (`href="#main"`) now resolves against the
mount root, not the current URL — so the skip link performs its own jump in an `onClick`
rather than letting the browser navigate.

## Content Security Policy

The production CSP ships as a `<meta http-equiv="Content-Security-Policy">` in
`index.html` (no inline script, no `eval` — NFR-SEC-01):

```
default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self';
form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
font-src 'self'; connect-src 'self' https: wss:; frame-src 'self'
```

- **`frame-ancestors` must be set by the server** via an HTTP response header — it
  cannot be expressed in a `<meta>` CSP. Deployments should send it (e.g.
  `frame-ancestors 'self'`) to control who may frame the app.
- **`connect-src 'self' https: wss:` is intentionally broad.** The JMAP server origin
  comes from runtime `config.json`, so it cannot be pinned in a static `<meta>` CSP at
  build time. The trade-off is that an injected script could open connections to any
  `https`/`wss` host. **Narrow this at deploy time** by sending an HTTP
  `Content-Security-Policy` response header — which takes precedence over the `<meta>`
  policy — with `connect-src` pinned to the specific JMAP origin. This is expected for
  same-origin (Stalwart Application) and reverse-proxy deployments. `script-src` stays
  fully strict (`'self'`), so this does not open a script-injection path.
- **`style-src 'unsafe-inline'` is required, not accidental.** Branding sets the accent
  custom property via `element.style` (`theme.ts`) and React/CSS Modules emit inline
  styles. It is a lower-severity vector than script injection and is intentionally **not**
  granted to `script-src`. It could be tightened later by writing the accent into a
  generated `<style>` on `:root` instead of a per-element inline style.
- **Subresource Integrity (NFR-SEC-03)** for the app's own hashed JS/CSS is a
  release-phase follow-up (a build-time plugin that adds `integrity`+`crossorigin` to the
  emitted tags); it deliberately does **not** apply to `config.json`/`theme.css`, which
  are network-first and meant to diverge per deployment.
- The **dev server** (`vite.config.ts`) uses a deliberately looser CSP: Vite's HMR needs
  `'unsafe-inline' 'unsafe-eval'` in `script-src` and `ws:` in `connect-src`. This never
  ships to production.

## Runtime configuration (never precached)

`config.json` (see functional-spec §9), `theme.css`, `manifest.json` and the `branding/`
assets live next to `index.html` and are fetched **network-first at boot**. They are
**never** added to the service-worker precache, so hosters can rebrand, repoint the
server, or restyle without a rebuild or a new release (FR-DEP-04, FR-THEME-01/02). Never
import `config.json` at build time.

## PWA (M3.5)

`vite-plugin-pwa` in **`injectManifest`** mode: the worker is our own TypeScript
(`src/sw/sw.ts`), bundled to `dist/sw.js`. Its URL contract — every rule about which URL may
be cached and how — is a set of pure functions in `src/pwa/sw-routes.ts`, so the guarantees
below are unit-tested rather than eyeballed.

| | |
|---|---|
| **Precached** | `index.html` + `assets/**` — content-addressed, so a deploy invalidates them wholesale. |
| **Network-first** (`waxwing-deploy`) | `config.json`, `theme.css`, `manifest.json` |
| **Stale-while-revalidate** (`waxwing-branding`) | `branding/**` |
| **Never touched** | everything else — above all **JMAP**. |

Three things are load-bearing and easy to break:

1. **The worker caches zero bytes from JMAP,** and that is enforced *structurally*: the cache
   predicates match only paths inside the app's own directory (the worker reads it from
   `self.location`). Do not "simplify" them into a basename or substring test. A download URL's
   path is chosen by the server and its last segment is the attachment filename, chosen by
   whoever sent the mail — a basename test would cache an attachment named `config.json` as if
   it were ours: authenticated plaintext mail in Cache Storage, outside the AES-GCM SecretStore
   and outside the cache budget.
2. **The runtime caches are warmed at `install`.** They have to be: a runtime cache is only ever
   written for pages the worker *controls*, and the page that registers it is not one of them.
   Without the warm-up, the first controlled load — typically the first offline launch of the
   freshly installed app — finds them empty and boots on the built-in defaults.
3. **`skipWaiting()` only on the user's word.** A worker that activates under a live tab drops the
   old precache, and the routes, the composer and the dialogs are all lazy chunks: that tab's next
   `import()` 404s. The update is offered as a toast; accepting it flushes open drafts first.
   `ChunkErrorBoundary` is the net under all of this.

The **manifest is a deployment file**, not a build artifact — a white-label hoster edits `name`,
`short_name`, the colors and the icons in `public/manifest.json` with no rebuild. It is `.json`
and not `.webmanifest` because Stalwart serves the unknown extension as
`application/octet-stream`.

Icons are committed PNGs. Regenerate them after changing a source SVG in `assets/logo/`:

```sh
node scripts/icons.mjs   # 192 / 512 / maskable-512 / apple-touch-180
```

There is **no service worker in `pnpm dev`** (`devOptions.enabled: false`) and none under
`pnpm test` (`vitest.config.ts` merges `vite.config.ts`, so the plugin is explicitly disabled
when `VITEST` is set).

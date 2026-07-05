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

`config.json` (see functional-spec §9) and the optional `theme.css` and `branding/`
assets live next to `index.html` and are fetched **network-first at boot**. They are
**never** added to the service-worker precache, so hosters can rebrand, repoint the
server, or restyle without a rebuild or a new release (FR-DEP-04, FR-THEME-01/02). Never
import `config.json` at build time.

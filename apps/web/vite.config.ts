import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// The dev-only SP.4 raw demo (apps/web/src/demo). When `VITE_WAXWING_DEMO=1` is set (by
// scripts/demo.mjs), the demo is served AND a same-origin reverse proxy to the Stalwart
// fixture is switched on. Both are keyed off this one flag so a normal `pnpm dev` never
// proxies or ships the demo. The demo bundle itself is additionally hard-gated on
// import.meta.env.DEV so it is dead-code-eliminated from every production build (src/main.tsx).
const DEMO = process.env.VITE_WAXWING_DEMO === '1'

// Where the same-origin proxy forwards Stalwart's paths. Default is the P0.4 fixture's
// loopback listener; overridable so the demo can point at another JMAP server.
const PROXY_TARGET = process.env.WAXWING_PROXY_TARGET ?? 'http://127.0.0.1:18080'

// The exact set of paths Stalwart needs for the demo, verified empirically against
// v0.16.11: JMAP (`/jmap`, incl. the `/jmap/ws` WebSocket), RFC 8414/OIDC discovery
// (`/.well-known`), the OAuth token/register/introspect endpoints (`/auth`), the browser
// login SPA (`/login`) with its POST target (`/api/auth`) and logo (`/logo`). None collide
// with Vite's own dev paths (`/@vite`, `/@fs`, `/@id`, `/src`, `/node_modules`), so the HMR
// client and module server keep working. Absolute session/OIDC URLs are made same-origin by
// setting STALWART_PUBLIC_URL to the browser origin (see e2e/stalwart/docker-compose.yml),
// so the browser only ever talks to this dev server — no CORS, no cross-origin loopback.
function demoProxy(target: string): Record<string, ProxyOptions> {
  const http: ProxyOptions = { target, changeOrigin: true }
  const ws: ProxyOptions = { target, changeOrigin: true, ws: true }
  return {
    '/jmap': ws,
    '/.well-known': http,
    '/auth': http,
    '/login': http,
    '/api': http,
    '/logo': http,
  }
}

// The dev/E2E Stalwart fixture (e2e/stalwart/docker-compose.yml). Its OIDC issuer, token,
// refresh and revocation endpoints — and every JMAP request — live at this cross-origin,
// plain-HTTP loopback target, which matches none of 'self'/ws:/wss:/https:. It must be
// named explicitly in the dev connect-src or the browser blocks oauth4webapi's discovery /
// code exchange / refresh the moment the SP.4 login UI drives the flow (the auth module
// already opts into insecure loopback via allowInsecureRequests). DEV-ONLY: this origin is
// NEVER added to the production <meta> CSP in index.html, which stays same-origin/https.
const DEV_STALWART_ORIGIN = 'http://localhost:18080'

// Dev-server CSP.
//
// This is intentionally LOOSER than the production policy shipped in index.html.
// Vite's dev server injects an inline HMR bootstrap and evaluates transformed
// modules, so `script-src` must allow 'unsafe-inline' and 'unsafe-eval', and the
// HMR client opens a WebSocket, so `connect-src` must allow ws:. None of this ships
// to production: the built bundle is governed by the strict <meta> CSP in index.html
// (no inline script, no eval — NFR-SEC-01). Keeping dev as close to prod as HMR allows
// surfaces genuine CSP violations early instead of at release time.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  `connect-src 'self' ws: wss: https: ${DEV_STALWART_ORIGIN}`,
  "frame-src 'self'",
].join('; ')

// base: './' emits relative asset URLs so the bundle works under any path prefix,
// which is required for Stalwart's <base href> rewriting (FR-DEP-02).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    headers: {
      'Content-Security-Policy': DEV_CSP,
    },
    // Same-origin reverse proxy to Stalwart — demo-only, so a normal dev server is untouched.
    ...(DEMO ? { proxy: demoProxy(PROXY_TARGET) } : {}),
  },
  build: {
    target: 'es2022',
  },
})

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
  },
  build: {
    target: 'es2022',
  },
})

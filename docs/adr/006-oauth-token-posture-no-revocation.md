# 006 — OAuth token posture: no server-side revocation; local-wipe logout

- **Status:** accepted
- **Date:** 2026-07-10
- **Deciders:** SP.5 implementer — the constraint is forced by the live evidence below
  (Stalwart v0.16.11 exposes no token-revocation and no RP-initiated-logout endpoint, and
  issues non-rotating, non-`client_id`-bound refresh tokens). This ADR records the resulting
  security posture and ratifies the behaviour already in `apps/web/src/auth/`. **Owner review
  at Gate G1.**

## Context

FR-AUTH-03 stores the OAuth refresh token encrypted-at-rest so Waxwing can silently re-login
and start offline; FR-AUTH-05 requires logout to "wipe everything"; NFR-SEC-02 forbids tokens
in `local`/`sessionStorage`. `apps/web/src/auth/oauth.ts` already carries a `revokeToken()`
that no-ops when the server advertises no `revocation_endpoint`, and `controller.ts` logout
falls back to a local store wipe. SP.5 probed the pinned fixture (Stalwart **v0.16.11-alpine**)
to settle whether that fallback is the *normal* path or an edge case, and what a leaked refresh
token is actually worth. Findings (live, with the negative probes that would falsify them):

- **No revocation, no RP-initiated logout.** Neither `/.well-known/openid-configuration` nor
  `/.well-known/oauth-authorization-server` lists a `revocation_endpoint` or an
  `end_session_endpoint`. Adversarial `POST /auth/revoke`, `/auth/revocation`, `/oauth/revoke`
  → **404**. There is an RFC 7662 `introspection_endpoint` (`/auth/introspect`, needs auth) —
  validation, not revocation.
- **Refresh tokens are durable bearer-equivalents.** A minted access token is **opaque**
  (`sw1.…`, not a JWT), `expires_in=3600`. On refresh the response contains **no** new
  `refresh_token` (Stalwart rotates only within ~4 days of the 30-day expiry), the **same**
  refresh token is accepted **repeatedly**, and a refresh with the **wrong `client_id`** — or
  **none at all** — still returns 200. So possession of the refresh token alone grants ~30 days
  of sliding access that the server cannot be asked to cut short.
- **No client pre-registration is required** (the arbitrary `client_id` `waxwing` is accepted),
  and RFC 7591 dynamic registration, while present at `/auth/register`, is open (unauthenticated
  → 201) and refuses `:5173` loopback redirect URIs — so registering buys nothing here.

## Decision

Waxwing does **not** rely on server-side token revocation and does **not** call an
RP-initiated-logout endpoint against a baseline (v0.16.x) Stalwart:

1. **Logout is a local wipe.** `controller.logout()` best-effort calls `revokeToken()` (which
   fires only if a `revocation_endpoint` is ever advertised — e.g. a future Stalwart or an
   external OIDC provider) and then destroys the encrypted `SecretStore` (refresh token, Basic
   credentials, PKCE, wrapping key) and clears the in-memory access token. "Logged out" means
   *this device can no longer authenticate*, not *the token is dead server-side*.
2. **The encrypted store is the security boundary for the refresh token.** Because the token is
   non-revocable and non-rotating, its confidentiality at rest (the non-extractable AES-GCM
   `CryptoKey` in IndexedDB, per ADR-004 / NFR-SEC-02) is the primary control. This is why the
   token must never touch `local`/`sessionStorage` and why a plain-http (insecure-context) LAN
   origin — where `crypto.subtle` is absent — deliberately gets **no** persistence (SP.4).
3. **Threat model documents the residual risk.** The M4.9 security docs state plainly that a
   refresh token exfiltrated from a compromised device grants access for up to its remaining
   lifetime with no server-side kill switch on baseline Stalwart; mitigations are device
   security, short-lived access tokens (already 1 h), and — for deployments that need
   revocation — delegating Stalwart auth to an external OIDC provider that offers RFC 7009.

## Consequences

- Matches the code already shipped in SP.2/SP.3; no code change in SP.5. `revokeToken()` stays
  as forward-compatibility for a server that later advertises revocation.
- Logout cannot invalidate other sessions or a stolen token — surface this honestly in the UI
  copy and the security/threat-model doc (M4.9); do not imply a server-side sign-out.
- If **D3** raises the baseline to Stalwart v1.0 and it adds RFC 7009 revocation / RP-initiated
  logout, revisit: `revokeToken()` would then activate automatically from discovery, and logout
  could additionally revoke. Re-probe the discovery documents at that point.
- Feature-detection (FR-SRV-02) already covers this: revocation is used iff advertised, so no
  behaviour is hardcoded to Stalwart's current gaps.

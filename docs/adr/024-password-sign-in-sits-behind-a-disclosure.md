# 024 — Password sign-in sits behind a disclosure; only OAuth can carry a second factor

- **Status:** accepted
- **Date:** 2026-08-19
- **Deciders:** Heiko (owner), after the first real deployment (`mail.hcw-orange.media/webmail`)
  refused his correct password. The layout choice is his; the constraint below is the server's.

## Context

The sign-in card offered two buttons of equal weight: **"Sign in securely"** (OAuth 2.0 +
PKCE, FR-AUTH-03) above a full username/password form ending in **"Sign in with a password"**
(HTTP Basic, FR-AUTH-04). A labelled separator between them named the difference as *"or with a
password"*.

That presented a protocol detail as a choice, and on an account with 2FA it is not a choice —
it is a trap. Stalwart's documentation is explicit: *"Two-factor authentication can only be
used with mail clients that support OAuth and the `OAUTHBEARER` or `XOAUTH2` SASL mechanism."*
HTTP Basic has no channel for a second factor, so an account with TOTP enabled gets its
**correct** password refused, and the only password that works there is an **Application
Password**. The owner hit exactly this on the first deployment: he read the two buttons, picked
the one that looked like an ordinary login, and was told his credentials were wrong.

The obvious-looking alternative — collect username, password and a TOTP code in Waxwing's own
form — is not available to a static client. The second factor is only reachable through the
authorization server's own login page; there is no JMAP or Stalwart API that accepts
password + TOTP directly. Driving Stalwart's login form from the client would mean scripting a
page we do not own, which is fragile and a poor security posture. The flow the owner asked for
therefore **already exists** — it is the OAuth redirect — and the defect was that nothing on
screen said so.

## Decision

1. **One action leads.** When OAuth is listed first AND usable (a secure context, so PKCE can
   run), the primary button is plain **"Sign in"**, with a line under it that says what it
   does: *"You sign in on {host} itself — with your password and, if your account uses one,
   your two-factor code."*
2. **The password form is a disclosure.** It collapses behind *"Sign in with a password
   instead"* and opens on demand, moving focus into the username field. Its hint states the
   server's behaviour rather than a preference: with 2FA on, the account password is refused
   here and an app password is what works.
3. **The fallback stays first-class where it is the way in.** If OAuth is absent, ranked
   second, or unusable (insecure origin), the form renders open with no disclosure at all — a
   collapsed control the reader must discover would be a dead end, not a simplification.
4. **A 401 on the password path says the second thing it can mean.** `auth.error.invalidCredentialsBasic`
   names 2FA and app passwords; the OAuth path keeps the plain wording, because there a 401
   really is a rejected credential.
5. **The heading names the host, not the product** — *"Webmail for {host}"*. The one open
   question on this screen is which server is about to receive the password.

## Consequences

- The 2FA user reaches a working flow by pressing the only prominent button. The app-password
  user is one click from the form, and the reason is written where they will be looking.
- **Point 5 would have re-opened [B12](../implementation-plan.md)** — the product NAME is no
  longer in the heading, and FR-DEP-04 wants a white-label deployment identifiable on exactly
  this screen. Settled the same day by the owner: the configured **logo** now sits above the
  heading, with the configured product name as its alt text. Brand and host each say their own
  thing, and both remain the hoster's to configure (`branding.logo`, `branding.productName`);
  a deployment that configures no logo gets none.
- Every E2E suite signs in through the collapsed form now, via `revealPasswordForm()` in
  `e2e/tests/helpers.ts` — tolerant by construction, so a Basic-first or insecure-origin
  fixture (where the form is already open) still works.
- Nothing about the auth mechanics changed: the same two `AuthController` paths, the same token
  posture (ADR-006), the same FR-AUTH-09 public-computer semantics governing both.
- If Stalwart ever accepts a second factor over Basic — or the deployment fronts an OIDC
  provider with passkeys (FR-AUTH-03's passkey note) — only the copy needs revisiting; the
  redirect flow already inherits whatever the authorization server offers.

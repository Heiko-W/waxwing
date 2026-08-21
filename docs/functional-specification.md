# Waxwing — Functional Specification

| | |
|---|---|
| **Project** | Waxwing — a serverless webmail client for JMAP |
| **Version** | 0.2 |
| **Date** | 2026-07-05 |
| **License** | AGPL-3.0 |
| **Status** | Accepted (initial open questions resolved, see §11) |

---

## 1. Vision & Positioning

**Waxwing is a webmail client that runs entirely in the browser.** It is delivered as a set
of static files (HTML, CSS, JavaScript) and talks directly to a JMAP server — no
middleware, no PHP, no Node backend, no database of its own. The JMAP server *is* the
backend.

The primary target server is [Stalwart](https://stalw.art), which can host Waxwing itself
through its *Applications* feature (static SPA bundles mounted on the mail server's own
HTTP listener). Larger installations can serve the same files from any CDN or web server.
Waxwing works against any RFC-compliant JMAP server, but is developed and tested against
Stalwart first.

### 1.1 Why this doesn't exist yet

Classic webmail (Roundcube, SnappyMail, SOGo) predates JMAP and requires a server-side
component that speaks IMAP/SMTP and renders or proxies for the browser. JMAP (RFC 8620/8621)
removes that need: it is JSON over HTTPS, designed for exactly this kind of client — the
server parses MIME, the client receives structured JSON. Stalwart's own webmail is planned
(Rust/Dioxus) but not started as of mid-2026; the third-party options either require their
own server container or are early experiments. A polished, static-only, installable PWA
webmail is an open gap.

### 1.2 Product principles

1. **Zero backend.** If it can't be done with static files + JMAP, it is out of scope or an
   explicitly documented optional integration.
2. **Calm, minimalist design** in the spirit of Apple's Human Interface Guidelines: content
   first, generous whitespace, restrained color, fluid motion, no visual noise.
3. **Fast by default.** Instant navigation, virtualized lists, offline cache. The app must
   feel native, not like a website.
4. **Private by default.** Remote content blocked, no telemetry, no third-party requests,
   everything stays between browser and mail server.
5. **Themable and white-label friendly.** Hosters can rebrand via configuration and CSS
   without forking.
6. **Standards over cleverness.** JMAP RFCs and drafts only; no proprietary server
   extensions required. Stalwart-specific niceties are progressive enhancements.

### 1.3 Target users

| Persona | Needs |
|---|---|
| **Self-hoster** (runs Stalwart for family/friends) | One-file deployment, works out of the box from the Stalwart instance, low maintenance |
| **Small business / association** | Multiple users, shared mailboxes, branding, vacation responder, sieve rules without SSH |
| **Hosting provider** | CDN delivery, white-labeling, theming, config-driven defaults, multi-domain |
| **End user** | A mail app that looks and feels like a modern native client, installable on desktop and phone |

### 1.4 Non-goals (V1)

- No server-side component of any kind (no image proxy, no push relay, no search index).
- No IMAP/SMTP/POP support — JMAP only.
- ~~No calendar UI in V1~~ — **superseded (M5.6).** A read-only calendar (month + agenda)
  ships against `urn:ietf:params:jmap:calendars`; see FR-CAL-01 in §6. The non-goal stood on
  the assumption that calendars needed CalDAV, i.e. XML over WebDAV verbs a browser cannot
  send cross-origin. JMAP for Calendars removed that obstacle entirely.
- No server administration (Stalwart's own WebUI covers that).
- No built-in AI features; no telemetry/analytics.
- No support for non-evergreen browsers (see §8.4).

---

## 2. Deployment & Runtime Model

### FR-DEP — Deployment

- **FR-DEP-01 (Must)** — The release artifact is a single archive of static files with an
  `index.html` entry point, deployable to any static host.
- **FR-DEP-02 (Must)** — A release variant is packaged as a Stalwart *Application* bundle
  (zip with `index.html` at the root) so Stalwart can mount it at a configurable URL prefix
  (e.g. `/mail` or `/`). The app must tolerate `<base href>` rewriting by Stalwart and work
  under any path prefix.
- **FR-DEP-03 (Must)** — All app assets are served from the app origin. No CDN fonts, no
  external scripts, no runtime third-party requests.
- **FR-DEP-04 (Must)** — Deployment configuration lives in a single `config.json` next to
  `index.html` (see §9). The same build artifact serves all installations; no rebuild for
  rebranding or server URL changes.
- **FR-DEP-05 (Should)** — Cross-origin deployment (app on a CDN or static host such as
  GitHub Pages, JMAP server elsewhere) is supported and documented. Note: Stalwart's CORS setting is currently all-or-nothing
  (`usePermissiveCors`); the docs must explain the trade-off and the reverse-proxy
  alternative. Same-origin deployment via Stalwart Applications is the recommended default.
- **FR-DEP-06 (Must)** — The app is a Progressive Web App: installable (manifest + service
  worker), standalone display mode, app icons, splash/theme colors.

### FR-SRV — Server compatibility

- **FR-SRV-01 (Must)** — Baseline: any server implementing RFC 8620 (Core) + RFC 8621
  (Mail incl. submission and vacationresponse capabilities).
- **FR-SRV-02 (Must)** — Feature detection via the JMAP Session capabilities object. Every
  feature beyond the baseline (WebSocket, Blob, Quota, Sieve, Contacts, …) degrades
  gracefully when the capability is absent: the corresponding UI is hidden, never broken.
- **FR-SRV-03 (Must)** — Respect all session limits (`maxSizeUpload`,
  `maxObjectsInGet`, `maxCallsInRequest`, `maxSizeRequest`, …) automatically by chunking
  requests.
- **FR-SRV-04 (Should)** — A "server capabilities" panel in settings shows which optional
  features the connected server offers (diagnostics for admins).

---

## 3. Onboarding, Authentication & Session

### FR-AUTH

- **FR-AUTH-01 (Must)** — **Same-origin autoconnect:** when served by the mail server
  itself, the app discovers the JMAP session at the relative `/.well-known/jmap` — the user
  only ever sees a login form, never a server URL field.
- **FR-AUTH-02 (Must)** — **Manual connect:** for CDN/cross-origin deployments the user can
  enter their email address or a server URL. Discovery order: pinned URL from
  `config.json` → `https://{mail-domain}/.well-known/jmap`. (DNS SRV discovery is
  impossible in browsers; document this.)
- **FR-AUTH-03 (Must)** — **OAuth 2.0 Authorization Code + PKCE** as the primary flow,
  using the server's RFC 8414 metadata (Stalwart is a full OIDC provider). Tokens are held
  in memory; the refresh token is persisted encrypted-at-rest in IndexedDB (see TECH doc
  §security) to enable silent re-login and offline start.
  *Passkeys note:* how the user authenticates on the authorization server's login page
  (password, TOTP, **passkeys/WebAuthn**) is the server's concern — the redirect flow
  inherits it with zero client changes, which makes this architecture passkey-ready by
  design. Status today: Stalwart's built-in login offers password + TOTP only; passkey
  login is achievable now by delegating Stalwart's authentication to an external OIDC
  provider with WebAuthn support (Keycloak, Authentik, Pocket ID, …). A static client
  cannot implement WebAuthn itself (the ceremony needs a server-side verifier).
- **FR-AUTH-04 (Should)** — **HTTP Basic fallback** (opt-in via `config.json`) for minimal
  setups without OAuth; credentials stored only if the user chooses "stay signed in".
  The UI encourages app passwords when 2FA is active — and, where OAuth leads, keeps the form
  collapsed behind a disclosure, because Stalwart carries a second factor over OAuth only
  (ADR-024).
- **FR-AUTH-05 (Must)** — Clean logout: revoke tokens where supported, wipe all local data
  (IndexedDB, caches, service-worker state) on request ("Sign out & remove data").
- **FR-AUTH-06 (Should)** — Session expiry / password change is handled gracefully:
  re-auth prompt without losing unsent drafts.
- **FR-AUTH-07 (Could)** — Multiple simultaneous accounts (different servers) with fast
  switching. V1 ships single sign-in; the data layer must be account-scoped from day one so
  multi-account is additive later.
- **FR-AUTH-08 (Should)** — **Shared accounts:** accounts beyond the primary one exposed in
  the JMAP session (delegation/sharing, e.g. via Stalwart's JMAP Sharing support) appear as
  additional mailbox trees, read/write according to server-granted rights.
- **FR-AUTH-09 (Should)** — **Public-computer mode:** an opt-in choice at sign-in, applying to
  **both** sign-in methods, that keeps the local replica in a throwaway database and keeps the
  credential out of storage entirely (Basic: no persisted credentials; OAuth: refresh token in
  memory, no auth record — so a cold start cannot restore the session). The replica is removed on
  sign-out (either variant), on `pagehide`, and by a sweep at the next application start — the last
  covering a crash, which the other two cannot. Mutually exclusive with "stay signed in". The UI
  must state the residual exposure (between a crash and the next start the data is on disk) rather
  than implying a guarantee the browser cannot give.

  > Numbered 09, not 07. It shipped as FR-AUTH-07 and collided with the multi-account requirement
  > above, which is older and is referenced from ADR-004, ADR-008 and the data layer — an ambiguous
  > ID is worse in the requirement that carries a security promise, so this one moved.

---

## 4. Mail — Core Experience

### 4.1 FR-MBX — Mailboxes (folders)

- **FR-MBX-01 (Must)** — Hierarchical folder tree with unread/total counts, live-updated
  via push. JMAP roles (`inbox`, `archive`, `drafts`, `sent`, `junk`, `trash`) map to
  fixed, localized, iconographic entries; custom folders below.
- **FR-MBX-02 (Must)** — Create, rename, move, delete folders (with confirmation when
  non-empty); honors `mayXXX` rights per mailbox (ACLs on shared mailboxes).
- **FR-MBX-03 (Should)** — Drag & drop messages onto folders; drag folders to re-parent.
- **FR-MBX-04 (Should)** — Collapsible tree state and per-folder display preferences
  persisted locally.
- **FR-MBX-06 (Should — shipped M5.3)** — Import `.eml` files into a folder via
  `Email/import` (RFC 8621 §4.8), gated on `myRights.mayAddItems`. `Email/import` rather
  than `Email/set create` because it keeps the original bytes: headers, signatures and MIME
  structure survive exactly, which is the entire point of restoring an archived message.
  Files are imported one at a time so a partial failure names the file that failed.
- **FR-MBX-05 (Could)** — "Unified inbox" virtual view across accounts (once FR-AUTH-07
  lands).

### 4.2 FR-LST — Message list & threading

- **FR-LST-01 (Must)** — Virtualized message list that stays at 60 fps with mailboxes of
  100 000+ messages; incremental loading via `Email/query` + `queryChanges`.
- **FR-LST-02 (Must)** — Conversation threading using JMAP `Thread` objects; toggle to a
  flat per-message view (global and per-folder).
- **FR-LST-03 (Must)** — Each row: sender, subject, server-provided preview snippet, time
  (relative, localized), unread/flag/attachment/answered indicators, avatar (initials or
  contact photo — never remote images).
- **FR-LST-04 (Must)** — Multi-select (click, shift/ctrl, select-all-in-folder) with bulk
  actions: read/unread, flag, move, archive, junk, delete.
- **FR-LST-05 (Must)** — Sorting: date (default), from, subject, size; unread-first toggle.
- **FR-LST-06 (Should)** — Swipe gestures on touch devices (configurable actions, e.g.
  archive / delete / read), matching platform conventions. A direction whose target role
  mailbox the account does not have is **inert** — the row does not follow the finger and no
  action strip is revealed — and is never **substituted** with a different mailbox: a gesture
  the user configured as "Archive" must not move mail to Trash (ADR-014).
- **FR-LST-07 (Should)** — Density options (comfortable / compact) and reading-pane
  layouts: right, bottom, off (list-only, message opens full-screen).
- **FR-LST-08 (Could)** — Sectioned list grouping ("Today, Yesterday, This week…").

### 4.3 FR-RD — Reading messages

- **FR-RD-01 (Must)** — Render HTML mail **safely**: sanitized and isolated (sandboxed
  iframe with its own strict CSP; no script execution, no top-navigation, styles cannot
  leak in or out). Plain-text mails render with clickable links and quoted-text folding.
- **FR-RD-02 (Must)** — **Remote content is blocked by default** (images, external CSS).
  Per-message "load remote content" with per-sender "always allow" list (stored locally).
  Clear privacy explanation in UI.
- **FR-RD-03 (Must)** — Inline images (`cid:`) resolve via JMAP blob download URLs;
  attachments list with type icons, size, and actions: download, view (images/PDF inline
  preview), save-all.
- **FR-RD-04 (Must)** — Conversation view: collapsed older messages, expandable, with
  quoted-text folding inside each message.
- **FR-RD-05 (Must)** — Standard actions: reply, reply-all, forward, archive, delete,
  junk/not-junk, move, flag, mark unread, print (clean print stylesheet).
- **FR-RD-06 (Should)** — Header details on demand (full from/to/cc, date, message-id,
  authentication results if exposed); "View source" / download as `.eml` (an authenticated
  download of the Email's own `blobId` — see [ADR-011](adr/011-eml-download-needs-no-blob-capability.md):
  `downloadUrl` is mandatory in RFC 8620, so no Blob-capability gate exists or is needed).
  Authentication results are reported **neutrally and attributed** — never as a verdict:
  the header is forgeable by the sender (RFC 8601 §7.1) and JMAP exposes no trusted
  `authserv-id`, so only the topmost instance is read and the reporting host is always named.
- **FR-RD-07 (Should)** — Attached messages (`message/rfc822`) open in-app as nested
  message views.
- **FR-RD-08 (Should)** — Phishing friction: visually distinguish display name vs. actual
  address on hover/tap; warn when a link's text and target host differ.
  **This is friction, not a boundary, and the distinction is a decided one (Gate G2,
  2026-07-23; §13 row B19).** The check compares the host the link text claims against the host
  it opens, and both come from text the attacker writes — including the CSS. It was hardened
  substantially in the G2 review and twelve named ways past it remain open. The interstitial's
  own copy is left unhedged, because it is accurate whenever it appears; what needs saying is
  that its **absence** means "nothing found", not "checked and safe", and that belongs in the
  release notes and security guide (M4.9) under NFR-PRIV-02 — not inside the one dialog that is
  warning a reader correctly.
- **FR-RD-09 (Could)** — Honor `Reply-To`, `List-Unsubscribe` (one-click unsubscribe
  button for mailing lists, RFC 8058 POST where possible — note: may require CORS
  exemption; fallback: mailto/URL open).

### 4.4 FR-CMP — Composing

- **FR-CMP-01 (Must)** — Rich-text editor (bold/italic/underline, lists, links, quotes,
  inline images, basic font controls) producing clean, mail-compatible HTML with an
  auto-generated plain-text alternative; per-message toggle to plain-text-only mode.
- **FR-CMP-02 (Must)** — Reply/reply-all/forward with correctly quoted content
  (attribution line, `>` quoting in plain text, blockquote in HTML), signature placement
  above quote (configurable), subject prefixes localized-aware (`Re:`, `Fwd:` handling
  without stacking).
- **FR-CMP-03 (Must)** — Drafts autosave to the server (Drafts mailbox) with local
  offline fallback; crash-safe (a killed tab never loses more than a few seconds of
  typing).
- **FR-CMP-04 (Must)** — Attachments: file picker, drag & drop, paste (incl. screenshots
  as inline images), upload with progress via the session `uploadUrl`, size validation
  against `maxSizeUpload`/`maxSizeAttachmentsPerEmail` before sending.
- **FR-CMP-05 (Must)** — Recipient fields (To/Cc/Bcc) with autocomplete from Contacts
  (§5) and recent correspondents; pill UI with validation, drag between fields; warns on
  external-looking typos ("did you mean …@gmail.com") — heuristic, local only.
- **FR-CMP-06 (Must)** — **Identities** via `Identity/get`: selectable From (aliases),
  per-identity signature (HTML + text) and reply-to; default identity per folder
  inferable from the message being replied to. **Manageable via `Identity/set`**
  (M5.1, ADR-022): create, edit and delete identities in Settings — display name,
  reply-to, automatic Bcc and both signatures. `email` is immutable per RFC 8621 §6
  (create-only), delete is offered only where `mayDelete` allows it, and the whole
  section is hidden without the submission capability. Without this the user cannot
  change their own signature at all: a JMAP server's self-service console typically
  covers credentials, not identities.
- **FR-CMP-07 (Must)** — Sending via `EmailSubmission/set` with proper
  `onSuccessUpdateEmail` (move to Sent, set `$seen`), error surfacing (rejected
  recipients, quota, size).
- **FR-CMP-08 (Should)** — **Undo send:** client-side grace period before the submission
  call is fired; a snackbar offers "Undo". The delay is **user-configurable** in settings
  (off / 5 / 15 / 30 s; default 15 s); `config.json` only sets the hoster default
  (`undoSendSeconds`), never a lock.
- **FR-CMP-09 (Should)** — Compose windows: docked mini-composer that can expand to
  full-screen; multiple parallel drafts on desktop.
- **FR-CMP-10 (Should)** — Reply attachments handling: forward includes originals;
  "attachment mentioned but none attached" warning (localized keyword list).
- **FR-CMP-11 (Could)** — Scheduled send. Honest constraint: without a server extension
  the browser must be open at send time; implement client-side via outbox scheduling and
  document the limitation. Adopt a server-side mechanism when Stalwart exposes one
  (e.g. FUTURERELEASE semantics via JMAP).
- **FR-CMP-13 (Should — shipped M5.3)** — Register as the system's `mailto:` handler
  (`protocol_handlers` in the manifest) and open a seeded composer for a link clicked
  anywhere on the device. The URI is untrusted input from another origin: only the header
  fields RFC 6068 §5 calls safe are honoured (`to`, `cc`, `bcc`, `subject`, `body`), and
  the body is inserted as escaped text, never as markup.
- **FR-CMP-14 (Should — shipped M5.3)** — **Forward as attachment**: the original travels
  whole as a `message/rfc822` part rather than quoted into the body, so headers, signatures
  and MIME structure survive. Carried by blob reference (an Email's own `blobId` addresses
  the entire message, RFC 8621 §4.1.1) — no download and no re-upload.
- **FR-CMP-12 (Could)** — Templates / canned responses (stored as drafts in a dedicated
  folder or client-side).

### 4.5 FR-SRCH — Search

- **FR-SRCH-01 (Must)** — Global search box (server-side full-text via `Email/query`
  filters: text, from, to, subject, body, hasAttachment, before/after, mailbox, keywords)
  with instant results and highlighted snippets.
- **FR-SRCH-02 (Must)** — Structured filter chips + advanced search panel; free-text
  operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `in:folder`,
  `before:`/`after:`) mapping 1:1 to JMAP filter conditions.
- **FR-SRCH-03 (Should)** — Search scoping (current folder / everywhere), search history,
  saved searches as virtual folders in the sidebar.
- **FR-SRCH-04 (Could)** — Offline search over the locally cached subset, clearly labeled
  as partial.

### 4.6 FR-ORG — Organization & triage

- **FR-ORG-01 (Must)** — Standard flows: archive, delete (Trash, then purge), junk /
  not-junk (moving to/from the Junk folder lets server-side classifiers learn, where the
  server supports it), flag/star, mark read/unread.
- **FR-ORG-02 (Must)** — Custom **keywords/labels** (IMAP-interoperable JMAP keywords):
  create, color, assign, filter by label. Displayed alongside folders — JMAP keywords give
  us Gmail-style labels without proprietary APIs.
- **FR-ORG-03 (Should)** — **Snooze** implemented client-side (hide until X via local
  metadata + a dedicated keyword so other clients see nothing break); resurfaces via
  local notification. Documented limitation: fires only on devices with the app installed.
- **FR-ORG-04 (Should)** — Empty-trash / empty-junk with retention hint; per-folder
  "delete older than" bulk cleanup tool.

### 4.7 FR-NOTIF — Push, notifications & live updates

- **FR-NOTIF-01 (Must)** — Live UI updates via JMAP push: **WebSocket (RFC 8887)**
  preferred, **EventSource** fallback, polling as last resort — automatic selection by
  capability. Reconnect/backoff logic; `*changes` diffing keeps all open views current
  (new mail appears without refresh, counts update everywhere). Implementation note
  (SP.3/ADR-005): the SSE ("EventSource") fallback is realized as a **fetch-based reader**,
  because Stalwart authenticates the SSE endpoint only via the `Authorization` header, which
  the native `EventSource` API cannot send. Against Stalwart v0.16.11 the browser `WebSocket`
  is likewise unauthenticable (no header), and **decision D2 settled this at Gate G1
  (2026-07-10): SSE-first, WebSocket deferred** to a post-SSE enhancement. Since the B4 fix
  (2026-07-20, ADR-005 amendment) the browser therefore **never constructs a `WebSocket` at
  all**: the app hands `createPushChannel` the restrictive `transports` allowlist
  `BROWSER_PUSH_TRANSPORTS = ['sse','polling']` (`apps/web/src/sync/engine/engine.ts`), applied
  *before* the eligibility filter, so WS is absent from the failover chain rather than merely
  deprioritised — `prefer` would only reorder and would leave the un-authable WS one hop behind
  SSE. Runtime failover (SP.4) remains underneath as a safety net; it is no longer how the
  browser reaches SSE. The library default (WS → SSE → polling) is unchanged for server-side
  callers.
- **FR-NOTIF-02 (Must, _met against a server offering `urn:ietf:params:jmap:emailpush`; contentless
  otherwise — see ADR-017 and its amendment of 2026-08-21_)** — **System notifications**
  via Web Push: JMAP `PushSubscription` with RFC 8291 encryption, handled in the service
  worker. No relay server beyond the browser vendor's push service; payloads are end-to-end
  encrypted (the privacy aspect to document, NFR-PRIV-01).
  **Precondition (M3.6, verified live):** Chromium and Safari refuse a
  `PushManager.subscribe()` without an `applicationServerKey`, and the push service then
  rejects any POST not signed with the matching VAPID key (RFC 8292 §4.2). A JMAP server must
  therefore advertise **`urn:ietf:params:jmap:webpush-vapid`** (RFC 9749) and sign its pushes,
  and must send the `aes128gcm` payload in a form a browser can decrypt. No JMAP server met
  this when ADR-010 was written; **Stalwart v0.16.14 (2026-07-20) — the version the fixture
  pins — meets it**, verified at source and live: RFC 9749 is implemented and a virgin registry
  auto-generates the VAPID keypair, the ciphertext now goes out as **raw octets** instead of
  base64-wrapped, and unpadded base64url `p256dh`/`auth` keys are accepted. All three of
  Waxwing's upstream reports (`docs/upstream/`) are fixed there.
  **Decided at Gate G2 (2026-07-23, decision D6a, [ADR-017](adr/017-web-push-contentless.md)): the
  client half is built, and the closed-app banner is CONTENTLESS.** Work package M4.0; until it
  lands, nothing in the app claims background push works.
  **Which half of this requirement is delivered, stated so the prose above is not read as fully
  met.** The transport is: a JMAP `PushSubscription` with RFC 8291 encryption, handled in the
  service worker, no relay beyond the browser vendor's push service. The *content* is not: a JMAP
  push payload is a bare `StateChange` (RFC 8620 §7.1) carrying one state string per data type and
  no sender, subject or message id, so a banner naming the sender would require the worker to fetch
  the message itself — an authenticated JMAP call from a DOM-free worker, dragging the access token,
  the AES-GCM `SecretStore` (NFR-SEC-02) and the OAuth refresh path in with it. That is filed as
  **B28** with its own owner decision and security review, and is deliberately not folded in here.
  What makes the contentless banner meaningful rather than noise is measured, not assumed:
  `PushSubscription` carries a server-side **`types`** filter, Stalwart honours it, and
  **`EmailDelivery`** is a type distinct from `Email` — so the worker is woken on arrival only, not
  when another client merely reads a message, and it needs no token to know that. Three further
  limits belong to this requirement and are surfaced in the UI rather than papered over: **no
  per-folder filtering while closed** (`EmailDelivery` names no mailbox, so FR-NOTIF-03's
  per-folder preference applies to the live channel only), **no FR-NOTIF-05 actions** on the
  closed-app banner (archive and mark-read are JMAP writes), and a **7-day subscription expiry
  whose ceiling is the server's** — measured against v0.16.14, which grants 7 days whether 90 are
  requested or none — so background notifications stop for anyone who does not open Waxwing within
  a week. The `applicationServerKey` was already read and shipped before M4.0 for the capability
  probe that decides which settings sentence the user sees
  (`apps/web/src/notify/capability.ts` over `getWebPushVapidCapability`); M4.0 is what finally
  hands it to `PushManager.subscribe()`.
  What M3.6 ships instead, on every supported browser: the same notifications sourced from the
  **live push channel** (FR-NOTIF-01) whenever the app is running, a backgrounded or minimised
  tab included. The app probes for the capability and says plainly what it cannot do
  (NFR-PRIV-02).
  **Amended 2026-08-21 ([ADR-017 amendment](adr/017-web-push-contentless.md)): the content half is
  now delivered too, and B28 is closed.** Stalwart v0.16.16+ implements
  `draft-ietf-jmap-emailpush-03`: a `PushSubscription` gains an `emailPush` property and a matching
  delivery arrives as an `EmailPush` frame carrying `from`, `subject`, `preview` and `receivedAt`.
  The paragraph above — that a banner naming the sender would need an authenticated fetch from the
  worker — **no longer holds**: the browser has already decrypted the payload, so the worker reads
  it and shows it, with no token, no `SecretStore` and no JMAP call. The closed-app banner therefore
  names the sender and the subject **when the server advertises the capability AND FR-NOTIF-03's
  preview toggle is on**; against every other server it is contentless exactly as before, and the
  URN is never sent to one that has not advertised it (RFC 8620 §3.3 would fail the whole request).
  Two limits above are unchanged and remain surfaced in the UI: no per-folder filtering while closed
  (the draft's server-side `filter` was deliberately not taken — it suppresses the push entirely, so
  the channel would go blind for unselected folders) and no FR-NOTIF-05 actions.
- **FR-NOTIF-03 (Must)** — Notification preferences: per-folder on/off, quiet hours,
  preview content on/off (privacy), sound on/off.
  **Scope split by transport (D6a, ADR-017).** On the live channel (FR-NOTIF-01) all four apply.
  On the closed-app banner (FR-NOTIF-02) the master switch, quiet hours and sound apply — the
  worker reads them from `localPrefs`, which is unencrypted IndexedDB — while **per-folder does
  not and cannot**, because the push names no mailbox. That gap is stated in the settings UI;
  a preference that cannot take effect must not be left looking effective.
  **Amended 2026-08-21:** the preview toggle is no longer met "by construction". Against a server
  offering `urn:ietf:params:jmap:emailpush` there IS content to withhold, and the toggle governs the
  **wire**: with it off, Waxwing sends no `emailPush` configuration, so the server never puts a
  subject in a push at all — it is not hidden at the last moment, it is never requested. It is also
  honoured in the worker, because the server-side configuration is only rewritten on the app's next
  start and a content-carrying push can be in flight when the switch flips.
- **FR-NOTIF-04 (Should)** — Unread badge on the installed PWA icon (Badging API where
  supported).
- **FR-NOTIF-05 (Should)** — Notification actions: archive / mark read / reply (opens
  composer) directly from the notification where the platform allows.
  **Live channel only (D6a, ADR-017).** Archive and mark-read are JMAP writes, and the
  closed-app banner is deliberately built without the token that would make them possible;
  its click opens Waxwing. Revisit only alongside B28, which is where that trade-off is decided.

### 4.8 FR-OFF — Offline

- **FR-OFF-01 (Must)** — The app shell loads offline (service worker precache); opening
  the installed app without network shows cached mail, clearly marked "offline".
- **FR-OFF-02 (Must)** — Local cache (IndexedDB): mailbox tree, message index of recent N
  days/messages per folder (configurable), full bodies of everything the user has opened
  plus a configurable recent window; attachments on demand.
- **FR-OFF-03 (Must)** — **Offline outbox:** actions performed offline (send, move, flag,
  delete, drafts) queue locally and replay on reconnect using JMAP state strings for
  conflict detection; conflicts surface as gentle, actionable notices — never silent data
  loss.
- **FR-OFF-04 (Should)** — Storage budget management: show usage, LRU eviction of bodies/
  attachments, "keep offline" pin per folder.

### 4.9 FR-QTA — Quota

- **FR-QTA-01 (Should)** — When the server exposes RFC 9425 Quota: usage indicator in the
  sidebar/settings, proactive warning at ≥ 90 %, clear error UX when sending/saving fails
  due to quota.

---

## 5. Contacts (V1)

Backed by **JMAP for Contacts (RFC 9610 / JSContact RFC 9553)** — supported natively by
Stalwart. Contacts are a first-class area of the app (own section in navigation), and
deeply integrated into mail flows.

- **FR-CON-01 (Must)** — Address book list (multiple `AddressBook`s incl. shared ones,
  rights-aware), contact list with search-as-you-type, detail view.
- **FR-CON-02 (Must)** — Create/edit/delete contacts with the common JSContact fields:
  name components, emails, phones, addresses, organization/title, birthday, notes, photo.
  Sensible progressive form (rarely used fields behind "add field").
- **FR-CON-03 (Must)** — **Composer autocomplete** across all address books + recent
  correspondents, ranked by usage; avatars from contact photos.
- **FR-CON-04 (Must)** — Contact groups (JSContact groups): create, manage, and use as
  recipient expansion in the composer.
- **FR-CON-05 (Should)** — From a message: "add sender to contacts" / "edit contact",
  hover-card with contact info and recent-conversation link.
- **FR-CON-06 (Should)** — Import/export **vCard 4.0** (client-side conversion
  JSContact ↔ vCard) and JSContact JSON; CSV import (Could).
- **FR-CON-07 (Could)** — Auto-collect recipients into a designated "Collected" address
  book (off by default).

---

## 6. Self-service Server Features (via JMAP)

Settings that traditionally require webmail-server plugins come free with Stalwart's JMAP:

- **FR-VAC-01 (Must)** — **Vacation responder** UI (`VacationResponse/set`): on/off,
  date range, subject, rich body, preview.

- **FR-CAL-01 (V2 — partially shipped M5.6)** — **Calendar** over JMAP for Calendars
  (`draft-ietf-jmap-calendars`, JSCalendar/RFC 8984).

  **Shipped:** a month grid and an agenda list, read-only, with recurrence expansion done
  by the server (`expandRecurrences`) and correct local-time handling — a JSCalendar
  `start` is a local date-time with its zone beside it, and the agenda shows that zone
  whenever it is not the reader's.

  **Not shipped, deliberately:** week and day grids (they need a time axis with overlap
  resolution) and any form of editing (a recurrence editor plus an RSVP flow). A calendar
  that lets someone half-edit a recurring meeting loses other people's time.

  **Caveat to record:** the calendars draft has no RFC number yet. Every wire shape the
  client relies on was measured against Stalwart 0.16 rather than taken from the draft.
- **FR-SIEVE-01 (V1.x — shipped M5.2)** — **Filter rules** editor on top of JMAP for Sieve
  (RFC 9661): a visual rule builder (conditions → actions: move, flag, forward, discard,
  stop) generating a managed Sieve script; round-trip-safe (foreign scripts are shown
  read-only in a code view rather than destroyed).

  Round-trip safety is met by **not parsing Sieve at all** (ADR-023): the rule set is
  carried as JSON in a marker comment and read back from there, and anything outside the
  markers is preserved verbatim and in its original position. A foreign script is therefore
  displayed but never edited in place — the offer is to manage rules *alongside* it.
- **FR-SIEVE-02 (V1.x, Could — partially shipped M5.2)** — Raw Sieve editor with syntax
  highlighting and server-side validation feedback for power users.

  **Shipped read-only:** the generated script is viewable, and `SieveScript/validate` is
  bound and used before a save, but the source cannot be edited by hand. An editable raw
  view would have to re-parse the result to keep the rule list in sync, which is exactly the
  round trip ADR-023 refuses. Syntax highlighting is not implemented.

---

## 7. Look & Feel, Theming, Accessibility, i18n

### 7.1 FR-UI — Design language

- **FR-UI-01 (Must)** — Minimalist, Apple-HIG-inspired design: neutral surfaces, one
  accent color, SF-adjacent open-source type (system font stack first), 8-pt spacing
  grid, subtle depth, reduced-motion-aware transitions. Details in the design system
  (separate document).
- **FR-UI-02 (Must)** — Light and dark theme, following the OS by default, manual
  override; both themes are first-class (every screen designed for both).
- **FR-UI-03 (Must)** — Fully responsive: three-pane desktop, two-pane tablet,
  single-pane phone with native-feeling navigation (back gestures, bottom-reachable
  actions). One codebase, no separate mobile app.
- **FR-UI-04 (Must)** — Complete keyboard support incl. Gmail/Fastmail-style shortcuts
  (`j/k`, `e`, `r`, `c`, `/`, `?` for the cheat-sheet) and a **command palette (⌘K)** for
  every action and folder jump. A shortcut that is inert because of the **account's shape**
  (e.g. `e` on an account with no Archive role — JMAP does not mandate one) must **say so** and
  name a way forward, and the cheat-sheet must show it as unavailable with the reason rather
  than as available. Silence stays correct for the ordinary inert cases — nothing selected,
  empty folder — where the user can see why for themselves (G2/B3).

### 7.2 FR-THEME — Theming & white-labeling

- **FR-THEME-01 (Must)** — All colors, radii, spacing, and typography exposed as **CSS
  custom properties** (design tokens). A hoster can restyle Waxwing by shipping a single
  `theme.css` override next to `config.json` — no build step.
- **FR-THEME-02 (Must)** — `config.json` branding: product name, logo (SVG/PNG paths),
  favicon, accent color, default theme, imprint/support links. The UI must not hardcode
  the name "Waxwing" anywhere user-visible.
- **FR-THEME-03 (Should)** — Selectable built-in accent palettes for end users; hoster
  can pin or extend them.
- **FR-THEME-04 (Could)** — Community theme gallery format (a theme = `theme.css` +
  metadata JSON).

### 7.3 FR-A11Y — Accessibility

- **FR-A11Y-01 (Must)** — WCAG 2.2 AA: full keyboard operability, visible focus,
  screen-reader-tested flows (list triage, reading, composing), contrast-checked tokens
  in both themes, `prefers-reduced-motion` respected, min 44-px touch targets.

### 7.4 FR-I18N — Internationalization

- **FR-I18N-01 (Must)** — Full i18n from day one; V1 ships **English + German**.
  Localized dates/numbers via `Intl`; translation files community-editable (standard
  format, e.g. via Weblate later).
- **FR-I18N-02 (Should)** — RTL-ready layout (logical CSS properties throughout).

---

## 8. Non-functional Requirements

### 8.1 NFR-PERF — Performance budgets

- **NFR-PERF-01 (Must)** — Initial load (cold, no SW cache): ≤ 300 KB gzipped JS on the
  critical path; interactive < 2 s on a mid-range 2023 laptop / < 4 s on a mid-range
  phone over 4G. Subsequent loads (SW cache): interactive < 1 s.
- **NFR-PERF-02 (Must)** — 60 fps scrolling in lists of 100 k messages; opening a cached
  message < 100 ms; folder switch < 200 ms perceived.
- **NFR-PERF-03 (Should)** — Route-level code splitting (contacts, settings, sieve editor
  load on demand); performance budgets enforced in CI.

### 8.2 NFR-SEC — Security

- **NFR-SEC-01 (Must)** — Strict CSP (no inline script, no eval); HTML mail rendered
  exclusively inside a sandboxed iframe with its own CSP after DOMPurify-class
  sanitization; `target=_blank noopener` link policy with visible target host.
- **NFR-SEC-02 (Must)** — Tokens never in `localStorage`; XSS-hardened storage strategy
  (see tech-stack doc). Logout wipes everything.
- **NFR-SEC-03 (Must)** — No mixed content, HTTPS-only, subresource integrity for any
  deployment where files and config could diverge.
- **NFR-SEC-04 (Should)** — Documented threat model (malicious mail content, malicious
  network, shared device, hostile CDN) and a `SECURITY.md` process.
- **NFR-SEC-05 (Could)** — OpenPGP (read/verify first, then sign/encrypt) as an optional,
  lazily-loaded module — V2+, see §10.

### 8.3 NFR-PRIV — Privacy

- **NFR-PRIV-01 (Must)** — Zero telemetry, zero third-party requests. Remote mail content
  blocked by default (FR-RD-02). Web-push payloads end-to-end encrypted (RFC 8291).
- **NFR-PRIV-02 (Must)** — Honest documentation of what a static client *cannot* do:
  e.g. no tracking-pixel-stripping proxy (loading remote images reveals the user's IP to
  the sender). Optional: hosters may configure an image-proxy URL in `config.json`
  (explicitly an *external integration*, not part of Waxwing).

### 8.4 NFR-COMPAT — Browser support

- **NFR-COMPAT-01 (Must)** — Evergreen: last 2 major versions of Chrome/Edge/Firefox,
  Safari ≥ 17 (macOS/iOS). PWA install paths documented per platform (iOS quirks
  included: Web Push requires the app to be added to the home screen).
- **NFR-COMPAT-02 (Must)** — **Server baseline: Stalwart v0.16.x** (current stable at
  spec time) — development and CI test against it. If the upcoming Stalwart v1.0 ships
  changes Waxwing needs, the baseline is raised to v1.0; otherwise v0.16 remains the
  supported minimum. Other JMAP servers per FR-SRV-01/02 (best effort).

### 8.5 NFR-QUAL — Quality

- **NFR-QUAL-01 (Must)** — Automated tests: unit (data layer, JMAP client, reducers),
  component, and E2E against a real Stalwart instance in CI (Docker).
- **NFR-QUAL-02 (Should)** — JMAP compatibility test matrix (Stalwart primary; Cyrus /
  Fastmail-API as smoke tests) to keep the "any JMAP server" promise honest.

---

## 9. Configuration Reference (deployment-time)

`config.json` (all optional, sane defaults):

```jsonc
{
  "server": {
    "sessionUrl": null,          // null = same-origin /.well-known/jmap
    "allowCustomServer": true,   // show server field on login
    "auth": ["oauth", "basic"]   // enabled methods, in order of preference
  },
  "branding": {
    "productName": "Waxwing",
    "logo": "branding/logo-icon.svg",
    "accentColor": "#E8770E",
    "defaultTheme": "auto",      // auto | light | dark
    "links": { "imprint": null, "support": null, "privacy": null }
  },
  "features": {                  // hoster-level feature flags
    "sieveEditor": true,
    "remoteContentDefault": "block",   // block | allow (org policy)
    "imageProxyUrl": null,             // optional external privacy proxy
    "undoSendSeconds": 15
  },
  "offline": { "cacheDays": 30, "maxStorageMB": 512 }
}
```

Plus optional `theme.css` (token overrides) and replaceable `branding/` assets.

---

## 10. Roadmap Beyond V1

| Phase | Contents |
|---|---|
| **V1.x** | **Sieve filter rules UI (FR-SIEVE-01/02)**, saved searches, snooze, scheduled send (client-side), templates, offline search, Badging, notification actions |
| **V2** | **Calendar** (JMAP for Calendars — Stalwart ships it; the draft's stabilization is the gate), invitations (iTIP) in mail, availability; **multi-account**; PGP (verify → full) |
| **V2+** | Files (JMAP filenode) as attachment source, Tasks (when spec'd server-side), mailto:/share-target deep integration, theme gallery |

---

## 11. Decision Log

Resolved 2026-07-05 (project owner):

1. **Name: "Waxwing" is final** (2026-07-05, third naming round). History: "Wren" was
   dropped after discovering usewren.app (an email product); a coined-name round
   (Skrivo, Plico, …) produced no candidate cleaner than Waxwing. Waxwing has no
   collision in the email/messaging space; `waxwingmail.app`, `waxwing.email`,
   `usewaxwing.app`, `waxwingmail.com`, npm and the GitHub org were registry-checked
   free at decision time. Brand story: the bird is named for the sealing-wax-red tips
   of its wing feathers — a wax-sealed letter. Hosting/namespaces: **no paid domains** —
   the project is non-commercial; project site and demo live on GitHub Pages. Securing
   the free namespaces (GitHub org, npm names) early is still recommended. A formal
   trademark search only becomes relevant if the project is ever distributed
   commercially.
2. **Undo send: user-configurable delay** (off / 5 / 15 / 30 s), default 15 s; hoster
   sets only the default via `config.json` → FR-CMP-08.
3. **Sieve editor moved to V1.x** (visual builder and raw editor) → FR-SIEVE-01/02, §10.
4. **Server baseline: Stalwart v0.16** — the current stable line is what we can test
   against today. If the v1.0 jump (expected ~Oct 2026) brings changes we need, the
   baseline is raised to v1.0 → NFR-COMPAT-02.

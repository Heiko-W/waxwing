# Waxwing — Implementation Plan

| | |
|---|---|
| **Project** | Waxwing — a serverless webmail client for JMAP |
| **Version** | 0.1 |
| **Date** | 2026-07-05 |
| **Companions** | [functional-specification.md](./functional-specification.md) (WHAT) · [tech-stack.md](./tech-stack.md) (HOW) |
| **Status** | Living document — the authoritative roadmap; updated at the end of every work session |

---

## 1. Purpose

This document turns the milestone sketch in [tech-stack.md §9](./tech-stack.md) into an
executable roadmap: phases → work packages (WPs) with scope, dependencies, spec references,
task lists and exit criteria. It is written for AI agents (and humans) picking up the
project in future sessions: any session should be able to start from the
[status board (§3)](#3-status-board) alone and know what to do next.

Precedence on conflict: **functional-specification.md and tech-stack.md win over this
plan.** This plan describes sequencing and packaging, not requirements. If implementation
reveals that a spec or stack decision doesn't hold, record an ADR (§2.3) and update all
affected documents — never silently diverge.

## 2. How to Use This Plan (session protocol)

### 2.1 Session start

1. Read (or re-read) `docs/functional-specification.md`, `docs/tech-stack.md`, and this
   plan's status board (§3). Skim existing ADRs in `docs/adr/` once that directory exists.
2. Pick the next WP that is `todo` and whose dependencies are all `done` — unless the user
   directs otherwise. Prefer finishing an `in-progress` WP over starting a new one.
3. Set the WP's status to `in-progress` in the board before writing code.
4. Work on **one WP at a time**. If a WP turns out too large for the session, complete a
   coherent subset, check off the finished tasks, and leave the repo green (build, lint,
   tests all passing) at session end.

### 2.2 Session end

1. Update the status board (§3) and the WP's task checkboxes to match reality.
2. Add discovered follow-up work as new checkbox items in the relevant WP (or a new WP if
   it doesn't fit anywhere) — never keep TODOs only in your head or in code comments.
3. If anything deviated from spec/stack/plan: write an ADR (§2.3) and adjust the docs.
4. Append a one-line entry to the changelog (§15): date, WP(s) touched, outcome.

### 2.3 Change management (ADRs)

Architecture/scope decisions made during implementation go to `docs/adr/NNN-title.md`
(lightweight [MADR](https://adr.github.io/madr/) style: Context → Decision → Consequences,
one page max). Number sequentially from `001`. Typical triggers: a spike finding
invalidates an assumption, a library must be replaced, a requirement needs
re-interpretation, a WP is split or re-scoped.

### 2.4 Global Definition of Done

Applies to **every** WP in addition to its own "Done when" list:

- `pnpm typecheck`, `pnpm lint` (Biome) and all tests pass; CI is green.
- New logic has unit/component tests; user-visible flows touched get/keep E2E coverage.
- No hardcoded user-visible strings — everything through i18next with `en` **and** `de`
  entries (FR-I18N-01 demands i18n *from day one*).
- Interactive UI is keyboard-operable with visible focus; images/icons have accessible
  names (FR-A11Y-01 is continuous, not an M4 afterthought).
- Bundle-size budget respected (`size-limit` gate, NFR-PERF-01); new dependencies justified
  against §2 of tech-stack.md and license-checked (AGPL-compatible; packages/* stay MIT-clean).
- All new code account-scoped where it touches persisted data (FR-AUTH-07 readiness).
- Docs updated where behavior/config changed (`config.json` reference, deployment notes).

### 2.5 Conventions

- **Commits:** Conventional Commits (`feat(scope): …`, `fix: …`, `chore: …`); scopes:
  `web`, `jmap`, `mail-html`, `jscontact`, `sync`, `e2e`, `docs`, `ci`.
- **Package naming:** `@waxwing/jmap`, `@waxwing/jscontact`, `@waxwing/mail-html`.
- **Licenses:** repo root AGPL-3.0; `packages/jmap` and `packages/jscontact` MIT (pending
  decision D1, §13); `packages/mail-html` AGPL-3.0.
- **Estimates legend:** S ≈ ½–1 focused session · M ≈ 1–3 sessions · L ≈ 3+ sessions
  (consider splitting when an L drags). Calendar figures in §4 are orientation only.

## 3. Status Board

Single source of truth for progress. Statuses: `todo` · `in-progress` · `blocked` ·
`done` · `dropped`. Keep the table sorted as-is; only edit Status and Notes.

### Phase 0 — Foundation

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P0.1 | Repo bootstrap (git, workspaces, tooling) | S | — | done | git, pnpm workspace, TS 6 strict base, Biome 2.5, licenses, skeleton |
| P0.2 | App scaffold (Vite/React, tokens, i18n, config boot) | M | P0.1 | done | Vite 8 + React 19; tokens (WCAG-AA, light/dark); runtime config.json+theme.css; i18n en/de lazy; strict CSP; 80.95 KB gz initial |
| P0.3 | Test infrastructure (Vitest, RTL, Playwright) | S | P0.1 | done | Vitest 4 projects (jsdom+node), RTL, fake-indexeddb, axe helper, Playwright skeleton; `test`+`e2e` green |
| P0.4 | Stalwart dev/E2E fixture (Docker) | M | P0.1 | done | ADR-002; unauth session = 200 anon, not 401 |
| P0.5 | Local verify scripts + size budgets | S | P0.2–P0.4 | done | ADR-003: re-scoped to local `pnpm verify` (typecheck+lint+test+size) / `verify:e2e` (Docker+Playwright, try/finally teardown); 300 KB gz gate enforced; GitHub Actions CI deferred |

### Phase 1 — Spike (validate risky assumptions)

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| SP.1 | `@waxwing/jmap` core (session, calls, chunking) | L | P0.1, P0.4 | done | zero-dep MIT client; session/back-refs/auto-chunk/blob/auth; 64 unit + 4 live-fixture tests; 9.32 KB gz |
| SP.2 | Auth: OAuth PKCE + token storage + Basic scheme | M | SP.1, P0.4 | done | Auth module + 31 hermetic tests (green); `apps/web/src/auth/`; oauth4webapi 3.8.6. Done-when verified LIVE against Stalwart v0.16.11 (OAuth PKCE dance via real login page + Basic): login → Mailbox/get → forced refresh → logout. Review fixes applied (single-flight refresh, callback-param scrub on all paths, terminal-refresh purge, account-scoped store per ADR-004, dev-CSP Stalwart origin). Live-only interop fix: strip Stalwart's unsolicited ES256 id_token. No client registration / no revocation endpoint (SP.5 findings) |
| SP.3 | Push transports: EventSource + WebSocket (RFC 8887) | M | SP.1 | done | Fetch-based SSE reader (native `EventSource` can't send the `Authorization` header Stalwart requires) + RFC 8887 WebSocket; shared full-jitter reconnect + WS→SSE→polling-stub auto-select. Both deliver `StateChange` (2–5 ms) and survive `docker restart`. **ADR-005**. WS works server-side only against Stalwart (browsers can't set the WS auth header) → D2 evidence in SP.5. 72+4 hermetic + 3 live tests; push tree-shaken (budget untouched, +5.59 KB gz in the `@waxwing/jmap` barrel) |
| SP.4 | Raw end-to-end demo (login → list → message) | M | SP.1, SP.2, P0.2 | done | Dev-only `apps/web/src/demo/`, gated on `import.meta.env.DEV && VITE_WAXWING_DEMO==='1'` → Rollup DCEs it (grep-proven absent from `dist/`, budget unchanged at 80.55 KB gz). One-command harness `pnpm demo [--lan]` (fixture + seeded mail + same-origin Vite proxy, guaranteed teardown). Live: Basic login → mailbox counts → paged `Email/query`+`Email/get` (`#ids` back-ref) → text/HTML body in a `sandbox=""` iframe → `Email/parse` of a `message/rfc822` attachment → blob download. 30 hermetic + axe tests (214 total green) + 2 live Playwright specs (Basic + OAuth). **`Email/parse` answered** (SP.5). LAN caveat: plain-http origin = insecure context, so OAuth/persistence are unavailable there by design |
| SP.5 | Spike report, ADRs, validation checklist | S | SP.1–SP.4 | done | All five open items answered LIVE against v0.16.11 + **ADR-006** (OAuth token posture). **(a)** no client registration needed, opaque tokens, refresh not-rotated/not-`client_id`-bound/**not revocable** (no revocation or end_session endpoint). **(b)** core limits all positive (get/set 500, calls 16, req 10 MB, upload 50 MB) → fallbacks never engage; mail limits + 9 sort options in `accountCapabilities`. **(c)** Content-Type echoed not sniffed; oversize → **400** `error:limit` (not RFC 413) + hidden **429** per-user quota (1000 files/50 MB, unadvertised); download header-auth only. **(d)** FR-DEP-02 mount mechanism live-verified via Stalwart's own `/admin/` app (`<base href>` rewrite + relative assets + SPA fallback) — build gap: `dist/index.html` emits no `<base href="/">` (→ M4.9). **(e)** `principals` + `mail:share` advertised, `myRights.mayShare` present, but **no delegation seeded** (M4.4 fixture task); `principals:owner` absent. D2 (browser WS) left open for G1 |
| **G1** | **Gate: owner reviews spike findings, plan adjusted** | — | SP.5 | done | **Passed 2026-07-10.** Owner reviewed the SP.5 report; **D2 decided: SSE-first, WebSocket deferred** (ADR-005 ratified). ADR-006 (token posture) noted. Phase 1 complete → **M1 unblocked**; next `todo` is M1.1 |

### Phase 2 — M1 "Read"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M1.1 | Design system foundation (doc, tokens, base components) | L | P0.2 | done | **2026-07-10.** `docs/design-system.md` written; tokens finalized with **machine-verified WCAG AA contrast** (`tokens.contrast.test.ts`, 42 assertions) — added `border-strong`, `danger/success/warning-contrast`, elevation tokens. 14 base components + shared primitives in `src/ui/` (barrel `index.ts`), each with keyboard/APG-ARIA/both-themes/44px and a co-located axe test (96 tests). Dev-only gallery (`VITE_WAXWING_GALLERY=1`, DCE'd from prod); **browser axe scan zero violations incl. color-contrast in light+dark**. Bundle 80.69 KB gz. **D5 signed off 2026-07-10** (after accent→blue + responsive-compact revisions). |
| M1.2 | Local replica schema (Dexie, account-scoped) | M | SP.1, P0.3 | done | **2026-07-10.** Dexie 4 shared `waxwing-replica` DB, 10 tables keyed `[accountId+id]` (**ADR-008**); account-scoped `amb`/`akw` membership indexes; canonical query-key; migration policy; `ReplicaProvider` + liveQuery hooks. 29 tests; 105.5 KB gz (Dexie tree-shaken until M1.5/M1.6, projected +31 KB gz). Follow-up: wire `wipeReplica` into sign-out → M1.3. |
| M1.3 | Sync engine core + action queue skeleton | L | M1.2, SP.3, G1 | done | **2026-07-10.** `sync/engine/`: leader election (Web Locks) + `EngineBus`; push-driven delta sync (`*/changes`, `queryChanges` reconcile w/ `upToId` window bound, `cannotCalculateChanges`→full-requery, SP.4 forceFull re-probe); windowed backfill (day-stable key); outbox (optimistic apply/rollback, FIFO replay, method-vs-transport errors, inflight recovery, create-id reconcile); real polling transport in `@waxwing/jmap`. Wired into the shell (`SyncEngineHost` + `StatusRegion` + sign-out `wipeReplica`). 69 engine/replica tests; adversarial review fixed 8 defects (2 high). 147 KB gz. Live two-tab/offline E2E → **M1.9**. |
| M1.4 | App shell: routing, layout, config/theme boot, auth UX | L | M1.1, SP.2 | done | **2026-07-10.** Own base-path-safe router (**ADR-007**), responsive 3/2/1-pane shell + reading-pane modes, onboarding FSM (autoconnect/manual/OAuth/Basic), `SessionProvider` (holds the `JmapClient` for M1.5/M1.6) with FR-AUTH-06 re-auth overlay + FR-AUTH-05 sign-out, branding + `BrandLinks` from config. 401 tests; browser axe clean light+dark; 105.5 KB gz. Adversarial review fixed 6 defects. Follow-ups: engine status → M1.3, live shell E2E → M1.9. |
| M1.5 | Folder tree (roles, counts, manage) | M | M1.3, M1.4 | done | **2026-07-10.** `mail/`: pure `buildFolderTree` (roles pinned, orphan/cycle-safe, aria pos/setsize) + `FolderTreeView` (APG `role="tree"`, roving focus, gated per-folder `Menu`) + `FolderTree` container (liveQuery, router selection, collapse pref, create/rename/delete `Dialog`s via `useFolderActions`→engine). Wired into `MailScreen`. 22 mail tests + axe; adversarial review fixed a keyboard-tab-stop `high` + 5 more. 151 KB gz. Live CRUD-round-trip/2nd-client E2E → M1.9; temp→server re-nav after create → M1.6. |
| M1.6 | Message list: virtualization, threading, selection | L | M1.3, M1.4 | done | **2026-07-11.** TanStack-Virtual list over the `queryCache` window (visible-slice hydration), APG grid via **aria-activedescendant**, initials avatar + indicators + relative time, pure selection reducer (click/shift/ctrl/select-all) + bulk bar (read/flag/archive/junk/trash/delete → outbox), sort/density/flat toggles (persisted), infinite scroll. New engine seam `watchWindow` + observable `useActiveEngine`. `mail/` + `MailScreen` wiring; `e2e/stalwart/seed-large.mjs` (`pnpm seed:large`). 46 mail tests; adversarial review fixed **16 defects (4 high** — broken roving focus, move-without-clear dual-membership, watchWindow/engine race). 163 KB gz. Live 100k-perf/500-bulk E2E → M1.9/M4.8. |
| M1.7 | `@waxwing/mail-html`: sanitizer + iframe renderer | L | P0.1, SP.1 | done | **2026-07-10.** AGPL package: hardened DOMPurify sanitizer (`{html, blockedRemote, hasRemoteContent}`) + remote-content firewall (cid via caller `resolveCid`), script-free sandboxed-iframe renderer (`sandbox="allow-same-origin"`, inner CSP, outer-page height + link interception), plain-text renderer (folding). dist **18.5 KB gz** (DOMPurify bundled). 38 tests incl. a 12-case XSS corpus. **Security review** confirmed 8 bypasses (1 high ReDoS + CSS-escape/image-set/malformed-url/`<area>`-link/height-loop/text-recursion/cid-revalidation) — all fixed **fail-closed** + regression-tested (CSS logic tested directly to dodge jsdom masking). Wiring into the reading view → M1.8. |
| M1.8 | Reading experience (conversation view, actions, attachments) | L | M1.6, M1.7 | done | **2026-07-11.** `mail/`: `MessageView` (header/details, action bar → outbox, `mail-html` body in the sandboxed frame) + `Conversation` (thread in stored order, older collapsed, reversible expand, focus-managed) + `AttachmentList` (per-blob object-URL cache, image/PDF preview in a separate sandboxed surface, save-all) + `RemoteContentBanner` (load-once / per-sender allowlist) + `MoveDialog`. Data seams: `port.getEmailBodies`, `SyncEngine.fetchBody`/`fetchEnvelopes`, `useEmailBody`/`useThread`, async-cid→sync-`resolveCid` bridge. Wired into `MailScreen`. Auto-mark-read gated to the opened message; permanent delete confirmed; print strips app chrome. 40 mail tests; adversarial review fixed **13 defects (1 high** — unsynced thread-member envelopes rendered a permanent skeleton; auto-expanded-newest silently marked read; delete-without-confirm; expand focus-loss; print chrome). 180.6 KB gz. `role="toolbar"` roving-tabindex consciously deferred (axe-clean; `role="group"` collides with Biome `useSemanticElements`). Live newsletter/threaded/offline-reopen E2E → M1.9. |
| M1.9 | Live updates end-to-end + E2E read suite | M | M1.5, M1.6, M1.8 | done | **2026-07-11.** Playwright "read" suite (`e2e/tests/read.spec.ts`, 10 tests) drives the REAL production bundle against the live Stalwart fixture: a `vite preview` webServer + same-origin Stalwart proxy (`WAXWING_E2E=1` → `vite.config` `preview.proxy`; fixture advertises the app origin via `STALWART_PUBLIC_URL`, so no CORS/cross-origin loopback), a `read.setup`/`teardown` that brings the fixture up + seeds (`seed-read.mjs`: HTML newsletter w/ remote image, plain-text, 3-message thread). Covers Basic **and** OAuth login, folder nav, plain/HTML/threaded reading in the sandboxed frame, remote-content block+load, flag/archive/trash round-trips, live delivery auto-refresh, cross-tab consistency, and a perf smoke (**cached open ≈75 ms <100 ms, folder switch ≈100 ms <200 ms**, NFR-PERF-02 met). Wired into `pnpm verify:e2e`. **Two real bugs the unit tests missed** — the app shell mounted no `ToastProvider`, so opening any message crashed (`useToast` throws) → provider added in `App.tsx`; and two jsdom flakes fixed (axe descending into the sandboxed body iframe → `iframes:false`; a disabled-until-synced Archive button race). Findings: browser push can't auth with Basic (WS/SSE handshake carries no `Authorization`) → live updates ride the 60 s safety-sweep, instant-push (OAuth Bearer + SSE) a follow-up; the fixture exposes no SMTP port → live delivery uses JMAP `Email/set`. 181 KB gz. |

### Phase 3 — M2 "Write"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M2.1 | Squire editor wrapper component | M | M1.1 | done | **2026-07-11.** `apps/web/src/compose/`: `RichTextEditor` (thin React wrapper over an `EditorEngine` seam — controlled-ish, async engine lifecycle w/ teardown, debounced `onChange`, `pathChange`→toolbar state, plain-text-only mode, ⌘B/I/U/K + link dialog) + `EditorToolbar` (`role="toolbar"` roving-tabindex, `aria-pressed`) + pure `htmlToPlainText`/`cleanOutgoingHtml` + `squire-adapter` (the ONLY squire-rte/dompurify importer, behind a dynamic `import()` → lazy chunk). New direct dep **dompurify ^3.4.11** (squire-rte's default `sanitizeToDOMFragment` references a bare global `DOMPurify` that a bundle lacks → we pass our own **permissive** compose sanitizer: keep tags/inline-styles/images, drop script/`on*`/`javascript:` — distinct from `@waxwing/mail-html`'s reading-side lockdown; tech-stack §2 note). +33 tests (609 total, 76 files); **entry chunk unchanged at 181.14 KB gz** (squire-rte 0 refs in entry — verified). **Font size/family controls DEFERRED to M2.2** (a11y: native select vs roving toolbar) — the only FR-CMP-01 gap, engine seam already has `setFontSize`. Real-Squire path (contenteditable) is fake-injected in jsdom → live coverage lands with M2.9 E2E. Implemented via a context-inheriting fork + adversarial-correction (the DOMPurify seam bug). |
| M2.2 | Composer container (docked/fullscreen, parallel drafts) | M | M2.1, M1.4 | done | **2026-07-11.** `apps/web/src/compose/`: module-scoped **Zustand** `composer-store` (parallel drafts, `MAX_OPEN`=3 → oldest collapses to a minimized chip, none dropped, `openDraft`/`closeDraft`/`setMode`/`updateBody`/`updateSubject`/`focusDraft`) + `ComposerHost` (lazy, portals a fixed layer to `<body>` in the persistent AppShell → drafts survive route changes; desktop row / phone single full-screen; focus-return on last close) + `ComposerWindow` (docked non-modal `role=dialog`, full-screen modal w/ focus-trap+scroll-lock; subject field + RichTextEditor; discard-confirm stub) + `NewMessageButton` (Header trigger + best-effort ⌘/Ctrl+N). New dep **zustand ^5.0.14** (tech-stack §-sanctioned UI-state). +15 tests (624 total, 79 files); **entry chunk flat at 180.8 KB gz** — ComposerHost + squire-adapter (86 KB) are separate lazy chunks (0 heavy code in `index-*.js`, verified). **Owner-decided UX** (AskUserQuestion): docked parallel model, full-screen modal, Header trigger, Esc-harmless (Apple-Mail-aligned); persistence deferred to M2.6 (in-memory now → a reload loses drafts, acceptable pre-M2.6). Font size/family control still deferred (M2.1 note). |
| M2.3 | Reply / reply-all / forward (quoting, subjects, headers) | M | M2.1, M1.8 | done | **2026-07-11.** `apps/web/src/compose/reply.ts` — pure `deriveRecipients` (reply Reply-To>From; reply-all dedup + self-drop; forward empty), `stripSubjectPrefix`/`replySubject` (AW:/WG:/Re[2]:→single Re:/Fwd:, no stacking), `threadingHeaders` (In-Reply-To/References), `quoteBody` (`<blockquote>`+attribution), `forwardBody`, `inferFromIdentity`, `ownAddresses` (session personal accounts — M2.5 seam), `forwardAttachments` (blob refs), and the `buildReplyDraft` aggregator. Composer store extended (to/cc/bcc/inReplyTo/references/fromIdentityHint/attachments); `ComposerWindow` shows a read-only recipients summary (pill fields = M2.4). `MessageView` reply/reply-all/forward stubs → real `onCompose(kind)` wiring (disabled while the body loads). Envelope fetch gained messageId/inReplyTo/references/replyTo (`db.ts`+`engine/types.ts`; rebuildable cache). +34 tests (659 total, 80 files, 30 pure-logic cases); 181.9 KB gz. Decisions Apple-Mail-aligned per owner ("Apple standard"): Re:/Fwd: normalization, localized attribution. Quote-folding deferred. Implemented via a prescriptive-brief fork. |
| M2.4 | Recipient fields (pills, validation, basic autocomplete) | M | M2.2, M1.2 | done | **2026-07-11.** `apps/web/src/compose/`: `RecipientField` (APG editable-combobox — `role=combobox`+`aria-activedescendant` listbox, roving-tabindex pills, full keyboard map: Enter/`,`/`;`/Tab commit, Backspace-empty removes last, ArrowLeft→pills, per-pill move-menu) + `RecipientFields` (To always; Cc/Bcc toggles, auto-shown when populated; "did you mean" apply) replacing M2.3's read-only summary; pure `address-validation` (isPlausibleEmail/parseAddressList), `typo-heuristic` (Levenshtein ≤2 vs an en+de provider list), `recipient-suggestions` (a `RecipientSuggestionSource` interface + recents impl ranked by recency×frequency 30-day half-life + `combineSuggestionSources` M4.3 seam). Replica: new **`addressStats`** store (Dexie `version(2)`, additive) harvested best-effort after `putEmails` (backfill+delta, idempotent `lastSeenAt`); `useReplicaOptional`; store `setRecipients`/`moveRecipient`. +54 tests (713 total, 86 files); 185.0 KB gz (+3 KB pure modules via the barrel; squire/composer stay lazy). Owner-default decisions (Apple-Mail/iOS-aligned): keyboard-move over drag, Cc/Bcc toggles, recents on by default (local-only). Sent/received classification (own-address boost) a follow-up. |
| M2.5 | Identities & signatures | S | M2.2 | done | **2026-07-11.** `@waxwing/jmap`: RFC 8621 §6 `Identity` type + `Identity/get` method (`types/submission.ts`, `methods.ts`). Replica: `identities` store (Dexie `version(3)`, additive) + `useIdentities` + `putIdentities`/`identitiesForAccount`; engine does a one-shot `Identity/get` after `syncMailboxes` (guarded, refetched per session; `Identity/changes` deferred). Composer: pure `signature.ts` (marker-based `applySignature`/`replaceSignature`, `signatureHtmlForIdentity`, `pickDefaultIdentity`) + `FromField` (native-Select From picker, shown only when >1 identity; seeds the default identity's signature above the quote with `markDirty:false`, swaps in place on change preserving user text, respects a deleted signature). Store `fromIdentityId` + `setFromIdentity`. +20 tests (733 total, 89 files); 185.9 KB gz. **Build-infra: `pnpm verify` now runs `build:libs` first** (builds jmap+mail-html `dist` — M2.5 is the first jmap-package API change the web app consumes, and `dist` is gitignored/on-demand, so verify must be self-contained). Owner-default decisions (signature above quote, one-shot fetch, keep-deleted-signature, default = hint-match else primary). |
| M2.6 | Drafts autosave (server + local, crash-safe) | M | M2.2, M1.3 | done | **2026-07-11.** Crash-safe drafts. `sync/`: new **`drafts`** store (`ReplicaDb.version(4)`, keys `[accountId+localId]` + `[accountId+serverEmailId]` + `[accountId+updatedAt]`), `DraftRow`/`SerializedDraft`/`DraftAttachmentLike` types, repo CRUD (`putDraft`/`getDraft`/`getDraftByServerId`/`listDrafts`/`deleteDraft`). Outbox: `saveDraft` (**create-new + destroy-old in one `Email/set`** — RFC 8621 §4.6 / RFC 8620 §5.3 gap-free) + `discardDraft` intents, coalesced by stable id `draft:<localId>`; `reconcileDraftSave` stamps `serverEmailId`+`synced`, `stampDraftError` marks `error`; `setEmails` gained `create`. `compose/`: pure `draft-email` (serialize/deserialize/isEmptyDraft/toEmailCreate/toDraftInit), `use-draft-sync` (durable flush + close/discard), `use-draft-autosave` (3 s idle + `visibilitychange` flush; mounted in ComposerHost), `use-draft-restore` (unsynced drafts → minimized chips; mounted in AppShell), `use-draft-opener` (open-from-Drafts, local copy keeps `bcc`); `openDraft` accepts a fixed `id` (idempotent reopen). `ComposerWindow`: **Close = save to Drafts** (Apple ⌘W), **Discard = delete** (trash button; empty discards silently), **Esc = de-escalate** (full-screen→docked→minimized, no data loss). `MessageList`/`Conversation` route `$draft` clicks to the composer. i18n `compose.discard` + `reading.editDraft`/`draftLead`; discard copy now "permanently deleted". +30 tests (754 total, 91 files); **entry chunk 187.4 KB gz** (≤ 300 budget). |
| M2.7 | Attachments & inline images (upload pipeline) | M | M2.2, SP.1 | done | **2026-07-11.** Composer attachments + inline images. `compose/`: pure `attachment-upload` (validate/`classifyUploadError`/`BlobUploader` seam), `inline-images` (cid↔objectURL canonicalize/resolve/prune), `inline-image-registry` (module-scoped `cid→objectURL`, survives minimize/restore), `use-attachment-upload` (concurrency pool bounded by `maxConcurrentUpload`, per-file progress/cancel/retry, optimistic inline insert, `makeBlobUploader`), `AttachmentChips` (chip row; inline images live in the body, not chips). `RichTextEditor` gains a ref handle (`insertInlineImage`) + `onAddFiles` paste + `resolveInlineImage`; the `lastEmittedRef` guard keeps a just-inserted blob preview from being dropped by the external-value `setHTML`. `EditorEngine.insertImage` seam + Squire adapter (keeps `data-cid`). `ComposerWindow`: paperclip picker + window drag&drop overlay (editor-targeted drop → inline, else attachment) + hidden file input. `draft-email.toEmailCreate` maps `attachments`/inline `disposition` + prunes orphaned inline cids. `mail/attachment-icon` extracted + shared with the reader's `AttachmentList`. jmap: `getMailCapability` (+export), `Retry-After`→`JmapProblemError.retryAfterMs` (`parseRetryAfter`), `useSessionOptional`. i18n en+de (`compose.attach*`, `dropHint`). **+37 tests (791 total, 94 files); entry chunk 188.5 KB gz** — all attachment code confirmed in the lazy `ComposerHost` chunk (11.8 KB), grep-verified absent from `index-*.js`. Owner-decided UX + deferred reload-preview-restore recorded in §M2.7. |
| M2.8 | Send pipeline (submission, errors, undo send) | M | M2.3–M2.7 | done | **2026-07-11.** Send pipeline. jmap: RFC 8621 §7 `EmailSubmission` types + `emailSubmissionSet` method (+`Envelope`/`onSuccessUpdateEmail`). `sync/engine`: `JmapPort.submitEmail` (ONE request — `Email/set create`+destroy+source-flag then `EmailSubmission/set` via `#creationId` back-ref + `onSuccessUpdateEmail` refiling Drafts→Sent/clear `$draft`/set `$seen`); new `sendEmail` outbox intent (optimistic source `$answered`/`$forwarded`, `reconcileSend`/`stampSendError`) with a persisted `notBefore` grace gate; `replayOutbox` skips pre-grace rows and **never auto-resends a stranded `inflight` send** (EmailSubmission isn't idempotent → marked `error`); engine `scheduleSendWake` timer + `cancelSend`. `compose`: `use-draft-sync.send` (identity/Drafts/Sent resolution, envelope `rcptTo`=dedup(to+cc+bcc), coalesces over autosave via `draft:<id>`) + `undoSend`; `ComposerWindow` primary Send button + ⌘/Ctrl+Enter, disabled with no recipients / while uploads in-flight, `attachment-mention` confirm (FR-CMP-10), Undo snackbar (Toast gained an `action`). Source id/kind threaded reply→draft→`SerializedDraft`. `DraftSyncStatus` gains `sending`; `useConfigOptional`. i18n en+de (`compose.send*`, `attachMention*`). **+26 tests (819 total, 96 files); entry chunk 190.0 KB gz.** Owner decisions + deferred Settings undo-picker recorded in §M2.8; the first LIVE `EmailSubmission/set` round-trip is M2.9. |
| M2.9 | E2E write suite (send/receive round-trip) | S | M2.8 | done | **2026-07-11.** Live Playwright write suite (`e2e/tests/write.spec.ts`, 5 specs, alice↔bob against the Stalwart fixture): compose→send→**recipient Inbox** + sender Sent (`$draft` cleared/`$seen` set); reply threading (`inReplyTo`/`references` = source Message-ID + source `$answered`); attachment round-trip; draft autosave + reload recovery (Drafts folder); undo-send cancels delivery + reopens the draft. Recipient/sender asserted over direct JMAP polls (bypasses the ~60 s sweep → fast/non-flaky); undo grace overridden per-test via `page.route('config.json')`. Own harness cloned from M1.9 (`playwright.write.config.ts` :4184, `write.setup/teardown.mjs`, `stalwart/seed-write.mjs`+`.d.mts`, `tests/helpers.ts`); `pnpm e2e:write` wired into `verify:e2e`. **DP-1 verified live:** `EmailSubmission/set` really delivers alice→bob (local in-process; validates the whole M2.8 send path against the real server) — no fixture SMTP change needed. **5/5 green.** Closes Phase 2 — the composer is complete + live-verified end to end. |

### Phase 4 — M3 "Daily driver"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M3.1 | Search (operators, chips, scoping) | M | M1.6 | done | **2026-07-11.** Server-side search. Pure `mail/search/search-query` parser: Gmail operators (`from/to/cc/subject/body`, `has:attachment`, `is:unread/read/flagged`, `in:<folder>`, `before/after` incl. `today/yesterday/YYYY-MM-DD`, quoted phrases) → JMAP `EmailFilterCondition`s 1:1; unknown/unresolved/bad-date degrade to free text; scope ANDs `inMailbox` unless an explicit `in:` overrides. Chips derive from the same tokens (honored ops only) so text↔chips never drift. Engine seam: extracted `backfillQuery` (filter-first) + `watchQuery`/`unwatchQuery` (ephemeral search windows, kept fresh by the existing `reconcileWatched`/forced-full re-probe) + `fetchSnippets`; jmap `SearchSnippet/get` + `snippet.sanitizeSnippet` (escape-then-re-allow bare `<mark>`) rendered via `dangerouslySetInnerHTML`. `useMessageList` gained a `ListSource` (folder|search) union; `MessageList` reused for results (`?q` preserved on open, scope-gated bulk-move, highlight pass-through to `MessageRow`). `SearchBox` (`<search>` landmark, debounced-replace/submit-push, scope Select, removable chips) in `MailScreen`; `/` focus shortcut in `AppShell`. i18n en+de `search.*`. **+31 tests (851 total, 100 files); entry chunk 192.7 KB gz.** **Deferred to V1.x (explicit):** search history dropdown + saved searches + a separate advanced-search modal (the chip strip is the advanced view); offline local search (replica holds only windowed subsets). |
| M3.2 | Keywords/labels UI + folder cleanup tools | M | M1.6 | done | **2026-07-12.** Gmail-style labels over JMAP keywords (no server keyword registry). Curated `localPrefs['labels']` registry (`{keyword,name,color}`, `updateLabels` rw read-modify-write) MERGED read-only with keywords discovered on cached mail (`akw` index) — so a label made in another client shows up (gray). Wire keyword = an immutable IMAP-safe slug (`slugKeyword`; leading-`$` rejected); rename edits the display name only; delete is non-destructive by default (registry entry only) with an optional chunked keyword-strip; adopting a discovered keyword keeps its exact wire form. Assign via a three-state `LabelMenu` (membership computed from the replica over ALL selected ids, hydrating missing envelopes) in the bulk bar, reading view, and `l` shortcut; browse via `/mail?label=` on the M3.1 `hasKeyword` query seam (`label` wins over `?q=`); per-row colored swatches (7 Apple-flag `--waxwing-label-*` tokens); sidebar `Labels` section. Cleanup: engine `emptyMailbox`/`deleteOlderThan`/`trashOlderThan` page ALL ids (total-driven) then chunk `destroyEmails`/`move` intents at `maxObjectsInSet`, never `ifInState` — **delete-older-than MOVES to Trash for a normal folder (recoverable), destroys only Trash/Junk** (a message multi-filed elsewhere is never destroyed everywhere). Built via a Plan-agent brief + a guarded implementation fork + an adversarial review that confirmed 9 defects (2 bulk-tri-state/focus MED, 2 cleanup-robustness/safety MED, incl. the move-to-Trash semantics) — all fixed + regression-tested. **+45 tests (906 total, 108 files); 198.95 KB gz.** i18n en+de. Owner decisions: non-destructive delete + optional strip; per-row swatches; undo-send unaffected. **Deferred:** the live labels round-trip + thousands-message purge E2E → M3.10; inline-image reopen re-download unchanged. |
| M3.3 | Offline outbox hardening + conflict UX | M | M1.3, M2.8 | done | **2026-07-12.** FR-OFF-03 "never silent data loss" made true. **Durable undo:** `applyOptimistic` returns an `OutboxUndo` *value* persisted on the row (the in-memory `Rollback` closure map is deleted) — `status==='error' && undo!=null` ⇒ a rollback is still OWED and `drainOwedUndos` retries it every pass, so it survives a reload, a tab hand-over and an outage (a destroy's undo is a re-fetch of the rejected ids: zero payload, and it self-corrects a partial rejection). **8 confirmed defects fixed:** D1 per-object `rejections()` + `applyUndo(onlyIds)` (one `notFound` in a 500-id destroy used to restore all 500); D2 `notFound` on a destroy = `satisfied`, never a resurrection; **D3 a transient failure NEVER rolls back and NEVER dead-letters** (5 offline/online flaps used to silently destroy a queued action) — it backs off (`backoff.ts`, half-jitter 2 s→5 min, `Retry-After` wins, clamped to 15 min) and stays `pending` forever, reported as `stuckActions`; D4 `pendingOutbox` no longer counts dead letters (new `failedOutbox`/`queuedSends`); D5 temp-mailbox-id rewrite now covers `renameMailbox`/`deleteMailbox`/`moveMailbox`'s subject id; D6/D7 persisted undo + a bus `wake` message so a FOLLOWER's action (incl. a send) replays immediately and the leader can roll it back; D8 the persisted prose `'interrupted before confirmation…'` became the CODE `sendInterrupted` (i18n). `conflict.ts` classifies (`retry`/`refresh`/`satisfied`/`conflict` + 11 stable `ConflictCode`s); `ifInState` guards `Mailbox/set` ONLY (an Email-state guard would make every offline replay a bogus conflict and would break the auto-chunker), with a bounded (≤3, persisted) `stateMismatch` auto-refresh. Replay split out of sync (`requestReplay`, coalesced) + a 750 ms reconnect debounce + a delta failure no longer starves the queue. UX: `outbox/` — warning toast (one action) + a header problems button & lazy dialog (retry/discard/discard all) + durable `QueuedSends` chips; `cancelSend`'s `notBefore` clause dropped (an offline-queued send is provably unsent ⇒ cancelable). No Dexie version bump (additive non-indexed fields). Chaos suite is **hermetic** (virtual clock + driven online flag + mutable fake server); the LIVE Playwright suite stays M3.10. An **independent adversarial review** then confirmed **6 further defects**, all fixed + regression-tested: **(HIGH) DOUBLE-SEND** — a thrown network error on a `sendEmail` fell into the transient branch and was re-sent, although the submission may already have reached the server (the response can simply be lost); it is now dead-lettered as `sendInterrupted` exactly like a stranded one, since `EmailSubmission` is not idempotent. **(HIGH)** `isAuthExpiry` only matched `JmapHttpError`, so a 401 carried by a JSON problem body (`JmapProblemError` is not a subclass) was misread as a per-action conflict and **dead-lettered + rolled back the ENTIRE queue** with no re-auth prompt. **(MED)** a MIXED per-object rejection silently DROPPED the transient objects (never retried, never undone, never recorded) — now any transient failure wins and the whole idempotent row backs off. **(MED)** a non-5xx transport status (a moved endpoint, a proxy 400) dead-lettered the whole queue; a transport-level error says nothing about an individual action, so it is transient now. **(MED)** `discardFailed`/`cancelSend` never woke the leader, whose stale counts then overwrote the badge cross-tab. **(MED)** the chaos fake checked online-ness BEFORE its side effect, so "the server applied it and the response was lost" was unsimulatable — the suite could never have caught the double-send; a lost-response mode + a send scenario were added. Also: the German strings were switched from `du` to the app's `Sie` register, and `retryFailed` now clears the drafts row's error flag. **+92 tests (998 total, 116 files); entry chunk 196.7 KB gz.** **Discharges both ADR-009 debts** (persisted rollback, follower wake). |
| M3.4 | Cache policy & storage management | M | M1.3 | done | **2026-07-12.** FR-OFF-02/04. Two BESTAND defects found first: `blobsMeta` was a **dead table** (`putBlobMeta`/`getBlobMeta` had zero callers — attachments and inline images were re-downloaded on every open, so "LRU eviction of attachments" was vacuous), and `repo.deleteEmails` never cascaded to `emailBodies`, so every delta-synced destroy **leaked its body forever**. Both fixed; a **write-through blob cache** (`blob-cache.ts`, 10 MB/blob cap, cached only on an explicit open) gives eviction something to evict. **Dexie v5** — the first real bump since M2.6: `bytes` on `emailBodies`/`blobsMeta` is INDEXED (`[accountId+lastAccessedAt+bytes]`), so the "additive ⇒ no bump" rule does NOT apply — IndexedDB drops a record lacking an indexed key path from that index *entirely*, i.e. invisible to metering AND eviction — plus a multiEntry `ablob` (blobId → owning body) without which a pinned folder's blobs cannot be protected. The planner (`eviction.ts`) is **pure** — no Dexie, no clock — so every invariant is a unit test over a function; the I/O pass (`maintenance.ts`) is gather → plan → chunked `rw` deletes that name neither `outbox` nor `drafts` (unreachable BY CONSTRUCTION, not by discipline). Order: reap stale windows → evict (orphans → blobs → bodies, LRU) → prune envelopes past `cacheDays` + 7 d that nothing references → drop dead threads → top up pins. `navigator.storage` is behind one injectable seam (`storage.ts`), so every test is hermetic. Settings gains an "Offline & storage" section (lazy chunk: meter, per-category breakdown, persist switch, "Free up space now"); the pin is a `localPrefs` key with a FolderTree menu item. Owner decisions: pin = exempt **+ prefetch** (≤100 bodies/pass); envelopes **are** pruned; `cacheDays`/`maxStorageMB` stay deployment-config (a user override is M3.7); `persist()` on install is handed to **M3.5** (it owns `appinstalled`). **An independent adversarial review then confirmed 5 further defects, all fixed + regression-tested:** **(HIGH) a pressured pass wiped the ENTIRE body/blob cache, every pass** — `planEviction` seeded its usage with envelope bytes it can never free, so once the envelopes alone exceeded the target (the NORMAL state: 20 000 envelopes ≈ 24 MB vs a few MB of opened bodies) the loop drained both lists to completion and still missed; the comment claimed "it converges" — it converged on an empty cache. **(HIGH) the orphan classifier deleted live attachments**: it read a body snapshot taken several awaits before the owner map, so a body cached in that gap (the user just opened the message) looked owner-less — and orphans are deleted with NO budget check. The rule is now the pure, tested `classifyBlobOrphans`: garbage only when there is no owner at all, or every owner is itself an orphan. **(HIGH) a full disk left the reading pane spinning forever** — the pane is local-first (a liveQuery over `emailBodies`), so a body that could not be persisted simply never appeared and the effect never retried; `fetchBody` now RETURNS the un-storable body and `useMessageBody` renders it from memory, which is what "caching is best-effort, it must never fail the read" was always supposed to mean. **(HIGH) the envelope prune could delete the results of a search that was still loading** — the pass compared candidates read late against a window snapshot read early, and `backfillQuery` makes a NETWORK round-trip between writing its envelopes and writing its window row; the backfill now persists the window BEFORE the envelopes it lists and the pass re-reads the windows AFTER the candidates, which makes the invariant *provable* rather than probable. **(MED)** quota recovery joined an in-flight pass planned with `needBytes: 0`, so it freed nothing and told the user the disk was full anyway. Plus: `chooseBudget`'s floor overrode the quota cap (a 10 MB-quota origin got a 50 MB budget ⇒ eviction never fired) — and its test asserted that as correct; the v5 `.upgrade()` could THROW on a malformed legacy row, which aborts the upgrade transaction and makes `db.open()` reject forever after — a **bricked app**, the one unrecoverable failure in the WP; the prefetch had no abort check (sign-out waited on up to 100 requests) and gave up on the first failure (one dead message starved the folder forever); "Free up space" reported the PLAN's bytes, so a pass that pruned 5 000 envelopes toasted "Nothing to free up". Four tests were rewritten because they asserted a count where a total wipe would also pass, or encoded a defect as expected behaviour. **+96 tests (1094 total, 121 files); entry chunk 207.22 KB gz.** |
| M3.5 | PWA: manifest, service worker, offline shell, updates | M | M1.4 | done | **2026-07-12.** FR-OFF-01, FR-DEP-06. `vite-plugin-pwa` 1.3 + Workbox 7.4 in **`injectManifest`** mode — M3.6 extends the same `src/sw/sw.ts` (it added `notificationclick`; the `push` listener anticipated here turned out to be unbuildable — **ADR-010**), so a `generateSW` worker (untyped, unbundled, extended only via `importScripts`) was never an option. It builds under Vite 8 / **Rolldown** (smoke-tested first; the one real show-stopper risk) and emits a fully bundled worker with **zero ESM syntax**, so it registers as a CLASSIC worker — no `{type:'module'}` compatibility cliff. **A BESTAND defect had to be fixed before a worker could be correct at all:** the built `index.html` carried relative asset URLs (`base:'./'`) but **no `<base>` element**, so on any plain static host (FR-DEP-01, a *Must*) a deep-link reload of `/mail/inbox/42` resolved `./assets/index-*.js` against the ROUTE path — confirmed empirically: the SPA fallback answers `200 text/html` and the browser refuses it as a module. **White screen.** `config.json` and the OAuth `redirect_uri` misresolved the same way. Invisible because Stalwart injects a `<base href>` and every E2E starts at `/`. SP.5 had already prescribed the exact fix (plan M4.9), so it is pulled forward, not invented. **Owner decisions:** the manifest is a **hoster-editable deployment file** (`public/manifest.json`, runtime-cached, never precached) rather than baked — FR-DEP-04 is a Must and a white-label install whose icon reads "Waxwing" breaks it; and this is *forced* anyway, since a plugin-generated manifest lands in `additionalManifestEntries`, which workbox-build applies AFTER `manifestTransforms` and therefore cannot be excluded. Install guidance is one account-menu item + a per-platform dialog (Chromium prompt / iOS Share→Home-Screen), never a banner. **The security invariant — the worker caches ZERO bytes from JMAP — is structural, not a denylist:** every cache predicate is anchored to the worker's own directory (`self.location`), because a download URL's path comes from the SERVER and its last segment is the ATTACHMENT FILENAME, chosen by whoever sent the mail. **An independent adversarial review then found 8 further defects, every one of them under a green build — all fixed and regression-tested.** **(HIGH) the runtime caches were never filled:** without `clientsClaim()` (correctly absent) the page that registers the worker is never controlled, so its `config.json`/`theme.css`/`branding/*` fetches bypass the worker entirely — and the first *controlled* load of a freshly installed PWA is, typically, the first **offline** launch, which would then find both caches empty and boot on `DEFAULT_CONFIG`: unbranded, no theme override, broken icons. FR-DEP-04 and FR-THEME-01/02 silently defeated inside the very promise of FR-OFF-01. The worker now **warms both caches at install**. **(HIGH) the `<base href="/">` fix broke the skip link** — reproduced in jsdom: a bare `#main` resolves against the MOUNT ROOT, so on `/mail/inbox/42` the first tab stop for a keyboard or screen-reader user would navigate to `/` and reload the app instead of jumping to the content. **(HIGH) the chunk error boundary did not cover the composer:** it wrapped only the route `<Suspense>`, while `ComposerHost` (and the header's dialogs) hang off their own boundaries — and after a deploy has deleted the old hashed chunks, the composer is the FIRST lazy chunk most people load. A mutation test proves it: with the boundary back inside `<main>`, the failing chunk **unmounts the entire app** (the other tests can no longer even find the navigation). **(HIGH) a rejected draft flush stranded the user:** `await flushOpenDrafts(); activate()` with a `Promise.all`, so a flush that rejects — a full disk, which is exactly M3.4's scenario — swallowed the `activate()`; the toast had already dismissed itself on click and the offer never returned. On the `controllerchange` path it was worse: the tab kept running stale code while the new worker had already swapped the precache. **(MED)** the worker was registered from `AppShell`, i.e. only after a sign-in — no offline shell and no Chromium installability for a first-time visitor; **(MED)** `beforeinstallprompt` was captured in a component effect, but it fires once, is never replayed, and on a repeat visit Chromium fires it while the boot is still awaiting `config.json` — the install offer would simply never appear; **(MED)** the registration's listeners were never removed, and the browser hands back the SAME registration object, so a sign-out → sign-in stacked one update toast per session; **(MED)** the boundary never reset, so one broken screen left the panel up forever and the navigation looked dead. Plus: an update was offered to an UNCONTROLLED page (a shift-reload), where `skipWaiting()` re-parents only the outgoing worker's clients — the toast could never have reloaded anything; workbox-routing silently installs a **second, undeclared `message` listener** (`CACHE_URLS`) that the worker's own comment denied existed (bounded by the scope-anchored predicates, and now documented); and the `loadConfig` deadline had a test that **passed with the deadline deleted**. Four tests rewritten for encoding a defect as expected behaviour. i18n en+de (`pwa.*`, Sie); a11y: the toast reuses the existing live regions, the dialog the existing `ui/Dialog`. **+81 tests (1175 total, 130 files); entry chunk 209.17 KB gz.** |
| M3.6 | Notifications + preferences | M | M3.5, SP.3 | done | **2026-07-13.** FR-NOTIF-01/03, NFR-PRIV-01/02. **Rescoped, and the rescope is the work package's main finding: Web Push cannot be delivered to a browser by any JMAP server that exists** — proved on the wire against the fixture, not inferred (**ADR-010**). Chromium (`AbortError: missing applicationServerKey`, reproduced on the engine) and WebKit (`NotSupportedError`) both refuse a keyless `subscribe()`; a key binds the endpoint to a VAPID signature the server must supply (RFC 8292 §4.2), and **no JMAP server implements RFC 9749**, the capability that would publish that key — Stalwart has zero `vapid` hits at v0.16.11 *and* v0.16.13, Cyrus has no `PushSubscription` at all, and James's VAPID PR was closed unmerged. Stalwart additionally **base64-wraps the aes128gcm ciphertext** while promising raw octets, so its payload is undecryptable in *every* browser — Firefox included, the one browser that would have accepted the unsigned POST. Both defects captured on the wire and written up for upstream (`docs/upstream/`); the base64 bug also explains Stalwart #3169, closed by a bot without triage. Everything *else* in Stalwart's chain is correct (the `PushVerification` round-trip and `StateChange` delivery both ran clean here), so the fault is two lines at the HTTP layer. **Owner decision:** do not build unverifiable machinery — ship the same notifications from the **live push channel** (whenever the app runs, a backgrounded tab included), the full FR-NOTIF-03 preference surface, and a capability probe that **says plainly** what this server cannot do (NFR-PRIV-02). **The new-mail signal had to be rebuilt first:** `drainChanges` folded `Email/changes`'s `created` into `updated`, so a `$seen` flip from another client was indistinguishable from an arrival. **An adversarial review then found 12 defects under a green build — and, sharper, four MUTATIONS that destroy a stated guarantee while leaving all tests green.** **(HIGH) notifications survive sign-out:** the OS owns them, across sign-out, reload and browser restart — "delete local data" wiped IndexedDB while banners reading sender + subject sat in the notification centre, and clicking one still deep-linked into the abandoned mailbox. **(HIGH, tests) the `receivedAt`-floor test asserted `sinceMs > 0`**, which the incrementing fake clock makes vacuous: re-stamping the floor on every pass — destroying it outright — kept every test green. **(HIGH, tests) the mid-pass leadership re-check had zero coverage** — deleting the line kept every test green. **(MED)** `isAppClient` filtered *nothing* at a root deployment (`startsWith('/')` is true of every page on the host), so a click could focus Stalwart's admin portal and open no mail window; **(MED)** a rejected `focus()` escaped `waitUntil` and took the `openWindow` fallback with it — click, and nothing happens at all; **(MED)** the registration is published *before* the worker activates, and `showNotification()` rejects on an inactive one — swallowed by `allSettled`, so the first mail of a fresh session vanished; **(MED)** a client clock running *fast* silently suppressed every notification for the length of the skew (the floor is a client clock, `receivedAt` is the server's) — now clamped to the newest `receivedAt` the replica holds; **(MED)** the foreground guard asked only the *leader's* tab, but the leader is the tab opened *first* — work in a second tab and you get banners for mail you are watching arrive. Now a query/ack over the existing `EngineBus`: no heartbeat, no TTL, and a crashed tab simply does not answer. **(MED)** the burst cap was per *pass*, and push fires a pass per `StateChange` — a list flooding 20 messages 2 s apart produced 20 banners and never once tripped the cap; now a rolling 60 s budget with an accumulating summary. Plus: an unguarded `keywords` deref lost a whole pass's notifications silently; a dismissed permission prompt bounced the switch back with no explanation. **Verified in a real browser against the real bundle** (Chrome, not Playwright's Chromium, which denies the permission outright): the page is genuinely *uncontrolled* — M3.5 omits `clientsClaim()` — and `showNotification()` works anyway, which is the assumption the whole WP rests on and which no unit test can reach. **+124 tests (1299 total, 137 files); entry chunk 211.92 KB gz.** |
| M3.7 | Settings area: capabilities panel, vacation, quota | M | M1.4 | done | **2026-07-13.** FR-SRV-04, FR-VAC-01, FR-QTA-01, FR-CMP-02/08, FR-RD-02. Settings shell (General · Appearance · Reading · Compose · Vacation · Notifications · Offline & storage · Server · About); **capabilities panel** reading limits from `accountCapabilities`, not the top-level capability (Stalwart's top-level `mail` is `{}` — a panel built the obvious way renders an EMPTY table against the very server we test with, and passes every hermetic test written with a hand-made session); **vacation responder** (`VacationResponse/get|set` on the `singleton`, `ifInState`, rich body reusing the M2.1 editor, preview through the *same* sanitizer and sandboxed frame the reading pane uses); **quota** (RFC 9425, capability-gated, sidebar bar + settings panel + ≥ 90 % toast, `invalidateQuota()` on the two existing `overQuota` paths). **Owner decisions:** no accent picker (deferred to M4.5 — the contrast test only machine-verifies the built-in accent, and a11y is a Must); undo-send default **10 → 15 s**, closing a standing code-vs-spec drift (FR-CMP-08). **Step 0 was live-probed before a line was written**, and it mattered: the fixture advertises `vacationresponse` *and* `quota`, but `Quota/get` returned an **empty list** — the capability was advertised with no quota assigned, so the WP's own Done-when was untestable. Stalwart's management API (`x:Account/set`, `quotas: { maxDiskQuota }` — the other three spellings are rejected) now seeds it in `fixture.mjs`, on a fresh volume too. **The size budget was measuring a lie, and the ruler is fixed.** `.size-limit.js` counted `index-*.js` alone; the emitted `index.html` eagerly `modulepreload`s four further statically-imported chunks. M3.7's re-chunking moved `ui` (7 KB) and `i18next` (13 KB) out of the entry, so the reported figure **dropped 17 KB while the code moved sideways**. The rule is now inverted — everything under `assets/` counts unless explicitly named as a lazy chunk, so a new eager chunk is counted automatically. **True initial JS: 220.63 KB gz** (budget 300); M3.6's reported 211.92 was itself ~5 KB short. **Three defects the unit tests could not see, all caught by running the E2E:** **(HIGH, and it is an M3.5 defect that M3.7 merely exposed) the service worker was hijacking the OAuth sign-in redirect.** The navigation denylist anchored reserved server paths with `(?:/|$)`, but Workbox matches against `pathname + search` — and an OAuth authorization URL *always* carries a query string, so `/login?client_id=…` was **not** denied and the worker answered it out of the precache. The user clicks "Sign in securely" and gets the app shell back instead of the server's login form: **OAuth broken for every returning visitor** (FR-AUTH-02, a Must). Latent since M3.5 because it needs the worker to be controlling that navigation; M3.7's re-chunking made the race deterministic and the M1.9 OAuth E2E finally failed. Anchor is now `(?:[/?]|$)`; every existing denylist test used a query-less path. **(HIGH) the vacation form was an infinite request loop:** `makeVacationClient()` returns a fresh object, so the unmemoized client was a new identity every render, the load effect depended on it, and each `setDraft` scheduled the next load — `VacationResponse/get` hammered until Stalwart answered 429, and the user's toggle was overwritten by the server's copy before it could be saved (the switch physically could not be turned on). Invisible to the unit tests because they *inject* a client, whose identity is stable — the regression test now goes through the session, the only shape that can fail. **(HIGH) the away message was silently dropped:** the editor debounces `onChange` by 200 ms, and the form built its patch straight from React state, so a user who typed and reached for Save saved an EMPTY body — subject and the on-switch arrived, the message did not. This is exactly the data loss `RichTextEditorHandle.flush()` was added for in **M2.8**; the new consumer simply did not use it. Both fixes are mutation-verified. E2E: **read 10/10** (OAuth back to 467 ms from a timeout), **write 8/8** incl. the three new settings specs — the vacation responder round-trips against the live server, the capabilities panel agrees with the live session document, and the quota bar reflects the seeded allowance. **+86 tests (1385 total, 146 files); initial JS 220.63 KB gz.** |
| M3.8 | Keyboard shortcuts + command palette | M | M1.4 | done | + fixed a sync defect: a moved message was never removed from the cached list window |
| M3.9 | Reading & triage polish (headers, .eml, phishing, DnD, swipe) | M | M1.8 | todo | |
| M3.10 | E2E: offline & push suites | M | M3.3, M3.5, M3.6 | todo | |
| **G2** | **Gate: Stalwart-v1.0 baseline decision (D3) + M3 review** | — | M3.10 | todo | blocks M4 finish |

### Phase 5 — M4 "V1 release"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M4.1 | `@waxwing/jscontact` (JSContact ↔ vCard 4) | M | P0.1 | todo | |
| M4.2 | Contacts area (books, cards, groups) | L | M4.1, M1.1, M1.3 | todo | |
| M4.3 | Contacts↔mail integration (autocomplete, hover cards, import/export) | M | M4.2, M2.4 | todo | |
| M4.4 | Shared accounts (delegated mailbox trees) | M | M1.3 | todo | |
| M4.5 | Theming & white-label completion | M | M1.4 | todo | |
| M4.6 | i18n completion (en + de), RTL readiness audit | M | all UI WPs | todo | |
| M4.7 | Accessibility audit & fixes (WCAG 2.2 AA) | M | all UI WPs | todo | |
| M4.8 | Performance hardening & budget verification | M | all UI WPs | todo | |
| M4.9 | Release engineering: artifacts, guides, security docs, v1.0.0 | L | M4.1–M4.8, G2 | todo | |
| **G3** | **Gate: release sign-off (a11y, perf, security, docs)** | — | M4.9 | todo | |

## 4. Phase Overview & Dependencies

```
P0 Foundation ──► SP Spike ──► G1 ──► M1 Read ──► M2 Write ──► M3 Daily driver ──► G2 ──► M4 V1 ──► G3
 ~1 week          1–2 weeks          4–6 weeks    3–5 weeks     4–6 weeks                 4–6 weeks
```

Calendar figures assume part-time work with agent support and are **orientation only** —
the unit that matters is the WP. Within a phase, WPs with disjoint dependencies can run in
parallel (e.g. M1.1/M1.2/M1.7 right after G1; M4.1 any time). Two WPs are deliberately
early despite belonging to later feature areas: the action-queue skeleton (in M1.3) and
account-scoping (M1.2), because retrofitting either would be expensive.

Phase-level exit criteria are listed at the end of each phase section. Gates G1–G3 are
explicit stop points requiring the project owner's review.

---

## 5. Phase 0 — Foundation

Goal: a repo where every later WP finds tooling, tests, CI and a live JMAP server ready.
No product features.

### P0.1 — Repo bootstrap

Spec: §2 tech-stack (constraints), licensing. Size: S.

- [x] `git init`, `.gitignore` (node, dist, playwright artifacts), `.editorconfig`.
- [x] pnpm workspace: `pnpm-workspace.yaml` covering `apps/*`, `packages/*`, `e2e`;
      root `package.json` with `engines` pin and scripts (`typecheck`, `lint`, `test`, `build`).
- [x] Directory skeleton per tech-stack §5: `apps/web`, `packages/jmap`,
      `packages/jscontact`, `packages/mail-html`, `e2e`, `docs/adr/`.
- [x] TypeScript strict base config (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
      `exactOptionalPropertyTypes`, `isolatedModules`); per-package tsconfigs extend it.
- [x] Biome config (lint + format, one config at root).
- [x] Licenses: `LICENSE` (AGPL-3.0) at root; `LICENSE` (MIT) in `packages/jmap` and
      `packages/jscontact` — flagged pending D1 (§13, noted in each package README).
- [x] README: add "Development" section (prereqs, `pnpm install`, script overview).

Done when: `pnpm install && pnpm typecheck && pnpm lint` run clean on a fresh clone.
✅ Verified 2026-07-05: `pnpm install` (6 workspace projects) → `pnpm typecheck` →
`pnpm lint` all green. Toolchain pinned: Node ≥ 22, pnpm 11.1.1, TypeScript 6.0.3,
Biome 2.5.2.

### P0.2 — App scaffold

Spec: FR-DEP-01/02/03/04, FR-THEME-01/02 (boot path only), FR-I18N-01, NFR-SEC-01. Size: M.

- [x] Vite 8 + React 19 app in `apps/web` (see ADR-001); **`base: './'`** (relative asset paths — required
      for Stalwart `<base href>` rewriting, FR-DEP-02); verify built `index.html` uses only
      relative URLs.
- [x] CSS Modules wired; `src/ui/tokens.css` starter: `--waxwing-*` custom properties
      (color, spacing 8-pt scale, radius, typography), light + dark sets behind
      `prefers-color-scheme` plus a manual override (`:root[data-theme=…]`).
- [x] Boot loader: fetch `config.json` and `theme.css` from the deployment directory at
      startup (network-first, graceful defaults when absent); typed config schema matching
      spec §9; document that these files are **never** precached later.
- [x] i18next scaffold: lazy-loaded JSON locales `en`/`de`, `Intl`-based date/number
      helpers, a `t()` lint convention (no raw strings in JSX).
- [x] Strict CSP in dev (`vite` dev-server headers) and documented for deployment:
      no inline script, no `eval`, `frame-src` for the mail iframe strategy.
- [x] Icons: Lucide installed, tree-shaking verified in a build.

Done when: `pnpm --filter web build` produces a static bundle that boots from a plain
file server under an arbitrary path prefix, shows a placeholder shell in en/de, light/dark.
✅ Verified 2026-07-05 (multi-agent workflow): typecheck/lint/build green; initial JS
80.95 KB gz (budget 300 KB); Playwright boot under an arbitrary `/deploy/mail/` prefix —
shell renders product name from `config.json`, en↔de (lazy locale chunks) and
light↔dark (persisted) both work, **all 8 requests same-origin** (NFR-PRIV-01), 0 console
errors; 18 token contrast pairs pass WCAG AA in both themes; ADR-001 records the Vite 8
decision. Follow-ups tracked: SRI for own assets (release/M4.9) and radiogroup a11y
polish for the switches (with P0.3 tests).

### P0.3 — Test infrastructure

Spec: NFR-QUAL-01, tech-stack §7. Size: S.

- [x] Vitest workspace config (per-package projects); Testing Library + `jsdom` for
      `apps/web`; `fake-indexeddb` for Dexie-touching unit tests.
- [x] Playwright skeleton in `e2e/` (config, one placeholder spec, HTML reporter);
      browsers pinned.
- [x] `axe-core` integration helper for component a11y assertions.
- [x] One example test per level proving the harness works.

Done when: `pnpm test` and `pnpm e2e` (against the P0.4 fixture) run green in one command each.
✅ Verified 2026-07-05: `pnpm test` (Vitest 4.1.9, 4 tests / 2 projects) and `pnpm e2e`
(Playwright 1.61.1, chromium) both green; `typecheck`/`lint` green (44 files). The P0.3
Playwright placeholder spec is **self-contained** (drives the built `apps/web` via
`webServer`, no JMAP server); Stalwart-fixture-backed E2E specs land with **P0.4** and the
read suite in **M1.9**. Vitest projects: `unit` (node + `fake-indexeddb/auto`) and `web`
(jsdom + Testing Library). axe helper wraps `axe-core` directly against WCAG 2.x A/AA tags
(color-contrast is browser-only → covered by the M1.1 gallery scan). Test deps are
devDependencies only (bundle budget unaffected).

### P0.4 — Stalwart dev/E2E fixture

Spec: NFR-COMPAT-02 (baseline v0.16), tech-stack §7. Size: M.

- [x] `e2e/stalwart/docker-compose.yml` with **pinned Stalwart v0.16.11-alpine** image;
      ephemeral named volumes; host port `18080` documented; healthcheck on `/healthz/ready`.
- [x] Provisioning script (idempotent, `e2e/stalwart/fixture.mjs`): test domain
      `waxwing.test` (Stalwart rejects `test.example`), recovery `admin`, users
      alice/bob/carol with a shared known password; OAuth/OIDC on by default; runs over the
      JMAP management API (`x:Domain/set`/`x:Account/set`, query-before-create). *v0.16 has
      no static-account config, so accounts are provisioned after boot — ADR-002.*
- [x] TLS story for dev: **plain-HTTP localhost exception** (no TLS, loopback only) — chosen
      over mkcert; documented in the fixture README + ADR-002.
- [x] `pnpm e2e:server` (up + provision + smoke + healthcheck poll on `/.well-known/jmap`),
      `pnpm e2e:server:down` (`down -v`; profile-aware so it removes the running variant).
- [x] Smoke test (ADR-002): unauthenticated session → **200 anonymous** (empty
      `accounts`/`username`, i.e. no data leak — Stalwart does **not** 401 here); **invalid**
      Basic credentials → **401**; **valid** Basic → **200** session with `capabilities` +
      non-empty `accounts`.
- [x] Second compose profile (`main`) tracking `stalwart:latest` for the scheduled compat
      job (used by P0.5, non-blocking); never runs by default.

Done when: one command gives any contributor a working JMAP server with test accounts.
✅ `pnpm e2e:server` boots + provisions + smoke-checks; `pnpm e2e:server:down` leaves no
containers/volumes/networks.

### P0.5 — Local verify scripts + size budgets

Spec: NFR-PERF-01/03, NFR-QUAL-01, tech-stack §6. Size: S.

Re-scoped by **ADR-003** (local verify scripts now, GitHub Actions CI later): there is no
repo/remote/branch protection to attach a pipeline to yet, so the same checks a CI would
run are realized as two root scripts. The future GitHub Actions workflow is expected to be a
thin wrapper over these scripts.

- [x] `pnpm verify` — fast hermetic gate, fail-fast in sequence: `typecheck` → `lint`
      (Biome) → `test` (Vitest) → `size` (`size-limit`; builds `apps/web` first, so the prod
      build **and** the ≤ 300 KB gz budget are both exercised).
- [x] `pnpm verify:e2e` — Docker + browser gate (`scripts/verify-e2e.mjs`, dependency-free):
      install pinned Playwright chromium → bring the P0.4 Stalwart fixture up (`pnpm
      e2e:server`, self-smokes per ADR-002) → Playwright suite (`pnpm e2e`) → **always** tear
      down (`pnpm e2e:server:down`) via `try/finally` + signal handlers.
- [x] `pnpm verify:all` = `pnpm verify && pnpm verify:e2e`.
- [x] `size-limit` config (`.size-limit.js`): **≤ 300 KB gzipped initial JS** for `apps/web`
      critical path (ENFORCED). Per-package budgets for `@waxwing/jmap` (target ≤ 15 KB gz)
      and `@waxwing/mail-html` are documented but DEFERRED until those packages emit a lib
      build (SP.1 / M1.7).
- [~] _Deferred to the eventual GitHub Actions CI (per ADR-003):_ the pipeline itself and
      its server-side "cannot merge" branch protection; the scheduled weekly compat job
      against the `main` profile (`stalwart:latest`); README status badges.

Done when: ✅ `pnpm verify` fails non-zero on a size-budget overrun or broken test, and
`pnpm verify:e2e` runs the fixture E2E with guaranteed teardown. GitHub Actions branch
protection ("cannot merge") deferred per ADR-003.

**Phase 0 exit criteria:** all P0 WPs done; a fresh clone reaches green via `pnpm verify:all`
locally in < 10 minutes (GitHub Actions CI deferred per ADR-003); Stalwart fixture
documented in README.

---

## 6. Phase 1 — Spike

Goal: retire the project's riskiest unknowns with running code, per tech-stack §9.1. Code
quality matters (SP.1/SP.2 are production foundations), but **UI polish explicitly does
not** — SP.4 is a throwaway dev page. Everything learned lands in SP.5's report.

### SP.1 — `@waxwing/jmap` core

Spec: FR-SRV-01/02/03, tech-stack §4.2. Size: L.

- [x] Package scaffold: zero runtime deps, ESM, `exports` map, tsup lib build (dist ESM +
      d.ts); `sideEffects: false`.
- [x] Session: fetch + parse `/.well-known/jmap` (relative for same-origin, absolute for
      manual connect); typed `Session`, `Account`, capability objects; re-fetch on
      `sessionState` change (`sessionStateChanged`).
- [x] Request layer: typed `Invocation`s, method-call builder with client-side ids,
      **back-references** (`ResultReference`/`#`), request-level and method-level error
      types per RFC 8620 §3.5–3.6.
- [x] **Auto-chunking** against session limits: `maxCallsInRequest`, `maxObjectsInGet`,
      `maxObjectsInSet`, `maxSizeRequest` (FR-SRV-03); transparent re-assembly of results.
      Reference-connected calls kept in one request; split `/set` merges partial failures
      into per-object `SetError`s (non-atomic, documented). Limits from the core capability
      with conservative fallbacks.
- [x] Types (spike scope): Core (`Core/echo`), `Mailbox/*`, `Email/*` (incl. `Email/query`,
      `Email/changes`, `Email/queryChanges`, `Email/parse`), `Thread/*`; typed method
      registry (`Methods`). Reserved module slots for Submission/Identity/Vacation/
      SearchSnippet/PushSubscription/Blob/Quota/Sieve/Contacts (`types/index.ts`,
      `capabilities.ts`). Referenced `jmap-rfc-types`/`jmap-jam` (MIT); no dependency.
- [x] Blob transfer: upload via session `uploadUrl`, download via `downloadUrl` URI
      template ({accountId}, {blobId}, {type}, {name}); progress callbacks; RFC 6570 escaping.
- [x] Auth-scheme abstraction (`bearer` / `basic`) injected into all transports (FR-AUTH-04
      groundwork); injectable `fetch`.
- [x] Unit tests: chunking edge cases, back-ref resolution, error mapping (mock fetch) —
      64 hermetic unit tests.

Done when: against the P0.4 fixture, an integration test lists mailboxes, queries and
fetches emails, and round-trips a blob — all through the typed API.
✅ Verified 2026-07-05: `pnpm verify` green (64 unit tests, hermetic); `@waxwing/jmap`
builds via tsup to **9.32 KB gz** (SP.1 target ≤ 15 KB); integration test **4/4 against the
live Stalwart fixture** — `getSession`+capabilities, role-mailbox listing, `Email/set`
create → back-referenced `Email/query`→`Email/get`, blob upload/download byte-for-byte.
Two real bugs fixed under review (creation-id-key chunk grouping; split-`/set` partial-
failure data loss). Deferred: activate the `@waxwing/jmap` size-limit budget in the `size`
pipeline; oversized *splittable* `/get` currently throws rather than size-splitting (locked
by a test).

### SP.2 — Auth: OAuth PKCE + token storage + Basic

Spec: FR-AUTH-01/02/03/04/05, NFR-SEC-02, tech-stack §4.7. Size: M.

- [x] RFC 8414 discovery against Stalwart's OIDC metadata; Authorization Code + PKCE via
      `oauth4webapi`; redirect handling that works under any path prefix (FR-DEP-02).
- [x] Token lifecycle: access token in memory only; refresh token in IndexedDB wrapped by
      a **non-extractable WebCrypto AES key** (also stored in IndexedDB as CryptoKey);
      silent refresh; offline start from persisted refresh token.
- [x] Clarify Stalwart client-registration behavior: default no pre-registration vs.
      `requireClientRegistration` → client id from `config.json` (record in SP.5).
- [x] Basic-auth path behind the same auth-scheme abstraction; "stay signed in" opt-in.
- [x] Logout: token revocation where supported + full local wipe (IndexedDB, caches,
      registrations) — the FR-AUTH-05 primitive, UI comes in M1.4.
- [x] Unit tests for token store; integration test: full PKCE dance against the fixture
      (Playwright, since it needs a real redirect). _31 hermetic tests; plus a live Playwright
      driver exercised the real Stalwart login page end-to-end (throwaway, not committed —
      the permanent fixture-backed suite lands with SP.4/M1.9's redirect UI)._

Done when: login → API call → token refresh → logout works against local Stalwart with
both OAuth and Basic. **✓ Verified live** against Stalwart v0.16.11-alpine: OAuth
Authorization-Code + PKCE(S256) driven through Stalwart's real `/login` page as
`alice@waxwing.test` → callback code exchange at `/auth/token` → `Mailbox/get` (5 mailboxes)
→ forced silent refresh (access token rotated, JMAP re-verified) → logout (no revocation
endpoint → local wipe; refresh token destroyed); and the Basic path (session + `Mailbox/get`).

**SP.2 progress (auth module complete; hermetic + live verification green).**
Implemented in `apps/web/src/auth/` (`AuthController` orchestrates OAuth + Basic; `SecretStore`
wraps secrets under a non-extractable AES-GCM `CryptoKey` in IndexedDB — never
`local`/`sessionStorage`, NFR-SEC-02; `TokenStore` keeps the access token in memory and
persists only the refresh token; `oauth.ts` wraps `oauth4webapi@3.8.6`; `wipe.ts` is the
FR-AUTH-05 remove-data primitive). Redirect URI is derived from `document.baseURI` at runtime
(FR-DEP-02). `pnpm typecheck`/`lint`/`test` (93 tests: +31 auth) and
`pnpm --filter @waxwing/web build` all green; bundle unchanged at 80.55 KB gz (auth is
tree-shaken until SP.4/M1.4 import it; projected delta ≈ 10 KB gz, oauth4webapi ≈ 14 KB gz
standalone).

**Review fixes applied (post-implementation review):** silent refresh is now single-flighted
(concurrent callers share one `refresh_token` grant, so a rotation cannot invalidate racing
refreshes); OAuth callback params (`code`/`state`/`error`) are scrubbed from the URL on every
exit path, not just success (NFR-SEC-04); a terminal refresh rejection (`invalid_grant`/
`invalid_client`) now also purges the persisted refresh token so `restore()` cannot resurrect
a phantom session; the secret store is account-scoped by database name from day one
(FR-AUTH-07, **ADR-004**) so a second account is additive, not a migration; and the dev-server
CSP (`vite.config.ts`, dev-only, never the prod `index.html`) names the `http://localhost:18080`
Stalwart origin in `connect-src` so the browser OAuth flow is not blocked in dev/E2E.

**Findings for SP.5 (updated; now live-verified against Stalwart v0.16.11-alpine):**
(1) **No** OAuth client pre-registration — a fixed public `client_id` (`waxwing`) +
`token_endpoint_auth_method=none` + PKCE(S256) completes the flow; Stalwart's `/login`
authorization endpoint accepts the unregistered client with an arbitrary `http://localhost:PORT`
redirect_uri (200 + login page). `e2e/stalwart/fixture.mjs` left unchanged.
(2) **No** RFC 7009 revocation endpoint (nor `end_session_endpoint`) is advertised in either
discovery doc, so logout = local wipe + natural expiry (confirmed live: `revokeToken` returns
`false`). (3) Access tokens are **opaque** (`sw1.` prefix), not JWTs; the refresh token is
reused (not rotated) on a fresh access token, so the store retains the prior refresh token when
the response omits one. (4) **Interop gotcha (fixed):** Stalwart returns an **unsolicited
ES256 `id_token`** from `/auth/token` on both the code exchange and refresh even though we
never request `openid`; because the RFC 8414 metadata omits `id_token_signing_alg_values_supported`,
oauth4webapi defaults the expected id_token alg to RS256 and aborts the exchange
(`unexpected JWT "alg"`). `oauth.ts` now strips the unsolicited id_token before oauth4webapi
validates it, keeping us on the pure-OAuth2 path (regression-locked by a hermetic test).
(5) Refresh-token lifetime: `expires_in=3600` for the access token; refresh-token TTL not
introspected here (open for SP.5 — introspection_endpoint IS advertised). Discovery defaults
to `oauth2` (RFC 8414); default scopes `mail` + `offline_access` (no `openid`). Follow-ups:
the browser WS/SSE bearer-auth question (EventSource cannot send `Authorization`) stays with
SP.3/SP.5; the permanent fixture-backed Playwright login suite lands with SP.4/M1.9.

### SP.3 — Push transports

Spec: FR-NOTIF-01, tech-stack §4.2/§8. Size: M.

- [x] SSE client for the session `eventSourceUrl` (URI template: {types}, {closeafter},
      {ping}). **Open question answered:** Stalwart's SSE endpoint authenticates **only** via
      the HTTP `Authorization` header (Bearer/Basic) — `?access_token=`/`?token=` query params
      → 401, no session cookie exists → cookie auth impossible. The native `EventSource` DOM
      API cannot set headers and so can never authenticate, so SSE is implemented as a
      **fetch-based reader** (`fetch` + `ReadableStream`) sending `Authorization: Bearer` —
      **ADR-005**. (A `sseAuth:'query'` `?access_token=` mode exists behind an explicit option
      for other servers; default is `header`.)
- [x] WebSocket RFC 8887 client: `capability:websocket` detection, subprotocol `jmap`,
      request/response framing (`@type: Request/Response/WebSocketPushEnable/…`), push
      enable/disable, `StateChange` delivery. Works fully server-side/Node (Bearer/Basic
      header on the Upgrade → 101); **not browser-viable against Stalwart** (browsers cannot
      set the WS `Authorization` header, and Stalwart accepts no query/subprotocol token) —
      evidence for D2, recorded in SP.5.
- [x] Shared reconnect/backoff with jitter (full-jitter, reset after a stable connection);
      transport auto-selection: WebSocket → EventSource → polling stub (interface only — real
      long-poll lands in M1.3; `PollingChannel.open()` reports "not implemented (M1.3)").
- [x] Instrumented demo (`scripts/push-demo.mjs`): deliver a mail via the fixture, log
      `StateChange` latency on both transports.

Done when: both transports deliver `StateChange` events for incoming mail against the
fixture and survive a server restart (reconnect).
✅ Verified 2026-07-09 against Stalwart v0.16.11-alpine: `createPushChannel` auto-select
opened both transports, delivered a `StateChange` (`changed`: Thread, Mailbox, Email), rode
out a `docker compose restart` (WS reconnected after ~1.6 s via an abnormal-close code 1006;
SSE reconnected after ~1.8 s via stream-end — both with the same opaque token), and delivered
a subsequent `StateChange`. Measured StateChange latency **2–5 ms** on both transports (local
`Email/set` ~1 ms; real MTA loopback delivery ~1 s of queue time).

**SP.3 findings (push transports, live-verified against Stalwart v0.16.11-alpine).**
Implemented as a zero-dep runtime module `packages/jmap/src/push/`: a fetch-based `SseChannel`
(WHATWG SSE parser), an RFC 8887 `WebSocketChannel` (typed `Request`/`Response` round-trip +
`WebSocketPushEnable`/`StateChange`), a shared `ReconnectLoop` (generation-guarded full-jitter
backoff 1 s→30 s cap, reset after a 5 s-stable connection, `AbortSignal`/`close()` teardown)
and `createPushChannel`/`pickTransport` auto-selection (WS→SSE→polling stub). Public
`PushChannel` surface: `{ transport, status: connecting|open|reconnecting|closed, open(),
close(), subscribe(cb), onStatus(cb), onError(cb) }`. **Latencies:** local `Email/set` →
`StateChange` ~1 ms; observed end-to-end 2–5 ms on WS and SSE; full reconnect after a
`docker restart` ≈ 2.1 s downtime, same token/creds reconnect automatically. **Bundle:** push
is tree-shaken out of `apps/web` — the 300 KB gz budget is untouched (still 80.55 KB gz); the
`@waxwing/jmap` full barrel grows **+5.59 KB gz** (9.32 → 14.91 KB gz) with push included,
still under the ≤ 15 KB target. **Tests:** 72 hermetic push units (mocked
fetch/WebSocket/timers) + 4 auth + 3 live SP.3 integration tests (WS + SSE scenarios +
capability check; `describe.skipIf` auto-skips when the fixture is down); repo total 178
tests green. **Review fixes applied:** re-entrant `close()` guard in the reconnect loop; WS
eligibility gated on `supportsPush === true`; backoff reset moved to a 5 s-stable-connection
signal (`DEFAULT_STABLE_AFTER_MS`) rather than resetting on the first open. **Auth surface:**
`AuthProvider` gained an optional `token()` (implemented by `bearer()`, not `basic()`) to feed
the SSE header/query auth — an additive extension of the SP.1 auth-scheme abstraction — and
`JmapRequestError` (RFC 8887 §4.2) was added to the error hierarchy (ADR-005). **Deferred
(scope-noted, not defects):** polling transport is interface-only (M1.3 owns long-poll);
post-reconnect `Foo/changes` re-sync is M1.3's (the channel exposes the per-type states in
`StateChange.changed`); no client-side SSE idle watchdog (drop is detected via
stream-end/socket-close, which the Done-when requires); Stalwart supports **no** SSE
`Last-Event-ID` resumption (never emits an `id:`, ignores a stale `Last-Event-ID`) so the
client must re-sync via `*/changes` after any reconnect (informs M1.3); WS `pushState`
resumption is pass-through only.

**Post-review follow-up — runtime transport failover (tagged SP.4 in the push suite,
2026-07-09; SP.3 stays `done`).** A live-verified footgun surfaced after the SP.3 review: the
original `createPushChannel` picked ONE transport *statically*, so in a browser against
Stalwart it selected WebSocket (eligible — the capability advertises `supportsPush:true`) yet
the WS handshake 401s forever (browsers cannot set the `Authorization` header), delivering
**zero** push and never degrading to SSE unless the caller knew to pass `prefer:'sse'`. Fix:
`createPushChannel` now returns a `FailoverPushChannel` facade that connects the *eligible*
transports (`eligibleTransports`, WS→SSE→polling) in turn and, when one never reaches `open`
within a small attempt budget (`failoverAfterAttempts`, default 2), tears it down and advances
on its own — so the browser degrades to SSE with no caller involvement. Once a transport
opens, its own `ReconnectLoop` owns every drop (never downgrades — the "survives a restart"
invariant); the last real transport is never torn down onto the non-functional polling stub,
so a transient startup blip self-heals instead of permanently killing push; and `prefer` is a
soft *reorder* (consistent with `pickTransport`), never a restriction that could collapse the
set to polling-only. Review findings on the failover itself were applied at root cause (last
found: the terminal-transport budget regression, the `prefer` restrict-vs-reorder divergence,
and a missing never-downgrade-after-open test lock). Tests: the hermetic push suite grew to
cover the failover state machine (WS→SSE degrade, no-downgrade-after-open with a budget-1
mutation lock, last-real-transport-retries-forever, `prefer` reorder, mid-swap `close()`) plus
a new live case — a browser-like WebSocket built without the auth header 401s and the facade
lands on SSE and delivers `StateChange`, using the default preference (no `prefer:'sse'`).

### SP.4 — Raw end-to-end demo

Spec: validates FR-AUTH-01, FR-MBX/LST plumbing; tech-stack §9.1. Size: M.

- [x] Dev-only route in `apps/web` (excluded from production build): login form (OAuth +
      Basic), mailbox list with counts, paged message list (`Email/query` +
      `Email/get`), raw message view (text body, naive HTML in sandboxed iframe —
      **not** the real sanitizer).
- [x] No replica, no virtualization, no design system — direct client calls only.
- [x] Exercise `Email/parse` on an attached `message/rfc822` to answer the SP.5 question.

Done when: a human can log into the fixture and read a delivered test mail end-to-end.
✅ Verified 2026-07-10 against Stalwart v0.16.11-alpine, driven from a real browser
(Playwright): Basic sign-in → `Mailbox/get` counts → paged list → open a seeded mail → its
text body and its sandboxed HTML body render → `Email/parse` on the `message/rfc822`
attachment renders the inner message's subject **and body** → attachment blob downloads.
A second spec drives the full OAuth PKCE dance through Stalwart's `/login` SPA (localhost
only — see the secure-context finding below).

**SP.4 findings.**
*Not a URL route.* The demo is gated on `import.meta.env.DEV && import.meta.env.VITE_WAXWING_DEMO
=== '1'` and mounted through a dynamic `import('./demo/main')`. `import.meta.env.DEV` is a
build-time literal, so Rollup dead-code-eliminates the whole demo tree — proven by grepping the
emitted `dist/` for demo markers, component names and demo i18n strings (all absent; the
`apps/web` budget is unchanged at **80.55 KB gz**, and the demo's `demo.*` strings live in
`src/demo/locales/` and are registered at runtime, not in the shipped `common.json`). A route
was rejected because the OAuth `redirect_uri` is `computeRedirectUri(document.baseURI)` — the
app root, without query or hash — so a `?demo`/`#demo` route would not survive the redirect back.

*Reaching the demo from another machine needs three things, not one.* Stalwart pins the session
and OIDC URLs to the container's `STALWART_PUBLIC_URL` and **ignores** `Host` and
`X-Forwarded-*`; it also emits no CORS headers. A same-origin proxy alone is therefore not
enough — the advertised origin must match the browser's. `pnpm demo [--lan]`
(`scripts/demo.mjs`) resolves the browser origin, brings the fixture up advertising exactly it,
seeds alice's inbox, and starts Vite with a demo-only same-origin proxy
(`/jmap`, `/.well-known`, `/auth`, `/login`, `/api`, `/logo`; none collide with Vite's dev
paths). `STALWART_PUBLIC_URL` is now overridable in `docker-compose.yml` (default unchanged).

*A plain-http LAN origin is an insecure context,* so `crypto.subtle` is undefined. That kills
OAuth (oauth4webapi's `calculatePKCECodeChallenge` → `subtle.digest`) and every `SecretStore`
persistence path (AES-GCM). Basic sign-in uses only `btoa` and works. The demo therefore
disables the OAuth button with an accessible explanation and guards `AuthController.restore()`
so an insecure origin cannot throw on boot; the `pnpm demo` banner says so plainly. Serving the
LAN origin over HTTPS (mkcert) would restore OAuth — deliberately not built for a throwaway page.

*Blob downloads need the `Authorization` header* (`?access_token=`/`?oauth_token=` → 401), so
attachments and inline images must go through `client.download()` → `URL.createObjectURL` →
`blob:` URL. `<img src=downloadUrl>` and `<a href=downloadUrl download>` cannot work. This
constrains M1.7's inline-image handling.

*Body values are per-part.* Stalwart lists a text-only mail's `text/plain` part in **both**
`textBody` and `htmlBody` (the RFC 8621 fallback), so "does this mail have HTML?" must be
decided from a genuine `text/html` part, not from `htmlBody` being non-empty — otherwise plain
mail renders inside the iframe. `Email/parse` needs `bodyValues` listed in `properties`;
`fetchTextBodyValues` alone only fills the values of a property you also asked for.

### SP.5 — Spike report, ADRs, validation checklist

Size: S. Deliverable: `docs/adr/` entries + a findings section appended to this plan (§13
notes or new ADRs), answering **each** of:

- [x] CORS: exact behavior of cross-origin JMAP calls against Stalwart with/without
      `usePermissiveCors` (FR-DEP-05 docs input). **Answered (SP.3):** Stalwart v0.16.11 with
      default config emits **no** `Access-Control-Allow-*` headers on any route (`/jmap/`,
      `/jmap/eventsource/`, `/jmap/ws`, `/jmap/session`, `/auth/token`) — OPTIONS preflight →
      204 with zero CORS headers; actual responses carry no ACAO. Cross-origin browser access
      (including the fetch-based SSE reader) is therefore **blocked by default**; a
      cross-origin static Waxwing needs Stalwart `usePermissiveCors`, a same-origin
      Applications mount (FR-DEP-02), or a CORS-adding reverse proxy — matching the FR-DEP-05
      trade-off. (Only the default `usePermissiveCors:false` case was probed; the permissive
      case is not re-tested here.)
- [x] `Email/parse`: supported by Stalwart v0.16? (decides whether `postal-mime` fallback
      is needed for FR-RD-07). **Answered (SP.4) — yes.** Verified live end-to-end and from the
      demo UI: upload an `.eml`, attach it via `Email/set`, read the sub-part `blobId`, call
      `Email/parse` → `parsed[blobId]` carries `subject`/`from`/`textBody`/`bodyValues`/
      `preview`; no `unknownMethod`, empty `notParsable`/`notFound`. So **no `postal-mime`
      fallback is needed for server-held blobs** (FR-RD-07). It would still be required to parse
      a `.eml` the user picks from their local disk, which never reaches the server. Caveat:
      `bodyValues` must be named in `properties` — `fetchTextBodyValues:true` alone returns an
      empty body (RFC 8620 §5.1 property filtering).
- [ ] WebSocket RFC 8887: works as specced? Push over WS reliable? (decides D2.)
      **Evidence recorded (SP.3) — D2 stays open for Heiko at G1:** JMAP-over-WebSocket works
      exactly as specced **server-side/Node** — `urn:ietf:params:jmap:websocket` advertised
      (`{url: ws://…/jmap/ws, supportsPush:true}`), `Authorization` header (Bearer/Basic) on
      the Upgrade → 101, full `Request`/`Response` round-trip (echoes `requestId` +
      `sessionState`), `WebSocketPushEnable` + `StateChange` verified, ~2–5 ms latency,
      `dataTypes` filtering honored, survives `docker restart`. **But not browser-viable
      against Stalwart v0.16.11:** the only accepted auth is the `Authorization` header, which
      browsers cannot set on a `WebSocket`; Stalwart accepts no `?access_token=`/`?token=`
      (→401) and no token-in-subprotocol (→401), so a browser cannot open an authenticated WS
      at all. Net: WS push is reliable as a Node/server-side transport but blocked in the
      browser today — V1-core browser WS would require a Stalwart change adding a
      browser-viable WS auth path. Decision D2 is Heiko's at G1 (not decided here).
- [x] EventSource auth mechanism (see SP.3). **Answered (SP.3):** Stalwart's `eventSourceUrl`
      authenticates **only** via the HTTP `Authorization` header (Bearer or Basic);
      `?access_token=`/`?token=` query params → 401, no session cookie exists (`/login` and
      `/api/auth` set none) → cookie auth impossible, no-auth → 401. The native `EventSource`
      DOM API cannot set request headers, so it can **never** authenticate against Stalwart →
      Waxwing implements SSE as a **fetch-based reader** (`fetch` + `ReadableStream`) sending
      `Authorization: Bearer <token>` (**ADR-005**). Verified live: Bearer and Basic → 200
      `text/event-stream`; `?access_token=` → 401. Resumption: Stalwart emits no SSE `id:` and
      ignores `Last-Event-ID`, so reconnect must re-sync via `*/changes` (informs M1.3).
- [x] `Email/queryChanges`: supported/reliable, or `cannotCalculateChanges` common?
      (shapes M1.3's sync strategy.) **Answered (SP.4) — supported, with a caveat worth
      designing against.** `Email/query` reports `canCalculateChanges:true`, and
      `Email/queryChanges` returns normally. In the one adversarial case probed, a **bogus
      `sinceQueryState` did not produce `cannotCalculateChanges`** — the server answered "ok, no
      changes". If that generalises, a client that trusts a stale or corrupted query state would
      silently believe it is up to date. M1.3 must therefore not treat the absence of
      `cannotCalculateChanges` as proof of freshness, and should re-probe this deliberately (it
      was a single observation, not a systematic test).
- [x] SearchSnippet support (shapes M3.1). **Answered (SP.4) — supported.** `SearchSnippet/get`
      returns per-email `subject`/`preview` with the matched terms wrapped in `<mark>` (so M3.1
      must treat the snippet as *server-produced markup* and sanitise it, not trust it).
- [x] OIDC: client registration needs, refresh-token lifetimes, revocation endpoint.
      **Answered (SP.5) — live against v0.16.11.** No pre-registration needed (the arbitrary
      `client_id` `waxwing` is accepted). RFC 7591 `/auth/register` exists and is **open
      (unauthenticated → 201)**, but it rejects `http://localhost:5173/` /
      `http://127.0.0.1:5173/` redirect URIs (only bare-`127.0.0.1`/`[::1]`/https/custom-scheme
      pass). Access token `expires_in=3600`, **opaque** (`sw1.` prefix, not a JWT); refresh
      token 30 d, **not rotated on use, reusable, and `client_id` is not checked on refresh**;
      **no `revocation_endpoint` and no `end_session_endpoint`** in either discovery doc, and
      `/auth/revoke` → 404. → **ADR-006.** Confirms the existing client (`oauth.ts` `revokeToken`
      already no-ops when unadvertised; logout wipes locally). See §SP.5 findings (a).
- [x] Session limits actually reported by Stalwart (informs chunking defaults).
      **Answered (SP.5).** core: `maxObjectsInGet/Set=500`, `maxCallsInRequest=16`,
      `maxSizeRequest=10 MB`, `maxSizeUpload=50 MB`, `maxConcurrent{Requests,Upload}=4` — all
      four chunking fields present as **positive** numbers, so `@waxwing/jmap`'s `FALLBACK_LIMITS`
      (128/128/16/1 MB) never engage and the `maxObjectsInSet:0` split-loop is unreachable here.
      Mail limits live in **`accountCapabilities`** (top-level `mail` is `{}`):
      `emailQuerySortOptions` = 9 values (receivedAt/size/from/to/subject/sentAt + 3 keyword) →
      shapes M3.1 sort UI; `maxMailboxDepth=10`. See §SP.5 findings (b).
- [x] Blob upload quirks (size caps, content-type handling).
      **Answered (SP.5).** Content-Type is **echoed verbatim, never sniffed**; `blobId` is
      **content-addressed** (type is metadata on the reference). **Two** size gates: a single
      upload > `maxSizeUpload` → **HTTP 400** `urn:ietf:params:jmap:error:limit`
      (`application/problem+json`; **RFC 8620 §6.1 mandates 413 — Stalwart deviates**), *and* an
      **undocumented per-user cumulative quota (1000 files / 50 MB)** → **HTTP 429** with
      `Retry-After` (~1 h), advertised **nowhere** in the session. Download authenticates by the
      `Authorization` header only (`?access_token=`→401), and `?accept=<type>` sets the response
      Content-Type unvalidated (always `Content-Disposition: attachment`). RFC 9404 `Blob/upload`
      is available. See §SP.5 findings (c).
- [x] Stalwart Applications mount: build a throwaway zip of the P0.2 shell, mount it,
      verify `<base href>` rewriting + relative assets under `/mail` (FR-DEP-02).
      **Answered (SP.5) — mechanism live-verified, one build gap found.** Confirmed against the
      real image using Stalwart's own bundled app at `/admin/`: it ships `<base href="/">` and
      serves it **rewritten to `<base href="/admin/">`** on the index *and every deep route*,
      with relative `./assets/*` resolving under the prefix (JS `application/javascript`, CSS
      `text/css`, `immutable`), single-segment `/seg`→302→`/seg/`, and an unconditional SPA
      fallback (deep route **and** missing asset → 200 `text/html`). **Gap:** Waxwing's built
      `apps/web/dist/index.html` emits **no** `<base href="/">` tag (source has none either),
      so the rewrite would not fire and deep-links would break — `base:'./'` is already set, so
      the *only* missing piece is emitting the literal tag → **M4.9 checklist item.** See §SP.5
      findings (d).
- [x] Sharing capability (`urn:ietf:params:jmap:principals` / Stalwart sharing) present?
      (feeds M4.4 planning.) **Answered (SP.5) — yes, but no delegation seeded.** The fixture
      advertises `urn:ietf:params:jmap:principals` (+ `:availability`) and
      `urn:ietf:params:jmap:mail:share` (draft-ietf-jmap-mail-sharing), and every mailbox's
      `myRights` already carries `mayShare`. `principals:owner` (RFC 9670) is **absent**. But
      alice's `session.accounts` holds only her own account → **M4.4 must provision a delegation
      in the fixture first**. Consuming shared trees needs only RFC 8620 `accounts` + RFC 8621
      `myRights` (both present); principals/`mail:share` matter only for in-app sharing *config*
      (out of M4.4 scope). Note: `packages/jmap/src/capabilities.ts:26` mislabels the URN as
      "RFC 8620 §8" — it is **RFC 9670** (fix during M4.4). See §SP.5 findings (e).

**SP.5 findings** (live against Stalwart **v0.16.11-alpine**, fixture accounts; probes and
their negatives recorded so a re-run can falsify them). D2 (browser WebSocket) evidence stays
in SP.3/ADR-005 — **left open for Heiko at G1, not decided here.**

**(a) OIDC / tokens → ADR-006.** Both `/.well-known/openid-configuration` and
`/.well-known/oauth-authorization-server` are served. Advertised: `authorization_endpoint=/login`,
`token_endpoint=/auth/token`, `registration_endpoint=/auth/register`,
`introspection_endpoint=/auth/introspect`, `device_authorization_endpoint=/auth/device`;
`grant_types` = code / refresh_token / device_code; `code_challenge_methods=["S256"]` only;
`token_endpoint_auth_methods` includes `none`; `authorization_response_iss_parameter_supported=true`.
**No `revocation_endpoint`, no `end_session_endpoint`** (adversarial `POST /auth/revoke`,
`/auth/revocation`, `/oauth/revoke` → 404). Dynamic client registration is **open** (no auth →
201) but restricts redirect URIs to https / custom-scheme / bare-loopback (`http://127.0.0.1/`,
`http://[::1]/`) — a `:5173` loopback port is **rejected** (contrast RFC 8252 §7.3, which asks
servers to allow any loopback port; Waxwing sidesteps this by not registering). A minted access
token is **opaque** (`sw1.…`, tail is base64 of the username), `expires_in=3600`. Refresh:
`client_id=waxwing` accepted; the refresh response carries **no** new `refresh_token` (source
default: rotate only within 4 d of the 30 d expiry), the same refresh token **works repeatedly**,
and a **wrong or missing `client_id` still succeeds** → a refresh token is a long-lived,
non-rotating, server-**non-revocable** bearer-equivalent whose only protection is Waxwing's
encrypted-at-rest store (NFR-SEC-02) + local-wipe logout. Stalwart also returns an unsolicited
ES256 `id_token` (already stripped, `oauth.ts`).

**(b) Session limits.** core = `{maxCallsInRequest:16, maxConcurrentRequests:4,
maxConcurrentUpload:4, maxObjectsInGet:500, maxObjectsInSet:500, maxSizeRequest:10000000,
maxSizeUpload:50000000, collationAlgorithms:[i;ascii-numeric, i;ascii-casemap,
i;unicode-casemap]}`. All four chunking inputs are present positive numbers → resolveLimits uses
the server values, not `FALLBACK_LIMITS`. Mail limits are only in `accountCapabilities`
(`maxMailboxDepth:10`, `maxMailboxesPerEmail:null`, `maxSizeMailboxName:255`,
`maxSizeAttachmentsPerEmail:50000000`, `mayCreateTopLevelMailbox:true`, the 9 `emailQuerySortOptions`).

**(c) Blob.** Upload echoes the client Content-Type unmodified (PNG bytes sent as `text/plain`
→ `type:"text/plain"`; `nonsense/not-a-type` echoed; none → `application/octet-stream`); the
`blobId` is identical across types (content-addressed). Oversize single upload → **400**
`urn:ietf:params:jmap:error:limit` (`limit:"maxSizeUpload"`, `application/problem+json` → surfaces
as a typed `JmapProblemError`, **not** the RFC-mandated 413). Cumulative quota (1000 files / 50 MB
per authenticated user, **not** in the session doc) → **429** `application/problem+json` +
`Retry-After` + `RateLimit-Policy: "blob-upload-files";q=1000, "blob-upload-bytes";q=50000000` — a
single 50 MB attachment exhausts it for ~1 h (compose/attachment UX must handle 429). The upload
URL's `{accountId}` is **not** authorization-checked (alice can POST into bob's account, which she
otherwise cannot read/act on — a server-side write gap, dev-fixture only, not Waxwing's to fix).
Download: `Authorization` header only (`?access_token=`/`?oauth_token=`/no-auth → 401), always
`Content-Disposition: attachment`, and `?accept=<type>` reflected unvalidated (`text/html`,
`nonsense/x`) → **inline attachments must be fetched-with-header → `blob:` URL** (ratifies SP.4).
RFC 9404 `Blob/upload` (`data:asText`) works and hits the same quota.

**(d) Applications mount (FR-DEP-02).** Live-verified on the built image via Stalwart's Portal at
`/admin/` (a real Application mount): `<base href="/">`→`<base href="/admin/">` rewrite fires on
`GET /admin/` **and** on `GET /admin/some/deep/route` (so relative assets survive deep-link
reloads); `GET /admin/assets/<hash>.js` → 200 `application/javascript` `immutable`, `.css` →
`text/css`; bare `GET /admin` → 302 `/admin/`; SPA fallback returns index (`200 text/html`,
`no-cache`) for both a router path and a genuinely missing asset. v0.16 has **no TOML** for this —
an Application is a datastore/registry object created over JMAP (`POST /jmap/` method
`x:Application/set`, recovery-admin Basic suffices; `{enabled, resourceUrl (zip URL, `http://`
ok), urlPrefix (object `{"mail":true}`, single segment), autoUpdateFrequency, unpackDirectory}` —
full recipe in §M4.9); the MIME table is small (`.webmanifest`/`.woff2` →
`application/octet-stream`, a FR-DEP-06/PWA note). **Build gap:**
`apps/web/dist/index.html` has no `<base href="/">` → M4.9 must emit it (see §M4.9).

**(e) Sharing.** Advertised (accountCapabilities): `urn:ietf:params:jmap:principals`
(`currentUserPrincipalId`), `:availability`, `urn:ietf:params:jmap:mail:share`; every `Mailbox`
`myRights` includes `mayShare`. **Absent:** `urn:ietf:params:jmap:principals:owner`. No delegation
is seeded (alice sees only her own personal account) → a fixture delegation is prerequisite work
for M4.4. JMAP Sharing is **RFC 9670** (Nov 2024, Updates RFC 8620), not "RFC 8620 §8" — fix the
stale comment in `packages/jmap/src/capabilities.ts:26` during M4.4.

**Gate G1:** owner reviews the report; decisions D2 (WebSocket in V1 core?) and any plan
adjustments are recorded; M1 unblocks.

**Phase 1 exit criteria:** SP.5 checklist fully answered; G1 passed; `@waxwing/jmap`
core + auth are merged, tested foundations (not throwaway).

---

## 7. Phase 2 — M1 "Read"

Goal: Waxwing becomes a read-only mail client you'd actually leave open: local-first
replica, live folder tree, fast list, safe reading. This phase builds the architectural
spine (replica + sync + action queue) that every later phase leans on.

### M1.1 — Design system foundation

Spec: FR-UI-01/02, FR-A11Y-01, FR-THEME-01. Size: L.

- [x] Write `docs/design-system.md`: principles (Apple-HIG-inspired, calm, content-first),
      token catalog, spacing/typography scales, motion rules (`prefers-reduced-motion`),
      component inventory. (The spec references this as a separate document — this WP
      creates it.)
- [x] Complete the token sets from P0.2 for both themes; contrast-check every token pair
      (WCAG AA) and record results in the doc. — `tokens.contrast.test.ts` parses the
      shipped `tokens.css` and asserts 21 pairs × 2 themes = 42 assertions; added
      `--waxwing-border-strong`, `--waxwing-{danger,success,warning}-contrast`, and
      elevation tokens to close the gaps the audit surfaced.
- [x] Base components in `src/ui/`: Button, IconButton, TextInput, Select, Checkbox/Switch,
      Menu (roving focus), Dialog (focus trap), Tooltip, Toast/Snackbar, Avatar (initials),
      Badge, SplitPane, VisuallyHidden, Spinner/Skeleton. — all present; barrel `index.ts`;
      shared primitives (Portal, useFocusTrap, useDismiss) in `src/ui/internal/`.
- [x] Every component: keyboard support, ARIA per APG pattern, axe test, both themes. —
      96 co-located jsdom+axe tests pass; contrast/theme rendering covered by the browser
      gallery scan.
- [x] 44-px minimum touch targets baked into tokens/components (FR-A11Y-01). —
      `--waxwing-control-min` applied to every interactive control — responsive: 34px on
      pointer (≥ WCAG 2.2 AA SC 2.5.8's 24px), 44px on touch (SC 2.5.5).

Done when: a component gallery dev page shows all base components in light/dark, and axe
reports zero violations on it. — **Met.** Dev-only gallery (`VITE_WAXWING_GALLERY=1`,
DCE'd from prod); a real-Chromium axe scan (WCAG 2.x A/AA incl. `color-contrast`) over it
reported **zero violations in light and dark**, including the open Dialog/Menu/Toast.

### M1.2 — Local replica schema

Spec: FR-OFF-02 (basis), FR-AUTH-07 (account-scoping), tech-stack §4.3. Size: M.

- [x] Dexie 4 schema in `src/sync/db.ts`. Tables (all keyed `[accountId+id]` — account
      scoping is non-negotiable from day one): `accounts`, `mailboxes`, `threads`,
      `emails` (index/envelope fields: mailboxIds, keywords, from/to, subject,
      receivedAt, preview, hasAttachment, size), `emailBodies` (fetched bodies + body
      structure, separate table so the index stays lean), `blobsMeta`, `syncState`
      (per account+objectType: JMAP state string), `queryCache` (canonical query key →
      ids, queryState, upToId), `outbox`, `localPrefs`. — All ten shipped; `accounts` is
      keyed by the bare id (it *is* the scope). Folder/keyword membership indexed via derived
      account-scoped multiEntry arrays `amb`/`akw` (IndexedDB has no compound-multiEntry). **One
      shared DB, not per-account — ADR-008** (the replica holds no secrets, so ADR-004's per-DB
      crypto isolation does not transfer).
- [x] Canonical serialization for query keys (filter+sort normalized). — `query-key.ts`:
      order-independent filter keys + boolean-operator conditions; explicit `isAscending` default;
      `collapseThreads` in the key; sort-comparator order preserved.
- [x] Migration strategy documented (Dexie `version()` chain; never destructive). — Append-only
      version chain policy in the `db.ts` header + ADR-008 (cache may bump the DB name as a last
      resort).
- [x] `dexie-react-hooks` `useLiveQuery` wrappers with account context. — `react.tsx`:
      `ReplicaProvider` (fixes `accountId`) + `useMailboxes`/`useMailbox`/`useMailboxByRole`/
      `useEmail`/`useEmailWindow`/`useQueryWindow`/`useLocalPref`.
- [x] Unit tests on `fake-indexeddb`: schema round-trips, index queries used by the list. — 29
      tests (jsdom "web" project): schema/round-trips, account isolation + `clearAccount`, the
      M1.5/M1.6 query shapes, LRU touch-on-read, canonical-key equivalence/uniqueness, live hook
      reactivity.
- [ ] **(M1.3 follow-up)** Wire `wipeReplica` into the "Sign out & remove data" path (FR-AUTH-05)
      once the sync engine populates the replica; derive a stable account id (issuer + username) for
      the switcher when FR-AUTH-07 is scheduled.

Done when: replica CRUD + the exact queries M1.5/M1.6 need are tested and fast (indexed,
no full-table scans). ✅ **2026-07-10.** All queries served by a declared index (role lookup,
membership `amb`, threading `[accountId+threadId]`, window hydration by compound PK, mailbox counts
straight off the mailbox row — no scans over `emails`). `pnpm verify` green: typecheck strict, Biome
clean, **430 tests** (+29), size **105.5 KB gz** (Dexie is tree-shaken until M1.5/M1.6 import the
replica; projected entry delta **≈ +31 KB gz** → ~136 KB, well under the 300 KB budget). **ADR-008**
records the shared-DB account-scoping decision. Adversarial review applied.

### M1.3 — Sync engine core + action queue skeleton

Spec: FR-NOTIF-01, FR-OFF-03 (skeleton), tech-stack §4.3. Size: L.

- [x] **Leader election** via `navigator.locks.request('waxwing-sync', …)`; followers
      detect leader loss and re-elect; `BroadcastChannel` for engine status/events
      (replica reactivity itself comes free via Dexie liveQuery cross-tab). — `engine/leader.ts`
      (holds the exclusive lock for the tab's life; release = re-election) + `engine/bus.ts`
      (`EngineBus` carries only the leader's status; followers mirror it).
- [x] Push integration: transport auto-select from SP.3 (per G1/D2 decision), `StateChange`
      → targeted delta fetch; **polling fallback** implementation. — engine subscribes
      `createPushChannel` (SSE-first per D2); every `StateChange` runs a coalesced delta sweep.
      **Real polling transport** now lands in `@waxwing/jmap` (`push/polling.ts`: session-state
      polling → coarse resync `StateChange`), replacing the SP.3 stub; wired into the failover facade.
- [x] Delta sync: `Mailbox/changes`, `Thread/changes`, `Email/changes` (with
      `updatedProperties` optimization); per-watched-query `Email/queryChanges`; recovery
      path on `cannotCalculateChanges` → full re-query + reconciliation. — `engine/delta.ts`
      (multi-page `drainChanges`, Mailbox partial-prop patch, removed-then-index-splice-added
      reconciliation, `CannotCalculateChangesError` → `fullRequery`). SP.4 "absence ≠ freshness":
      the engine periodically forces a full re-query (`forceFull` every Nth safety sweep).
- [x] Windowed backfill: recent N days/messages per mailbox (default from `config.json`
      `offline.cacheDays`), oldest-window bookkeeping for "load more". — `engine/backfill.ts`
      (`windowFilter` = `inMailbox AND after=now−cacheDays`; `backfillMailbox`/`loadMore` page by
      `position`; the window key is stable — spec read back from the persisted `QueryCacheRow`).
- [x] **Action queue (outbox) skeleton** … optimistic local apply → replay → confirm/rollback;
      `ifInState`. M1 scope: online replay + basic retry. — `engine/outbox.ts`
      (`applyOptimistic` returns a rollback closure; `replayOutbox` FIFO, per-object rejection →
      rollback+`error`, transport error → `pending`+attempts, `maxAttempts` guard; mailbox-create
      reconciles the server id). Offline hardening + conflict UX stay **M3.3**.
- [x] Actions implemented now: setKeywords (read/unread, flag), move (archive, junk,
      trash, arbitrary), delete (trash → destroy), mailbox create/rename/move/delete. — the
      `OutboxIntent` union covers all of these.
- [x] Engine state surface for UI: syncing/offline/error, per-mailbox freshness. — `engine/status.ts`
      external store + `useEngineStatus`; `StatusRegion` now surfaces offline/error (live region) +
      a non-announced syncing spinner. (Per-mailbox freshness derivable from `SyncStateRow.updatedAt`;
      the list will surface it in M1.6.)
- [x] Unit tests: state-string bookkeeping, queryChanges reconciliation,
      cannotCalculateChanges recovery, optimistic apply/rollback, leader failover. — 35 hermetic
      engine tests (leader failover via a fake lock queue; delta/queryChanges/recovery; outbox
      apply/replay/rollback; port mapping; backfill; facade start→sync→dispatch→stop).
- [ ] **(M1.9)** Live two-tab consistency + leader hand-over + offline-replay verification against
      the fixture — deferred to M1.9's live E2E suite (as M1.4's live shell E2E was). The mechanics
      are hermetically covered here.

Done when: two open tabs stay consistent while mail is delivered to the fixture; killing
the leader tab hands over within seconds; a flag toggled offline-simulated (devtools)
replays on reconnect. — **Mechanics hermetically met** (fake lock/push/port/clock): leader
failover, StateChange→sync, optimistic dispatch→replay, coalesced re-entrant sync, teardown.
The **live browser** two-tab/offline verification runs with **M1.9** (needs the Stalwart fixture +
Playwright, out of a jsdom unit's reach). `wipeReplica` is now wired into "Sign out & remove data".

### M1.4 — App shell

Spec: FR-UI-03, FR-AUTH-01/02/05/06, FR-THEME-02, FR-DEP-04. Size: L.

- [x] Routing (hash-free, base-path-safe): `/mail/:mailboxId?/:emailId?`, `/contacts`,
      `/settings/*`; lazy route chunks (NFR-PERF-03). **Own ~70-line History-API router**
      (`app/route/`, **ADR-007**) — base from the `<base href>` element (not `document.baseURI`,
      which without a `<base>` returns the current URL and would swallow a deep link). `/contacts`
      + `/settings` are lazy chunks; `.size-limit.js` now measures the entry chunk.
- [x] Responsive layout: three-pane desktop / two-pane tablet / single-pane phone with
      back navigation (FR-UI-03); reading-pane modes right/bottom/off (FR-LST-07 layout half).
      Hybrid CSS-media-query presentation + one JS `split` decision (`computePaneLayout`); folder
      off-canvas drawer on narrow; SplitPane for the desktop divider; reading opens via history
      PUSH so Back works. Reading-pane mode is a localStorage pref set in Settings.
- [x] Onboarding: same-origin autoconnect (FR-AUTH-01, probe → login-only); manual connect flow
      with email→domain `/.well-known/jmap` discovery and `config.json` pinning (FR-AUTH-02);
      login via OAuth redirect or Basic form per `config.server.auth`. Explicit FSM in a tested
      reducer; `ConnectTarget` reconciles connect-URL vs OAuth issuer.
- [x] Session UX: re-auth prompt on expiry without losing state (FR-AUTH-06 — overlay Dialog
      over the still-mounted shell; silent refresh handles the common case with no UI; Basic
      reconnects in place, OAuth stashes route+target then redirects); "Sign out" vs "Sign out &
      remove data" (FR-AUTH-05, destructive confirm). Hard boot-once guard for StrictMode + the
      single-use PKCE transaction.
- [x] Branding applied from config: product name, logo (resolved vs `<base>`), accent (M1.1
      `applyBranding`), links imprint/privacy/support (FR-THEME-02 — `BrandLinks` on the
      onboarding footer + Settings). No user-visible "Waxwing" hardcoded (guard test).
- [x] Offline indicator + engine status in the chrome (`StatusRegion`, `role=status` live
      region; surfaces `navigator.onLine` now — the M1.3 sync engine fills the sync-status seam).

Done when: install → onboard → login → empty three-pane shell works on desktop and phone
viewport, branded via a test `config.json`.
✅ **2026-07-10.** Verified hermetically end-to-end: 401 web/unit/axe tests (onboarding
autoconnect/manual/OAuth-unavailable, Basic login + connect-error, restore, OAuth callback,
re-auth-without-unmount, sign-out variants, responsive single-pane back-nav, branding + no-brand
guard, i18n en/de parity, router matcher/base-path, pure session reducer). Real-browser axe scan
of the login surface **clean in light + dark** (0 violations, tokens verified). Build **105 KB gz**
entry chunk (budget 300); `/contacts` + `/settings` split into on-demand chunks. Typecheck + Biome
clean. Follow-ups: engine sync-status is a stub until M1.3; folder-drawer focus polish and the
LIVE `connect()`→shell E2E land with **M1.9**; `<base href="/">` in `index.html` is **M4.9** (SP.5).

### M1.5 — Folder tree

Spec: FR-MBX-01/02/04. Size: M.

- [x] Tree from replica via liveQuery; role mailboxes (`inbox`, `drafts`, `sent`, `junk`,
      `trash`, `archive`) pinned, localized, iconographic; custom folders below, sorted
      per `sortOrder`/name. — `mail/folder-tree.ts` (`buildFolderTree`, roles pinned in
      `PINNED_ROLES` order, children by `parentId`, orphan/cycle-safe) + `FolderTreeView`
      (APG `role="tree"`, role icons, localized role names via `folderDisplayName`).
- [x] Live unread badges (push-updated). — `unreadEmails` `Badge` + a `VisuallyHidden`
      "{{count}} unread" SR label, live via liveQuery (engine push → replica → re-render).
- [x] Manage: create, rename, move, delete with non-empty confirmation; honor `myRights`
      (`mayCreateChild`, `mayRename`, `mayDelete`, …) per mailbox (FR-MBX-02). — per-folder
      `Menu` gated by `myRights` (item omitted when not permitted, whole Menu omitted when no
      action allowed); create/rename `Dialog`s (name required / ≤255 / no duplicate sibling);
      delete confirm uses the non-empty message when `totalEmails > 0`. Actions dispatch
      `createMailbox`/`renameMailbox`/`moveMailbox`/`deleteMailbox` intents through the engine
      (`useFolderActions`, client ids via `crypto.randomUUID`).
- [x] Collapsible state + per-folder prefs persisted locally (FR-MBX-04). — collapse set in
      `localPrefs` (`folders.collapsed`) via `useLocalPref`/`setPref`.

Done when: folder CRUD round-trips against the fixture; a second client's changes appear
live; rights violations are prevented in UI, not just server-rejected. — **UI + local logic
met hermetically** (rights-gating, validation, optimistic dispatch, live badges via liveQuery,
tree a11y + keyboard). The **live** fixture round-trip + second-client E2E lands with **M1.9**
(as M1.4's live shell E2E did).

### M1.6 — Message list

Spec: FR-LST-01/02/03/04/05/07, FR-ORG-01 (flows). Size: L.

- [x] TanStack Virtual list bound to `queryCache` windows; sustained 60 fps target with
      100 k-message fixture mailbox (generate via seeding script — add one to e2e/). — `MessageList`
      virtualizes over the window `ids` and hydrates only the visible slice (`useEmailWindow`); the
      window is registered via a new `SyncEngine.watchWindow(mailbox, {sort, collapseThreads})` seam
      (`use-message-list.ts`). Seeding script `e2e/stalwart/seed-large.mjs` (`pnpm seed:large`, chunked
      `Email/set`). The live 60 fps measurement runs with **M1.9/M4.8**.
- [x] Threading via `Thread` objects; flat-view toggle (FR-LST-02). — a flat/threaded toggle registers
      a separate watched query (`collapseThreads` false/true → distinct key). Inline thread expansion
      is the conversation view (M1.8).
- [x] Row: sender, subject, server preview, relative localized time, unread/flagged/attachment/answered
      indicators, initials avatar (FR-LST-03 — never remote images). — `MessageRow` + `Avatar`
      (initials) + `formatMessageTime` (relative→weekday→date); each indicator carries a `VisuallyHidden`
      label.
- [x] Selection model: click, shift/ctrl ranges, select-all-in-folder (id-set on the query, not just
      loaded rows); bulk actions bar → action queue (FR-LST-04, FR-ORG-01). — pure `message-selection.ts`
      reducer + a `BulkBar` (read/unread, flag, archive, junk, trash, delete) dispatching over the whole
      selected id-set via `useMessageActions` → outbox (archive/junk/trash resolved via `useMailboxByRole`).
- [x] Sorting: date/from/subject/size + unread-first toggle (FR-LST-05) — each sort is its own watched
      query. — `MessageSort` presets; unread-first prepends a `hasKeyword $seen` comparator; each is a
      distinct `windowQueryKey`.
- [x] Density comfortable/compact (FR-LST-07). — a density Select, persisted locally.
- [x] Infinite scroll = backfill trigger ("load more" into the window). — the virtualizer triggers
      `loadMore` (→ `engine.loadMoreFor`) near the window end while `ids.length < total`.
- [ ] **(M1.5 follow-up)** After an optimistic folder create, the route/selection points at the
      temp mailbox id; when the engine swaps it for the server id (`reconcileCreate`), surface that
      mapping and re-navigate off the temp id so the new folder stays selected (the a11y tab-stop
      part is already handled in M1.5).

Done when: the 100 k seeded mailbox scrolls smoothly (measured, recorded in WP notes),
bulk-move of 500 messages works optimistically and syncs.

### M1.7 — `@waxwing/mail-html` package

Spec: FR-RD-01/02/03, NFR-SEC-01, tech-stack §4.5. Size: L.

- [x] Sanitizer pipeline: DOMPurify with hooks that (a) strip script-bearing anything,
      (b) rewrite/strip `src`/`srcset`/`style url()` for **remote-content blocking**
      with a collected manifest of blocked resources, (c) rewrite `cid:` to JMAP blob
      download URLs, (d) enable DOM-clobbering protections; returns
      `{ html, blockedRemote: […], hasRemoteContent }`. — `sanitize.ts`: hardened DOMPurify
      (SVG/MathML excluded via `USE_PROFILES{html:true}`, `base/meta/object/embed/iframe/form/link/
      style/noscript/template` forbidden, `SANITIZE_DOM`+`SANITIZE_NAMED_PROPS`) + a
      `uponSanitizeAttribute` remote-firewall (per-call manifest, no global state). `cid:` is
      resolved by a **caller-supplied `resolveCid`** (the app does `client.download`→`blob:`; the
      package never imports jmap, per SP.4's Authorization-header constraint).
- [x] Iframe renderer: `srcdoc` + `sandbox` … own minimal CSP via `<meta>` … auto-height via
      ResizeObserver …; dark-mode strategy (conservative: light background, documented). —
      `frame.ts`: `buildFrameDocument` (inner `default-src 'none'; script-src 'none'; img-src blob:
      data:` CSP + light reset) + `mountMailFrame`. **Deliberate stricter posture (documented):**
      `sandbox="allow-same-origin"` **without** `allow-scripts`, so the outer page measures height
      (ResizeObserver) and intercepts links with **zero script executing in the frame** — safer than
      the `postMessage` auto-height the plan sketched, which would require `allow-scripts`.
- [x] Link handling: clicks intercepted inside the frame, re-dispatched to the app, opened
      `noopener noreferrer` with **visible target host** (FR-RD-08 groundwork). — `mountMailFrame`
      intercepts anchor clicks → `onLink(href)` callback (the app opens noopener + shows the host).
- [x] Plain-text renderer: linkification + quoted-text folding (`>` levels) (FR-RD-01). — `text.ts`:
      escape → `http(s)`-only linkify → native `<details>`/`<blockquote>` folding (script-free).
- [x] "Load remote content" mode: second sanitize pass allowing http(s) images. — `sanitize`'s
      `allowRemote` flag keeps remote images; per-message/per-sender allowlist policy stays in the app.
- [x] Adversarial test suite: XSS corpus (script, event handlers, `javascript:`, svg, CSS
      exfiltration, meta refresh, form action, DOM clobbering, `<base>` injection), remote-content
      leak tests. — `sanitize.test.ts` (12-case corpus + a "no remote URL survives" zero-network
      proxy). Hardened further by an adversarial **security review** (below).

Done when: the corpus passes; **zero network requests** occur rendering a hostile mail with remote
content blocked. — Corpus green; the zero-network guarantee is asserted hermetically (no `http(s)`
URL survives a hostile mail with `allowRemote:false`). A real-browser network-spy E2E is folded into
**M1.9/M4.7** (jsdom cannot fetch; the string-level guarantee is the unit-testable equivalent).

### M1.8 — Reading experience

Spec: FR-RD-03/04/05, FR-OFF-02 (opened bodies). Size: L.

- [x] Message view composing `mail-html` output; on-open body fetch → `emailBodies`
      (cached forever until LRU, FR-OFF-02).
- [x] Remote-content banner: load-once, per-sender "always allow" list in `localPrefs`
      (FR-RD-02) with privacy explanation.
- [x] Conversation view: thread messages, older collapsed, expand-on-demand (reversible),
      quoted-text folding inside each (FR-RD-04); missing thread-member envelopes hydrated
      on demand.
- [x] Attachments: list with type icons + sizes; download; inline preview for images and
      PDF (`<img>` / sandboxed `<iframe>` outside the mail frame); save-all (FR-RD-03).
- [x] Action bar + context menus: reply/reply-all/forward (stubs → toast until M2), archive,
      delete (confirm before permanent purge), junk/not-junk, move (folder picker), flag,
      mark unread (FR-RD-05).
- [x] Print stylesheet: clean single-message print, app chrome stripped (FR-RD-05).
- [x] Unread handling: auto-mark-read on open (only the opened message, not auto-expanded
      siblings; configurable delay later in settings).

Done when: an HTML newsletter, a plain-text mail, and a threaded conversation from the
fixture all read correctly, offline-reopenable after first open.

### M1.9 — Live updates end-to-end + E2E read suite

Spec: FR-NOTIF-01, NFR-QUAL-01. Size: M.

- [x] Wire push → sync → liveQuery: a live delivery surfaces in the list without a refresh.
      (Browser push can't authenticate with Basic auth — no `Authorization` on a WS/SSE
      handshake — so the delivery arrives via the engine's safety-sweep poll; the user-visible
      auto-refresh guarantee holds. Instant-push (OAuth Bearer + SSE) is a follow-up.)
- [x] Playwright suite "read": login (OAuth + Basic), folder navigation, open/read/flag/
      move/delete (trash), live-update assertion (delivered via JMAP `Email/set` — the P0.4
      fixture maps no SMTP port), two-tab consistency (cross-tab liveQuery).
- [x] Perf smoke: recorded on the seeded mailbox — cached message open ≈ 75 ms (< 100 ms
      NFR-PERF-02), folder switch ≈ 100 ms (< 200 ms). Method: `Date.now()` around click →
      assertion-visible in the live suite; lenient CI bounds, numbers logged.

Done when: suite green in CI; M1 demo-able as a daily reading client.

**Phase 2 exit criteria:** all M1 WPs done; NFR-PERF-02 numbers recorded; size budget
still green; a tester can read mail on phone-sized viewport.

---

## 8. Phase 3 — M2 "Write"

Goal: full compose/send. After M2, Waxwing is a functional mail client (online).

### M2.1 — Squire editor wrapper

Spec: FR-CMP-01, tech-stack §4.4. Size: M.

- [x] React wrapper around `squire-rte`: controlled-ish API (HTML in/out; re-`setHTML` only on
      external change, never the own debounced echo → no cursor fight), toolbar state syncing
      (bold/italic/underline, lists, link, quote), clean async lifecycle (engine torn down +
      timer/listeners cleared on unmount). _Font basics (size/family) DEFERRED to M2.2's composer
      — the engine seam exposes `setFontSize`; deferred to keep the roving toolbar all-buttons for
      clean a11y (a native `<select>` conflicts with arrow-roving). Documented deviation._
- [x] Output hygiene: mail-compatible HTML — `cleanOutgoingHtml` strips Squire's editor-only
      classes (font/size/color/highlight) + bookmarks/ZWS while keeping inline styles; pure,
      unit-tested `htmlToPlainText` generator (blocks→newlines, `- `/`1. ` lists, `> ` blockquote
      nesting, `text (href)` links, entity decode, whitespace collapse).
- [x] Per-message plain-text-only mode (swaps the Squire surface for a `<textarea>` seeded from
      the generated text; converts back on toggle, content preserved).
- [x] Keyboard + a11y on the toolbar (`role="toolbar"` roving focus ArrowLeft/Right/Home/End,
      `aria-pressed`; ⌘/Ctrl+B/I/U + ⌘K-link; the surface is `role="textbox" aria-multiline`).
- [x] Squire fully behind the `EditorEngine` seam (only `squire-adapter.ts` imports squire-rte +
      dompurify, reached via a dynamic `import()` → lazy chunk, entry bundle unchanged); tests
      inject a fake engine (jsdom has no contenteditable).

Done when: editor round-trips pasted third-party HTML unmangled (fixture corpus test) and
emits a sane text alternative.

### M2.2 — Composer container

Spec: FR-CMP-09. Size: M.

- [x] Docked mini-composer (bottom-right) ↔ full-screen (modal); multiple parallel drafts on
      desktop with no lossy cap (past `MAX_OPEN`=3 the oldest collapses to a minimized chip, none
      dropped); single full-screen composer on phone. "New message" trigger in the Header + best-
      effort ⌘/Ctrl+N. Escape harmless (owner-directed, Apple-aligned): full-screen→docked, docked
      no-op; minimize/close are explicit buttons.
- [x] Composer state store (**Zustand**, module-scoped): one entry per draft, survives route
      changes (the docked host portals to `<body>` in the persistent AppShell, outside the
      route-swapped `<main>`).
- [x] Unsaved-changes guard on close (a discard-confirm `Dialog` for a dirty draft — a STUB; once
      M2.6 autosaves to the Drafts mailbox, close saves silently and the guard is invisible).

Done when: two drafts can be edited in parallel, docked, expanded, and restored after a
route change.

### M2.3 — Reply / reply-all / forward

Spec: FR-CMP-02, FR-CMP-10 (forward originals). Size: M.

- [x] Recipient derivation (pure `deriveRecipients`): reply (Reply-To > From), reply-all
      (dedup by lowercased email, drop own addresses), forward (empty To).
- [x] Quoting: HTML `<blockquote>` with an attribution line; `>`-quoting in text mode comes free
      from `htmlToPlainText`. _Quote folding (collapsed/expandable) DEFERRED to a later composer
      polish pass — it needs Squire-adapter DOM work beyond M2.3's pure-logic + wiring scope._
- [x] Subject handling (`replySubject`/`stripSubjectPrefix`): `Re:`/`Fwd:` + localized variants
      (de `AW:`/`WG:`, counted `Re[2]:`) normalized to a single English `Re:`/`Fwd:` (Apple-Mail-
      aligned, interop-first), **no stacking**.
- [x] Threading headers: `In-Reply-To` = source `messageId`, `References` = source refs ∪ messageId
      (forward starts a new thread). Envelope fetch extended with messageId/inReplyTo/references/
      replyTo (rebuildable cache; existing rows backfill on next `/get`).
- [x] Forward: original attachments carried by blob reference (`DraftAttachment[]` on the draft);
      the chip UI is M2.7, blob-referenced inclusion at send is M2.8.
- [x] Identity preselection (`inferFromIdentity`): the own address the source was addressed to,
      from the JMAP session's personal accounts + username (M2.5 replaces with `Identity/get`).

Done when: reply round-trip against the fixture threads correctly in a second client
(headers verified in the raw message).

### M2.4 — Recipient fields

Spec: FR-CMP-05 (recents part; contacts autocomplete lands in M4.3). Size: M.

- [x] To/Cc/Bcc pill UI (`RecipientField`, APG editable-combobox + roving-tabindex pills):
      parse on commit (comma/semicolon lists, `Name <addr>`), remove/keyboard-remove any pill,
      **keyboard-only operable**. _Pointer drag DEFERRED; moving a pill between fields is a per-pill
      menu (`moveRecipient`) — the a11y-first equivalent, drag can layer on unchanged later._
- [x] Validation: pragmatic RFC-plausible check (`isPlausibleEmail`); invalid pills flagged
      (visual + `VisuallyHidden` "invalid").
- [x] Autocomplete v1: **recent correspondents** from a new replica `addressStats` store
      (Dexie `version(2)`, additive — no upgrade fn), harvested best-effort after `putEmails`
      (backfill + delta only, not re-reconcile; `lastSeenAt` monotonic so re-sync is idempotent);
      ranked by recency×frequency (30-day half-life). _Sent-boost needs own addresses in the sync
      path → follow-up; ranking is recency+frequency for now._
- [x] Typo heuristic (`suggestDomainCorrection`, pure): Levenshtein ≤2 against a common en+de
      provider list → "Did you mean …?" with an Apply affordance.
- [x] Autocomplete behind a `RecipientSuggestionSource` interface (recents impl +
      `combineSuggestionSources`); M4.3 adds a contacts source with zero field-UI churn.

Done when: fast keyboard-only recipient entry works; suggestions appear from mail history.

### M2.5 — Identities & signatures

Spec: FR-CMP-06. Size: S.

- [x] `Identity/get` into the replica (one-shot per leadership session; `Identity/changes`
      deferred) → `identities` store + `useIdentities`; From selector (native `Select`) shown
      only when >1 identity.
- [x] Per-identity signature (HTML, else text→HTML) seeded above the quote in a marked container
      (`[data-waxwing-signature]`); swapping the From identity replaces exactly that node without
      clobbering the user's text; a user-deleted signature is left alone. Placement param wired
      (`aboveQuote` default; the Settings toggle is deferred).
- [x] Per-identity reply-to carried via the draft's `fromIdentityId` (resolved to `Identity.replyTo`
      at M2.8 `EmailSubmission/set`).

Done when: switching From swaps signatures correctly in both HTML and text modes.

### M2.6 — Drafts autosave

Spec: FR-CMP-03. Size: M.

- [x] Local-first: every few seconds of typing → replica (`drafts` store, durable `put`);
      crash-safe (3 s idle debounce + `visibilitychange`→hidden flush; unsynced drafts
      restored as minimized chips on next load).
- [x] Server sync: debounced `Email/set` in the Drafts mailbox with `$draft`+`$seen`;
      **decision (recorded):** an update = **create-new + destroy-old in ONE `Email/set`**
      (RFC 8621 §4.6 — an Email is immutable except `keywords`/`mailboxIds`; RFC 8620 §5.3
      processes create before destroy → gap-free). Coalesced by a stable outbox id
      `draft:<localId>`; reconcile stamps the new `serverEmailId`.
- [x] Offline: the durable local row stays `pending`; the `saveDraft`/`discardDraft`
      intents ride the M1.3 outbox and replay on reconnect.
- [x] Draft lifecycle: open-from-Drafts resumes editing (`use-draft-opener` — local copy
      keeps `bcc`, else the server body); Close saves to Drafts (Apple ⌘W), Discard
      destroys local + server. `MessageList`/`Conversation` route `$draft` to the composer.

Done when: pull-the-plug test (kill tab mid-typing) recovers the draft; drafts created
offline appear on the server after reconnect. — Unit-covered (serialize/isEmpty/toEmailCreate,
drafts repo, outbox saveDraft/discardDraft reconcile + error, idempotent reopen); the live
pull-the-plug + offline-reconnect assertions are folded into the M2.9 E2E write suite.

### M2.7 — Attachments & inline images

Spec: FR-CMP-04. Size: M.

- [x] Upload pipeline via session `uploadUrl` (`JmapClient.upload`): file picker + drag & drop
      onto the window + **paste** (screenshot → inline). Inline images use a canonical
      `<img src="cid:…">` body form (`inline-images.ts`); `toEmailCreate` emits `disposition:"inline"`
      parts referenced by the html body, and regular files as `disposition:"attachment"`.
- [x] Progress UI per attachment (chip row), cancel (abort), retry; a failed upload keeps the
      draft. Only fully-uploaded blobs enter `draft.attachments` (the persistable set).
- [x] Validation before upload: per-file `maxSizeUpload` + total `maxSizeAttachmentsPerEmail`
      (new `getMailCapability`), with localized toasts; the SP.5 429 quota (Retry-After captured
      on `JmapProblemError`) surfaces as a retryable error.

Done when: a pasted screenshot arrives as a proper inline image in another client;
oversized files are rejected client-side with a useful message. — The send-side round-trip
(a real recipient sees the inline image) is exercised by the **M2.9** E2E write suite.

**Owner-decided UX (Apple-Mail-aligned):** paste image → inline, drop-on-window → attachment,
drop-on-editor → inline; no client-side image downscaling; Close during an in-flight upload
proceeds (aborts unfinished uploads); **deferred follow-up** — inline-image PREVIEW after a full
page reload (the `cid:` still sends correctly; previews survive minimize/restore via a module-scoped
`cid→objectURL` registry, but a reload clears it → restore via authenticated blob download is a
follow-up).

### M2.8 — Send pipeline

Spec: FR-CMP-07/08/10. Size: M.

- [x] `EmailSubmission/set` with envelope from identity; `onSuccessUpdateEmail`: move
      draft → Sent, clear `$draft`, set `$seen` (FR-CMP-07). The send is ONE atomic request
      (`port.submitEmail`): `Email/set create` into Drafts + `EmailSubmission/set` via a
      `#creationId` back-ref, so it works even without a prior autosaved server draft.
- [x] Set `$answered`/`$forwarded` on the source message after successful send (source id +
      kind threaded reply→draft→outbox; flagged optimistically, rolled back on failure).
- [x] Error surfacing: synchronous rejections (invalidEmail/forbiddenToSend/quota/size) →
      toast; the draft is **preserved** (`sendEmail` failure stamps the local row `error`,
      and the Drafts Email stays put — `onSuccessUpdateEmail` only fires on success).
      Async DSN bounces are out of scope (documented).
- [x] **Undo send:** a persisted outbox `notBefore` grace timestamp (survives tab-close —
      the send fires on the next leader once the grace elapses); a snackbar with Undo
      (Toast gained an `action`); an engine wake-timer arms replay at the grace boundary;
      `cancelSend` deletes the still-pending row, rolls back the source flag, reopens the
      draft. Honors `config.json` `undoSendSeconds` (default 15); the user off/5/15/30
      **Settings picker is deferred to the Settings WP** (M2.8 reads the config default).
- [x] "Attachment mentioned but none attached" warning — pure `attachment-mention` +
      localized keyword lists en/de (FR-CMP-10), quoted/signature text excluded.

Done when: send → lands in fixture inbox; Sent copy correct; Undo actually prevents
submission; rejected recipient shows a clear error. — The LIVE round-trip is the first
`EmailSubmission/set` against Stalwart and is exercised by the **M2.9** E2E write suite;
M2.8 is unit-covered (fake port/engine): submit batching + back-ref, sendEmail reconcile /
rejection / notBefore gating / coalescing / no-double-send-on-recovery, cancelSend, envelope
resolution, mention heuristic, and the ComposerWindow send UX.

**Owner-decided (M2.8):** pending "sending" state (no synthetic Sent row); Send blocks while
an attachment upload is in flight; a send stranded `inflight` is NEVER auto-resent (marked
`error` "was it sent?") because EmailSubmission is not idempotent; the undo picker is deferred
to Settings.

### M2.9 — E2E write suite

Spec: NFR-QUAL-01. Size: S.

- [x] Playwright `write.spec.ts` (5 specs, alice↔bob against the live Stalwart fixture):
      compose→send→receive round-trip; reply threading (`inReplyTo`/`references` + source
      `$answered`); attachment round-trip; draft autosave + reload recovery; undo send
      (cancels delivery + reopens). Recipient/sender verified over JMAP (not the ~60 s
      sweep) → fast + non-flaky. Own harness (`playwright.write.config.ts` port 4184,
      `write.setup/teardown.mjs`, `stalwart/seed-write.mjs`, `tests/helpers.ts`); wired into
      `pnpm e2e:write` + `verify:e2e`.

Done when: suite green. — **5/5 green live (2026-07-11).** DP-1 resolved: `EmailSubmission/set`
DELIVERS alice→bob to bob's **Inbox** (waxwing.test is a local domain → in-process delivery;
the unpublished SMTP host port is inbound-only), and `onSuccessUpdateEmail` moves alice's copy
Drafts→Sent + clears `$draft` + sets `$seen`. No fixture infra change needed. Undo-send grace
is overridden per-test via a `page.route('config.json')` interception (no `public/config.json`
edit).

**Phase 3 exit criteria:** all M2 WPs done; a tester can hold a real e-mail conversation
(receive, reply with attachment) using only Waxwing.

---

## 9. Phase 4 — M3 "Daily driver"

Goal: the features that make Waxwing the client you *don't close*: search, labels, real
offline, PWA install, push notifications, settings, shortcuts.

### M3.1 — Search

Spec: FR-SRCH-01/02, FR-SRCH-03 (scoping + history; saved searches → V1.x). Size: M.

- [x] Global search box (shortcut `/`): server-side `Email/query` with full filter
      mapping via the pure `search-query` parser.
- [x] Operator parser (`search-query.ts`): `from:`/`to:`/`cc:`/`subject:`/`body:`,
      `has:attachment`, `is:unread`/`read`/`flagged`, `in:folder`, `before:`/`after:` (+
      `today`/`yesterday`/`YYYY-MM-DD`), quoted phrases → JMAP `FilterCondition`s 1:1
      (FR-SRCH-02); unknown/unresolved/bad-date operators degrade to free text. Chips are a
      DERIVED view of the same tokens (honored operators only), so text ↔ chips can never
      drift. (The chip strip IS the advanced view — no separate modal in v1.)
- [x] Results as the virtualized M1.6 list (a `ListSource` union on `useMessageList` +
      an engine `watchQuery`/`unwatchQuery` seam over the extracted `backfillQuery`), with
      `SearchSnippet/get` `<mark>` highlights — sanitized escape-then-re-mark (`snippet.ts`)
      + plain-preview fallback.
- [x] Scoping current-folder / all-mailboxes (`?scope=`); an all-mailboxes selection gates
      folder-move bulk actions. Search lives in `?q=…&scope=…` (opening a result preserves it).

Done when: operator strings and the chips produce identical JMAP filters (unit-tested); results
render with highlights against the fixture. — Parser is exhaustively unit-tested (operator
mapping + `canonicalQueryKey` equality across orderings); the live snippet-highlight render is
folded into a future search E2E. Search history in `localPrefs` and a saved-search/advanced-panel
UI are deferred to V1.x (per §M3.1 scope).

### M3.2 — Keywords/labels + cleanup tools

Spec: FR-ORG-02/04. Size: M.

- [x] Label management: create/color/rename custom keywords (IMAP-interoperable names;
      color map stored in `localPrefs` — colors are client-local). Rename edits the local
      display name only (keyword immutable); a curated registry is merged with keywords
      discovered on cached mail.
- [x] Assign/remove via list bulk actions, message view, and keyboard (`l`); filter/browse by
      label in the sidebar alongside folders (FR-ORG-02), plus per-row colored swatches.
- [x] Empty-trash / empty-junk with retention hint; per-folder "delete older than" bulk
      cleanup (FR-ORG-04) — chunked destroys respecting `maxObjectsInSet`. Delete-older-than
      moves to Trash for normal folders (recoverable); destroys only for Trash/Junk.

Done when: labels round-trip with another IMAP/JMAP client against the fixture; bulk
cleanup of thousands of messages completes without tripping server limits.

### M3.3 — Offline outbox hardening + conflict UX

Spec: FR-OFF-03. Size: M.

- [x] Extend the M1.3 queue: durable replay across restarts (the rollback is now a
      PERSISTED `OutboxUndo` value on the row, not an in-memory closure), exponential
      backoff (`backoff.ts`, half-jitter, `Retry-After` wins, clamped), dependency
      ordering (temp-mailbox-id rewrite now also covers `renameMailbox`/`deleteMailbox`/
      `moveMailbox`'s SUBJECT id — draft-create-before-send was already atomic inside one
      `submitEmail` request), dedup on reconnect storms (debounced reconnect + a
      coalesced, replay-only pass split out of the full sync).
- [x] Conflict detection: `ifInState` on `Mailbox/set` only (a guard on the account-global
      Email state would make every offline replay a bogus conflict, and the auto-chunker
      cannot split a state-guarded set) — the authoritative Email detector is the
      per-object `SetError`. Classification in `conflict.ts`: transient (retry, NEVER
      rolled back or dead-lettered), `stateMismatch` (bounded auto-refresh, ≤3), satisfied
      (`notFound` on a destroy = already gone), user-facing conflict.
- [x] Conflict UX: a gentle `warning` toast with ONE action ("Keep in Inbox" / "Try again"
      / OK) **plus** a persistent header affordance + problems dialog (retry / discard /
      discard all) — a toast alone auto-dismisses, which is not "never silent loss".
- [x] Offline send: durable `QueuedSends` chips ("Will send when you're back online"),
      cancelable for as long as the row is `pending` (the `notBefore` clause was dropped
      from `cancelSend` — it added no safety and made an offline-queued send uncancelable).
- [x] Chaos tests: **hermetic** (`engine.chaos.test.ts`) — a virtual clock, a driven
      online flag, an in-memory server the test mutates mid-flight, `random: () => 0`.
      Covers flapping (zero lost actions, exactly-once), concurrent server modification
      (folder deleted / message destroyed under a queued intent), reconnect-storm dedup,
      cleanup-burst coalescing, durable replay across a restart, offline-send cancel,
      follower wake.

**Scope split (recorded 2026-07-12):** the chaos tests ship HERMETIC here — every engine
dependency is injected, so flapping and concurrent modification are simulated
deterministically and run in ~1.4 s. The LIVE Playwright offline/chaos suite belongs to
**M3.10**, which already owns "wire the chaos tests from M3.3 into CI".

Done when: chaos suite shows zero lost actions and correct conflict surfacing.

### M3.4 — Cache policy & storage management

Spec: FR-OFF-02/04. Size: M.

- [x] Enforce windowed cache per config (`offline.cacheDays`, `offline.maxStorageMB`);
      LRU eviction of bodies/attachments beyond budget (never evict outbox/drafts).
- [x] `navigator.storage.persist()` requested on install; `estimate()`-based usage UI in
      settings with per-category breakdown (FR-OFF-04).
- [x] "Keep offline" pin per folder (exempt from eviction).
- [x] Eviction unit tests with fake storage pressure.

Done when: filling the cache beyond budget evicts correctly (test), pinned folders
survive, usage UI matches reality.

**Scope notes (recorded 2026-07-12):**

- `blobsMeta` was a DEAD table before this WP (`putBlobMeta`/`getBlobMeta` had zero callers;
  attachments and inline images were re-downloaded on every open), so "LRU eviction of
  attachments" was vacuous. M3.4 therefore also adds the **write-through blob cache** that
  gives eviction something to evict. `repo.deleteEmails` also never cascaded to
  `emailBodies`, so every delta-synced destroy leaked its body forever — fixed here.
- **`persist()` is exported and wired to the Settings switch, not to the install event.**
  M3.5 owns the install lifecycle (`appinstalled`) and must call `requestPersistence()` from
  it — noted in the M3.5 checklist below.
- `cacheDays` / `maxStorageMB` stay **deployment config** (owner decision); Settings displays
  them read-only. A user-facing override belongs to the M3.7 settings sweep.
- The pin **prefetches** as well as exempting (owner decision): exempt-only would mean the
  folder is "kept offline" but only the messages you happened to have opened are actually
  there.

### M3.5 — PWA: manifest, service worker, offline shell, updates

Spec: FR-OFF-01, FR-DEP-06, tech-stack §6. Size: M.

- [x] `vite-plugin-pwa` (Workbox, **`injectManifest`** — M3.6 extends the same `sw.ts`):
      precache `index.html` + `assets/**`; **`config.json`, `theme.css`, `manifest.json`,
      `branding/*` network-first / SWR and never precached** (tech-stack §6). Asserted on the
      BUILT artifact, not the config.
- [x] Manifest: icons rendered from `assets/logo/` (`scripts/icons.mjs`), standalone display,
      theme/splash colors. **Hoster-editable, not baked** (owner decision — see scope notes).
- [x] Offline boot: the app shell + deep links load with no network, behind the offline marker
      that already exists (`StatusRegion`). Verified in a real browser (FR-OFF-01).
- [x] Update flow: SW updates in background → one unobtrusive sticky "reload for update" toast;
      **never a forced reload**, and open drafts are flushed before the hand-over.
- [x] Install guidance UI: an account-menu item + a per-platform dialog (Chromium prompt / iOS
      add-to-home-screen + the Web-Push note, NFR-COMPAT-01). No banner, no nag.
- [x] **Call `requestPersistence()` (`sync/storage.ts`, M3.4) from the `appinstalled`
      handler.** M3.4 owns the function and the Settings switch; the "requested on install"
      half of its FR-OFF-04 bullet is deliberately left here, because M3.5 owns the install
      lifecycle. Do not call it on first paint — in Firefox it can prompt.
- [x] **Pulled forward from M4.9: the literal `<base href="/">`** — SP.5 already prescribed it,
      and it is a hard prerequisite for a correct worker (scope, `start_url`, `navigateFallback`
      all resolve through `document.baseURI`).
- [x] **Two BESTAND fixes the worker made unavoidable:** the app's first `ErrorBoundary`
      (`ChunkErrorBoundary`), and a deadline on `loadConfig()`.

Done when: Lighthouse PWA checks pass; offline reopen works on Chromium + WebKit
(Playwright offline mode); update toast demonstrated with a staged second build.
**Status: the offline reopen and the precache contents are verified in Chromium against the real
production bundle (a throwaway harness, not a committed suite). Lighthouse, WebKit, the staged
second build and "offline shows cached MAIL" (which needs an authenticated session) are M3.10 —
see its checklist.**

**Scope notes (recorded 2026-07-12):**

- **The manifest is a DEPLOYMENT file, not a build artifact** (owner decision). FR-DEP-04 ("the
  same build artifact serves all installations; no rebuild for rebranding") is a *Must*, and a
  white-labelled deployment whose home-screen icon says "Waxwing" breaks it. So `manifest.json`
  ships from `public/`, is linked by hand, and is runtime-cached like `config.json` — a hoster
  edits name, colors and icons in place. This deviates from this checklist's original "manifest is
  baked at build; document the limits", in the direction the spec points; no ADR, nothing is
  reversed. **It is also forced by the plugin:** whenever vite-plugin-pwa owns the manifest it
  appends it to `additionalManifestEntries`, which workbox-build applies *after* `manifestTransforms`
  — so a plugin-generated manifest cannot be kept out of the precache by any option, and a precached
  copy would shadow the network-first route and freeze the rebrand until the next release.
- `.json`, never `.webmanifest`: Stalwart serves the unknown extension as
  `application/octet-stream` (SP.5) and browsers then refuse to parse it.
- **The worker is registered above the auth gate** (in `App`, not `AppShell`). From inside the
  shell it would only ever install after a sign-in — so a first-time visitor precaches nothing (no
  offline shell) and Chromium, whose installability check needs a registered worker, would offer no
  install on the sign-in screen.
- The `beforeinstallprompt` capture runs in `main.tsx` **before the first await**: the event fires
  once, is never replayed, and on a repeat visit Chromium can fire it while the boot is still
  waiting on `config.json`.
- **`registerType: 'prompt'`, and `skipWaiting()` only ever on the user's word.** `autoUpdate`
  would activate a new worker under a live tab, drop the old precache, and 404 that tab's next lazy
  chunk — the routes, the composer and the dialogs are all lazy.
- Icons are **committed PNGs** (`apps/web/public/branding/`), regenerated by `node scripts/icons.mjs`
  via the Playwright Chromium the E2E suite already installs — no `sharp`, no native toolchain. The
  maskable variant is a separate SVG: the plain icon's artwork reaches outside the spec's 80 % safe
  circle and Android would crop it.

### M3.6 — Notifications + preferences

Spec: FR-NOTIF-01/03, NFR-PRIV-01/02. FR-NOTIF-02 (**app closed**) is **deferred — see
ADR-010**. Size: M.

> **Scope change, forced by evidence gathered in this WP (ADR-010).** The original plan
> here was Web Push. It cannot be built: **no JMAP server on earth can deliver a Web Push
> to a browser today.** Chromium and Safari both refuse `PushManager.subscribe()` without
> an `applicationServerKey`, which binds the endpoint to a VAPID key the server must then
> sign with (RFC 8292 §4.2) — and **no JMAP server implements RFC 9749**, the capability
> that would publish that key. Stalwart additionally **base64-wraps the aes128gcm body**,
> so its payload is undecryptable in *every* browser, Firefox included. Both defects were
> reproduced on the wire against the fixture and reported upstream (`docs/upstream/`).
> M3.6 therefore ships the same notifications sourced from the **live push channel** — i.e.
> whenever the app is running, a backgrounded or minimised tab included — plus the full
> FR-NOTIF-03 preference surface, and it **says plainly** what it cannot do (NFR-PRIV-02).

- [x] **The new-mail signal.** `Email/changes.created` is preserved separately from
      `updated` in `drainChanges` (they were folded together; a `$seen` flip from another
      client was indistinguishable from an arrival) and returned by `syncEmails` — the
      only seam that means "new to this account". Never `putEmails`, which the `forceFull`
      re-probe and every backfill page also call.
- [x] **The guards** (`engine.ts#raiseNewMailNotifications`): leader-only (structural, and
      re-checked *after* the pass's awaits — leadership can be lost mid-pass); the **first
      successful pass of a leadership session never notifies** (it is the catch-up: a
      sign-in, a fresh tab, a re-election — a *failed* pass does not spend the exemption);
      a `receivedAt` floor stamped at leadership and **clamped to the newest `receivedAt` the
      replica holds**, because the floor is a client clock and `receivedAt` is the server's:
      a device running fast would otherwise notify about nothing at all, silently, for the
      length of the skew; a **rolling 60 s budget** of 3 banners, beyond which the rest of the
      window collapses into one accumulating summary; never while **any tab** of the app is in
      the foreground; never fatal to a sync pass.
      (A laptop waking after eight hours is *not* covered by the first-pass exemption — a Web
      Lock survives sleep, so the tab is still leader and still armed. What bounds that case is
      the burst budget: one "60 new messages", not sixty banners.)
- [x] Shown through **`ServiceWorkerRegistration.showNotification()`** — never
      `new Notification()`, which throws `Illegal constructor` on Android Chrome. The
      registration is published by `useUpdatePrompt` (M3.5) for the notifier to pick up.
- [x] **`notificationclick`** in the same `src/sw/sw.ts`: focus-or-open, with
      `includeUncontrolled: true` (there is no `clientsClaim()`, so the page that raised the
      notification is typically *not* controlled) and the route delivered by `postMessage`
      (`WindowClient.navigate()` rejects for an uncontrolled client). Every rule is a pure
      function in `src/notify/click-route.ts` — nothing in `src/sw/` can have a test.
- [x] **Preferences (FR-NOTIF-03):** per-folder on/off (Inbox seeded on first enable),
      quiet hours (crossing midnight; `from` inclusive / `to` exclusive; `from === to` is
      empty, not "always"), preview content on/off (**with preview off, no sender and no
      subject appear anywhere** — a lock-screen is not ours to leak onto), sound on/off.
      `localPrefs`, cross-tab-safe read-modify-write.
- [x] **Permission flow:** `Notification.requestPermission()` is called from the settings
      switch's click and nowhere else — an ungestured prompt is auto-denied, and that denial
      sticks to the origin permanently. `denied` is unrecoverable in-app and says so.
- [x] **The honest capability probe:** `getWebPushVapidCapability` (RFC 9749) in
      `@waxwing/jmap`. Absent ⇒ the Notifications settings state plainly that notifications
      while the app is fully closed are not available with this server, and why (NFR-PRIV-02).
- [x] i18n en+de (`notify.*`, formal *Sie*); a11y: a real `<fieldset>`/`<legend>` for the
      folder group, native `<input type="time">`, `expectNoA11yViolations`.

Done when: with the app open in a **background** tab or window, delivering mail to the
fixture raises a system notification; clicking it focuses the tab and opens the message.
(Manually verified per platform. FR-NOTIF-02's "app closed" is **not** in scope — ADR-010.)

### M3.7 — Settings area

Spec: FR-SRV-04, FR-VAC-01, FR-QTA-01, FR-CMP-02/08, FR-RD-02/07. Size: M.

> **Fixture capability findings (probed live before any code, Stalwart v0.16.11-alpine).**
> `urn:ietf:params:jmap:vacationresponse` and `urn:ietf:params:jmap:quota` are BOTH advertised,
> at session level *and* in `accountCapabilities`. `VacationResponse/get` returns the singleton
> (`id: "singleton"`) exactly as RFC 8621 §8 describes, so FR-VAC-01 is live-demonstrable.
> **`Quota/get` returned an EMPTY list**, however: Stalwart advertises the capability but an
> account has no quota until one is assigned — so the fixture now provisions one
> (`x:Account/set` → `quotas: { maxDiskQuota: 100 MB }`; the key is camelCase, `MaxDiskQuota` is
> rejected with `invalidPatch`), without which the Done-when's "filled test account" could not
> exist. Also confirmed live: Stalwart's **top-level `mail` capability is `{}`** and every real
> limit lives in `accountCapabilities` — a capabilities panel that read the session level would
> render an empty table against the very server we test against, while passing any hermetic test
> written with a tidy hand-made session.

- [x] Settings shell (lazy route): **General · Appearance · Reading · Compose · Vacation
      responder · Notifications · Offline & storage · Server · About**. Theme, language and the
      reading-pane mode stay in `localStorage` — they are applied on the ONBOARDING screen, where
      there is neither an account nor a replica to scope them to; everything new is account-scoped
      `localPrefs`. Sections that need a replica, a session, or a server capability are simply
      absent without one (FR-SRV-02: hidden, never broken). **No accent picker** — owner decision:
      deferred to M4.5, because M1.1 machine-verifies WCAG-AA contrast only for the built-in accent
      and a free-form colour would ship an unverifiable contrast into a Must.
- [x] **Server capabilities panel** (FR-SRV-04): core + mail limits, the optional-feature matrix,
      and the URNs Waxwing has no name for, listed raw rather than swallowed. Availability is
      stated in **words** ("Offered" / "Not offered"), never a colour alone (WCAG 1.4.1). Limits
      are read from the level that HAS them (`getMailCapability` → the account object); presence is
      asked of **both** levels (new `hasCapability` in `@waxwing/jmap`).
- [x] **Vacation responder** (FR-VAC-01): the RFC 8621 §8 singleton — on/off, date range, subject,
      the M2.1 rich-text editor, and a preview that is **the reader's own sandboxed frame and
      sanitizer**, not a second rendering surface. `datetime-local` speaks the user's local wall
      clock and the RFC speaks UTC; the conversion goes through `Date` in one place and no test
      hardcodes an offset. Writes are direct, online-only calls carrying `ifInState` — never outbox
      intents (the outbox is Email/Mailbox-shaped; a settings singleton has nothing to roll back).
      All three failure paths are handled: a stale `ifInState` **repaints from the server** rather
      than merging behind the user's back (it aborts the METHOD, so it arrives as a thrown
      `JmapMethodError`, never in `notUpdated`); a per-object `SetError` surfaces inline; offline
      disables Save and says why.
- [x] **Quota** (FR-QTA-01, RFC 9425, capability-gated): a bar in the mail sidebar and a breakdown
      in Settings → Server, fed by ONE shared module store — the sidebar and the settings panel must
      not each poll. Warns at **≥ 90 % OR the server's own `warnLimit`, whichever fires first** (a
      server that warns at 98 % must not be allowed to break the 90 % promise; one that warns at
      50 % must not be silenced). The ≥ 90 % toast reuses the existing Toast, once per level per tab.
      `Quota` is deliberately **not** added to the engine's `WATCHED_TYPES`: every `StateChange`
      there drives a full delta sync, so a quota tick — one per delivery — would kick a mail sync.
      A TTL plus `invalidateQuota()` on the two `overQuota` paths that already exist (send, and the
      outbox conflict) is the whole cost.
- [x] Reading (FR-RD-02/07) and Compose (FR-CMP-02/08) preferences, each owned by the module that
      CONSUMES it. Two of them close standing gaps rather than add features: `reading.autoMarkRead`
      has gated the reader's dwell timer since M1.8 **with no way to set it**, and the "always load
      remote content from this sender" list has been appended to since M1.7 **with no way to see or
      undo it**. The undo-send picker is the one M2.8 explicitly deferred here.
- [x] **Owner decision: the undo-send default is now 15 s, not 10.** FR-CMP-08 and M2.8's own note
      both said 15; the code said 10, and nobody had decided that. A picker (off / 5 / 15 / 30)
      overrides it per account.

Done when: vacation responder round-trips against the fixture; capabilities panel matches
the fixture's session doc; quota bar reflects a filled test account. **(`e2e/tests/settings.spec.ts`
— each assertion is made against the SERVER over JMAP, not against the screen that wrote it.)**

### M3.8 — Keyboard shortcuts + command palette

Spec: FR-UI-04. Size: M.

- [x] Shortcut system: central registry, context-aware (list vs. reading vs. composer),
      no conflicts with editor; Gmail/Fastmail-style defaults: `j/k` next/prev, `e`
      archive, `r` reply, `c` compose, `/` search, `x` select, `#` delete, `u` back/unread,
      `?` cheat-sheet.
- [x] `?` cheat-sheet overlay, generated from the registry (always accurate).
- [x] **Command palette (⌘K)**: every registered action + folder jump + label jump,
      fuzzy matching, recent-first ranking (FR-UI-04).
- [x] All palette/shortcut actions dispatch the same action layer as UI buttons (single
      source of truth).

Done when: full triage session (read, archive, reply, move) is possible without touching
the mouse; palette reaches every folder and action.

### M3.9 — Reading & triage polish

Spec: FR-RD-06/07/08, FR-MBX-03, FR-LST-06. Size: M.

- [ ] Header details on demand: full addresses, date, message-id, authentication results
      where exposed (FR-RD-06). **Live-probed (M3.9 step 0):** `headers` (Raw) is deliberately
      NOT fetched — RFC 8621 returns it RFC-2047-encoded and folded, and everything we show is
      available server-decoded via dedicated properties. Auth results use
      `header:Authentication-Results:asText:all` and read `[0]`: RFC 8621 §4.1.2 makes the
      un-suffixed form return the **last** instance, which on a phishing mail is the sender's own
      forgery. Rendered neutrally + attributed, never as a verdict (RFC 8601 §7.1).
- [ ] "View source" / download `.eml` — an unconditional authenticated download of the Email's
      own `blobId`. **The capability gate this task used to prescribe does not exist** →
      **ADR-011**; `downloadUrl` is mandatory in RFC 8620 and RFC 9404 `Blob/get` is strictly
      worse (base64-in-JSON, capped at `maxSizeRequest` = 10 MB vs the endpoint's 50 MB).
      Must NOT use the blob cache: the Email's own blobId has no owner link, so the next
      maintenance pass reaps it as an orphan (`eviction.ts:217`).
- [ ] Attached `message/rfc822` opens as nested in-app message view via `Email/parse`
      (FR-RD-07). **No `postal-mime` fallback** — SP.5 already answered that (`:589-597`); the
      parenthetical that used to stand here contradicted the finding it cited. `bodyValues` MUST
      be named in `properties` (SP.4 caveat).
- [ ] Phishing friction: display-name vs. address reveal on hover/tap; warn when link
      text host ≠ target host (FR-RD-08).
- [ ] **5a — the non-pointer paths FIRST** (they do not exist today, and WCAG 2.2 **SC 2.5.7
      Dragging Movements** makes them a *prerequisite* of the drag, not a companion — the task
      used to read as though only the drag were missing): a `Move…` entry in the list's bulk bar,
      the `v` move chord widened from `reading` to the list scope, and a folder "Move to…"
      action. **Folder re-parenting has no UI at all** — `moveMailbox` is fully implemented,
      undoable and state-guarded, with *zero* callers (`use-folder-actions.ts:34`). Pure
      `folder-tree` guards (no self/descendant cycle, `mayCreateChild`, `maxMailboxDepth`,
      top-level gated on `mayCreateTopLevelMailbox`) are where the correctness lives.
      Also closes a real inconsistency: `MessageView.tsx:382` moves via `actions.move` directly,
      bypassing the Undo toast that archive/trash get — `Triage` gains `moveTo`.
- [ ] **5b — drag & drop** on top of 5a: messages → folders, folder re-parenting (FR-MBX-03).
      HTML5 DnD (not pointer events — they would fight the swipe below; the two are separated by
      `pointerType`). Routes through the existing `move`/`moveMailbox` intents; no new write path.
      `dragover` may only consult `dataTransfer.types` (values are unreadable until `drop`, by
      spec). No `aria-dropeffect` (deprecated/unimplemented) — announce via a live region.
- [ ] Swipe gestures on touch: configurable archive/delete/read actions (FR-LST-06).
      **Owner decision (2026-07-16): Apple parity** — default right = mark read, left = archive
      (→ trash when the account has no archive role), configurable per direction in Settings, as
      iOS Mail does. Routed through `use-triage.ts` so a swipe, a button and a keystroke are one
      code path. Mouse pointers are ignored (that is 5b's drag). No confirmation on a destructive
      swipe — the Undo toast is the safety net (Apple parity) — but swipe-to-trash **inside**
      Trash must never mean destroy (`destroy` has no undo).
      **Known interaction:** swipe-to-read makes **B1** (§13) user-visible in the commonest touch
      flow (a swiped-read row stays in a `?q=is:unread` view until the server echoes; offline,
      until reconnect). Accepted and noted; B1 lands before G2 as planned.

Done when: each item demo-able; **the non-pointer path exists for every drag operation** (SC
2.5.7); swipe has a keyboard/button equivalent.

### M3.10 — E2E: offline & push suites

Spec: NFR-QUAL-01. Size: M.

- [ ] Playwright: offline outbox scenarios (compose offline → reconnect → delivered),
      cache/eviction smoke, PWA install + offline boot, push-driven live update, (where
      runnable) notification display.
- [ ] Wire the chaos tests from M3.3 into CI (may be a nightly job if slow).
- [ ] **Handed over by M3.6.** Background push (app **closed**) is **not coverable at all** —
      no JMAP server can deliver it (ADR-010), so there is nothing to assert and no test may
      pretend otherwise. What *is* coverable, and should be:
      - the live-channel notification end to end: `context.grantPermissions(['notifications'])`,
        deliver mail to the fixture with the tab **backgrounded**, assert the banner (Chromium
        exposes it via CDP; WebKit does not — cover what the engine allows and say which);
      - the **click route**: focus-or-open lands on the message, at the root *and* under a
        `/mail/` mount (the two coordinate spaces are the easiest thing here to get wrong);
      - the **leader-only** guarantee with two tabs open: exactly ONE banner, not two;
      - the **first-pass silence** on a fresh sign-in with a full inbox (no notification storm);
      - the **cross-tab foreground veto**: with the leader tab hidden and a *second* tab focused,
        no banner is raised (the probe rides the `EngineBus`, so only a real browser proves it);
      - **sign-out closes the banners** (FR-AUTH-05): they belong to the OS, they outlive the
        session, and a jsdom test cannot see the notification centre.
- [ ] **Handed over by M3.5** (a real browser is the only place these can run; do not fake
      them under vitest — jsdom has no `ServiceWorkerContainer` and no Cache Storage):
      - offline reopen **with an authenticated session**, showing cached MAIL behind the
        offline marker — M3.5 verified only that the *shell* and its deep links load offline
        (Chromium, no fixture);
      - the update toast against a **staged second build** (build → serve → change a source →
        rebuild → `registration.update()`), and the assertion that the reload flushes an open
        draft first;
      - a **precache-contents assertion on `dist/sw.js`**: `index.html` + `assets/**` and
        *nothing* hoster-editable. Nothing fails the build today if a future asset slips into
        the precache or, worse, exceeds `maximumFileSizeToCacheInBytes` (Workbox only warns and
        then silently omits the file — an offline shell missing its own entry chunk);
      - the hoster-swap-without-rebuild check: edit `dist/config.json` + `dist/manifest.json`,
        reload, branding changes;
      - WebKit + Lighthouse installability, and the deep-link reload under a `/mail/` prefix.

Done when: suites green in CI; flaky tests quarantined with issues, not ignored.

**Gate G2:** owner reviews M3; **decision D3** (raise server baseline to Stalwart v1.0?)
is made — v1.0 is expected ~Oct 2026, which likely coincides with this phase. Outcome
recorded; CI pins updated if raised.

**Phase 4 exit criteria:** all M3 WPs done; G2 passed; team members can (and do) use
Waxwing as their daily client against a real mailbox.

---

## 10. Phase 5 — M4 "V1 release"

Goal: contacts, polish to spec (theming, i18n, a11y, perf), and shipping.

### M4.1 — `@waxwing/jscontact`

Spec: FR-CON-06, tech-stack §5. Size: M.

- [ ] MIT package: JSContact (RFC 9553) ↔ vCard 4.0 (RFC 6350) conversion, both
      directions; explicit supported-property matrix documented (name components, emails,
      phones, addresses, org/title, birthday, notes, photo, groups).
- [ ] Lossless-where-possible: unknown vCard properties preserved on round-trip where
      JSContact allows, else documented as dropped.
- [ ] Test corpus: vCards from Apple/Google/Outlook exports + RFC examples.

Done when: corpus round-trips within the documented matrix; package builds standalone.

### M4.2 — Contacts area

Spec: FR-CON-01/02/04. Size: L.

- [ ] Extend `@waxwing/jmap` with RFC 9610 types (`AddressBook/*`, `ContactCard/*` incl.
      query/changes) and the sync engine + replica with contact tables (same
      account-scoped, delta-synced pattern as mail).
- [ ] Address book list incl. shared books, rights-aware (FR-CON-01).
- [ ] Contact list: search-as-you-type (local + server query), detail view; photo via
      blob (FR-CON-01).
- [ ] Create/edit/delete with progressive form — common fields visible, rest behind
      "add field" (FR-CON-02).
- [ ] Groups: create/manage; group → recipient expansion hook for the composer
      (FR-CON-04).

Done when: contact CRUD + groups round-trip against the fixture (Stalwart supports RFC
9610 natively); shared book respects read-only rights.

### M4.3 — Contacts ↔ mail integration

Spec: FR-CON-03/05/06. Size: M.

- [ ] Composer autocomplete v2: all address books + recents, ranked by usage, avatars
      from contact photos (FR-CON-03) — plugs into the M2.4 interface.
- [ ] From a message: "add sender to contacts" / "edit contact"; hover-card with contact
      info + recent-conversation link (FR-CON-05).
- [ ] Import/export: vCard 4.0 and JSContact JSON via M4.1 (file picker/download,
      duplicate handling on import) (FR-CON-06). CSV import stays backlog (Could).

Done when: autocomplete prefers a contact over a stale recent; sender-to-contact flow
round-trips.

### M4.4 — Shared accounts

Spec: FR-AUTH-08. Size: M.

- [ ] Surface non-primary accounts from the JMAP session as additional mailbox trees in
      the sidebar (visually grouped by account).
- [ ] Read/write per server-granted rights (`myRights` throughout already handles most);
      identity handling when sending from a shared account (capability-dependent —
      investigate, record findings).
- [ ] Replica/sync already account-scoped (M1.2/M1.3) — this WP is mostly UI + routing
      (`accountId` in context) + tests.

Done when: a fixture delegation setup shows the shared mailbox; actions respect rights;
primary-account UX unchanged.

### M4.5 — Theming & white-label completion

Spec: FR-THEME-01/02/03. Size: M.

- [ ] Audit: every color/radius/spacing/typography value flows from tokens; zero
      hardcoded values (lint or script check).
- [ ] `theme.css` override contract documented with an annotated example theme
      (docs/theming.md); test a full restyle without rebuild (FR-THEME-01).
- [ ] Branding completeness pass: product name, logo, favicon, accent, links everywhere
      (incl. notifications, install UI, about) (FR-THEME-02).
- [ ] Built-in accent palettes selectable by users; hoster can pin/extend via config
      (FR-THEME-03).

Done when: a demo rebrand ("Acme Mail": logo + theme.css + config) shows no Waxwing
remnants and no rebuild.

### M4.6 — i18n completion + RTL readiness

Spec: FR-I18N-01/02. Size: M.

- [ ] String extraction audit: no raw user-visible strings (automate: lint rule or
      scanner in CI).
- [ ] Full `de` translation reviewed by a native speaker (the project owner); pluralized,
      `Intl`-formatted dates/numbers/relative times everywhere.
- [ ] Locale files structured for community translation (Weblate-compatible layout,
      documented in CONTRIBUTING).
- [ ] RTL readiness: logical CSS properties audit (`margin-inline-start` etc.),
      `dir`-flip smoke test — layout must not break (FR-I18N-02; full RTL locale is
      post-V1).

Done when: language switch en↔de shows zero untranslated strings (CI check); `dir="rtl"`
smoke test renders sanely.

### M4.7 — Accessibility audit & fixes

Spec: FR-A11Y-01. Size: M.

- [ ] Automated: axe across all screens/states in CI (component + E2E level), both themes
      contrast-verified.
- [ ] Manual screen-reader passes of the three core flows — list triage, reading,
      composing — with VoiceOver (macOS/iOS) and NVDA (Windows); findings tracked and
      fixed.
- [ ] Keyboard-only walkthrough of every flow incl. DnD alternatives, focus management in
      dialogs/palette/composer.
- [ ] `prefers-reduced-motion` honored in every animation; touch targets ≥ 44 px verified.
- [ ] Record known limitations honestly in docs/accessibility.md.

Done when: WCAG 2.2 AA self-assessment documented; core flows SR-tested with issues fixed.

### M4.8 — Performance hardening

Spec: NFR-PERF-01/02/03. Size: M.

- [ ] Bundle audit: route-level code splitting verified (contacts/settings/composer lazy);
      dependency weight review; initial JS ≤ 300 KB gz **with margin**.
- [ ] Measured on target hardware profiles (mid-range laptop, throttled 4G phone
      emulation): cold interactive < 2 s / < 4 s; SW-cached < 1 s (NFR-PERF-01).
- [ ] 100 k-message list re-verified end-to-end (NFR-PERF-02); memory profile of long
      sessions (leak check: open/close 100 conversations).
- [ ] Lighthouse CI (or equivalent) added as non-blocking trend report.

Done when: numbers recorded in docs; budgets green with ≥ 15 % headroom.

### M4.9 — Release engineering

Spec: FR-DEP-01/02/05, NFR-SEC-03/04, NFR-QUAL-02, tech-stack §6. Size: L.

- [ ] Release workflow (tag-triggered): build → `waxwing-web-vX.Y.Z.tar.gz` (static
      files) + `waxwing-stalwart-vX.Y.Z.zip` (Stalwart Applications bundle, `index.html`
      at zip root, relative paths) → GitHub release with checksums (FR-DEP-01/02).
      **SP.5 prerequisite for the Applications bundle — DONE in M3.5:** the built `index.html`
      emits the literal `<base href="/">` (double quotes, root path) — Stalwart rewrites *that
      exact token* to `<base href="/{prefix}/">`, and without it deep-link reloads under
      `/mail/…` break (relative `./assets/*` would resolve against the route path). It was
      pulled forward because the service worker's scope, `start_url` and `navigateFallback` all
      resolve through `document.baseURI`. **A static host that mounts the app in a
      subdirectory must edit that one line** — document it in the guides below. Also: Stalwart
      serves `.webmanifest`/`.woff2`
      as `application/octet-stream` (ship the PWA manifest as `.json`, FR-DEP-06), and it caps
      the bundle at 100 MiB / fetches `resourceUrl` over 60 s.
- [ ] SRI documentation for deployments where files/config could diverge (NFR-SEC-03).
- [ ] Deployment guides in docs/: (1) Stalwart Application (recommended), (2) reverse
      proxy same-origin, (3) CDN cross-origin incl. the `usePermissiveCors` trade-off
      from SP.5 (FR-DEP-05). **SP.5 verified the Stalwart-Application path (v0.16.x):** there
      is no `/api/settings` REST surface anymore — an Application is a JMAP registry object
      created by `POST /jmap/` with method `x:Application/set` (WebUI *Settings › Web
      Applications* or `stalwart-cli` are equivalents). Recovery-admin HTTP Basic suffices
      (it holds `SysApplicationCreate`). Body shape (load-bearing): `resourceUrl` = the `.zip`
      URL (accepts `http://`, not HTTPS-only; keep the `.zip` extension), `urlPrefix` is an
      **object** `{"mail": true}` (single path segment), `enabled: true`; `autoUpdateFrequency`
      optional. Example: `{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["x:Application/set",{"create":{"app1":{"enabled":true,"resourceUrl":"https://…/waxwing-stalwart-vX.Y.Z.zip","urlPrefix":{"mail":true}}}},"c1"]]}`.
- [ ] `SECURITY.md` (reporting process) + threat-model document: malicious mail content,
      malicious network, shared device, hostile CDN (NFR-SEC-04).
- [ ] Compat smoke: Cyrus IMAP (JMAP) E2E smoke job to keep "any JMAP server" honest
      (NFR-QUAL-02); document known deviations.
- [ ] CONTRIBUTING.md, issue templates, `config.json` reference doc finalized against
      spec §9.
- [ ] Publish `@waxwing/jmap` and `@waxwing/jscontact` to npm (after D1 confirmation);
      README + API docs for both.
- [ ] Tag **v1.0.0**; project site/demo on GitHub Pages (decision log #1: no paid
      domains).

Done when: a stranger can deploy Waxwing on their Stalwart from the release assets using
only the guides.

**Gate G3:** release sign-off — a11y (M4.7), performance (M4.8), security docs (M4.9),
and both deployment artifacts verified on a clean Stalwart instance.

**Phase 5 exit criteria = V1 shipped.**

---

## 11. Post-V1 Backlog (V1.x parking lot)

Per spec §10 and the Could/deferred items above — **do not implement pre-V1** without an
explicit owner decision:

- Sieve filter rules UI: visual builder + raw editor (FR-SIEVE-01/02) — the headline V1.x
  feature; `@waxwing/jmap` Sieve types ship whenever first needed, at latest here.
- Saved searches as virtual folders (FR-SRCH-03 remainder).
- Snooze (FR-ORG-03), scheduled send client-side (FR-CMP-11), templates (FR-CMP-12).
- Offline search over cached subset (FR-SRCH-04).
- PWA badging (FR-NOTIF-04), notification actions (FR-NOTIF-05).
- `List-Unsubscribe` one-click (FR-RD-09), sectioned list grouping (FR-LST-08).
- Multi-account UI (FR-AUTH-07 full), unified inbox (FR-MBX-05).
- CSV contact import (FR-CON-06 remainder), auto-collected addresses (FR-CON-07).
- Community theme gallery format (FR-THEME-04).
- V2 per spec §10: Calendar, iTIP invitations, PGP, Files/Tasks integration.

## 12. Cross-cutting Workstreams (no start/end — enforced continuously)

| Workstream | Mechanism |
|---|---|
| **Size budget** | `size-limit` CI gate from P0.5; every new dependency justified in the PR |
| **i18n discipline** | en+de keys land with the feature (§2.4); extraction check automated in M4.6, applied retroactively never |
| **A11y** | component-level axe tests from M1.1; APG patterns; audits in M4.7 |
| **Security** | strict CSP from P0.2; sanitizer corpus grows with every HTML-mail bug; dependency audit (`pnpm audit`) in CI; threat model maintained from M4.9 on |
| **Testing** | levels per tech-stack §7; E2E suites grow at the end of each phase (M1.9, M2.9, M3.10); Stalwart `main` + Cyrus smoke jobs scheduled |
| **Docs & ADRs** | ADR per §2.3; deployment/config docs updated in the same PR as behavior changes |
| **Capability gating** | every optional server feature checks the session capability and degrades to hidden-not-broken (FR-SRV-02) — review in every feature PR |

## 13. Open Decisions & Owner Actions

| ID | Decision | Owner | Due | Status |
|---|---|---|---|---|
| D1 | Confirm MIT license for `@waxwing/jmap` (and `@waxwing/jscontact`) — tech-stack §4.2 "decision to confirm" | Heiko | before first npm publish (M4.9); license files land in P0.1 flagged | open |
| D2 | WebSocket in V1 core vs. post-SSE enhancement — decide on SP.3/SP.5 evidence | Heiko | Gate G1 | **decided 2026-07-10 (G1): SSE-first — WebSocket deferred to a post-SSE enhancement.** Browser WS cannot authenticate against Stalwart v0.16.11; V1 push runs on the fetch-based SSE reader (ADR-005), the WS transport stays as server-side/future-server code and auto-degrades. Revisit under D3 if a v1.0 baseline adds browser-viable WS auth. |
| D3 | Raise server baseline to Stalwart v1.0 (expected ~Oct 2026)? | Heiko | Gate G2 | open |
| D4 | Secure free namespaces early: GitHub org, npm `@waxwing` scope / package names (decision log #1 recommends) | Heiko | ASAP, independent of code | open |
| **B1** | **Known defect (found in M3.8, not fixed there): `setKeywords` leaves a keyword-filtered window stale.** M3.8 fixed the same class of bug for `move`/`destroyEmails` (the cached `queryCache` window is now pruned + its `queryState` voided in the optimistic apply). `setKeywords` was left alone deliberately: it is **bidirectional** — marking a message read must REMOVE it from an `is:unread` window, but adding a label must ADD it to a `hasKeyword` window, and a prune cannot express that. Today, marking read/unread or (un)labelling leaves a `?q=is:unread` result or a `?label=` view showing the message until the server's push echoes back — and **offline, until reconnect**. Same two failure modes as the `move` bug. Fix before **G2** (see the M3.8 changelog entry for the mechanism). | — | Gate G2 | open |
| **B2** | **Known gap (found and half-fixed in M3.9): offline, a message moved INTO a visible window does not appear until reconnect.** A cached `queryCache` window is in the SERVER's collation (and, under `collapseThreads`, its entries are thread representatives), so the optimistic apply refuses to guess an index: a departure is pruned locally, an arrival only voids the baseline and waits for a re-query. M3.9 made the ONLINE case immediate (`runReplay` now reconciles the windows the apply voided — before that, Undo looked dead for up to 60 s). Offline there is nothing to re-query, so undoing an archive offline puts the mail back server-side-eventually but the row reappears only on reconnect. Fixing it means placing the row locally — feasible for the default `receivedAt desc, collapseThreads:false` window (compare against the neighbours' envelopes), wrong for a collapsed-thread or server-sorted window. Decide scope before **G2**; a partial fix gated on the window's sort/collapse is the likely shape. | — | Gate G2 | open |
| D5 | Design-system sign-off (M1.1 doc: look, tokens, motion) before broad UI build-out | Heiko | during M1.1 | **signed off 2026-07-10.** Owner approved after two revisions: calmer accent (orange → blue `#2f6fe0`/`#5e93f0`, warm colors reserved for signals) and responsive compact controls (34px pointer / 44px touch via `--waxwing-control-min`, tightened spacing) — both WCAG-AA-verified. Broad UI build-out (M1.4+) unblocked. |

## 14. Appendix — Requirements Coverage Matrix

Every Must/Should FR mapped to its WP (Could items → §11 backlog unless listed):

| Spec area | Requirements | Covered by |
|---|---|---|
| Deployment | FR-DEP-01/02 | P0.2, SP.5, M4.9 |
| | FR-DEP-03/04 | P0.2, M1.4 |
| | FR-DEP-05 | SP.5, M4.9 |
| | FR-DEP-06 | M3.5 |
| Server compat | FR-SRV-01/02/03 | SP.1, workstream "capability gating" |
| | FR-SRV-04 | M3.7 |
| Auth | FR-AUTH-01/02/03 | SP.2, M1.4 |
| | FR-AUTH-04 | SP.1/SP.2 |
| | FR-AUTH-05/06 | SP.2, M1.4, M3.6 (push cleanup) |
| | FR-AUTH-07 (readiness) | M1.2 (full UI → backlog) |
| | FR-AUTH-08 | M4.4 |
| Mailboxes | FR-MBX-01/02/04 | M1.5 |
| | FR-MBX-03 | M3.9 |
| List | FR-LST-01–05, 07 | M1.6, M1.4 (pane layouts) |
| | FR-LST-06 | M3.9 |
| Reading | FR-RD-01/02/03 | M1.7, M1.8 |
| | FR-RD-04/05 | M1.8 |
| | FR-RD-06/07/08 | M3.9 |
| Compose | FR-CMP-01 | M2.1 |
| | FR-CMP-02 | M2.3 |
| | FR-CMP-03 | M2.6 |
| | FR-CMP-04 | M2.7 |
| | FR-CMP-05 | M2.4 + M4.3 |
| | FR-CMP-06 | M2.5 (+M2.3 inference) |
| | FR-CMP-07/08/10 | M2.8 |
| | FR-CMP-09 | M2.2 |
| Search | FR-SRCH-01/02, 03 (part) | M3.1 |
| Organization | FR-ORG-01 | M1.3/M1.6/M1.8 |
| | FR-ORG-02/04 | M3.2 |
| Notifications | FR-NOTIF-01 | SP.3, M1.3, M1.9 |
| | FR-NOTIF-02/03 | M3.6 |
| Offline | FR-OFF-01 | M3.5 |
| | FR-OFF-02 | M1.2/M1.8, M3.4 |
| | FR-OFF-03 | M1.3, M3.3 |
| | FR-OFF-04 | M3.4 |
| Quota | FR-QTA-01 | M3.7 |
| Contacts | FR-CON-01/02/04 | M4.2 |
| | FR-CON-03/05/06 | M4.3 (+M4.1) |
| Self-service | FR-VAC-01 | M3.7 |
| | FR-SIEVE-01/02 | backlog (V1.x) |
| UI | FR-UI-01/02 | M1.1 |
| | FR-UI-03 | M1.4 |
| | FR-UI-04 | M3.8 |
| Theming | FR-THEME-01/02/03 | P0.2, M1.4, M4.5 |
| A11y | FR-A11Y-01 | M1.1, workstream, M4.7 |
| i18n | FR-I18N-01/02 | P0.2, workstream, M4.6 |
| NFR perf | NFR-PERF-01/02/03 | P0.5, M1.6/M1.9, M4.8 |
| NFR security | NFR-SEC-01/02/03/04 | P0.2, SP.2, M1.7, M4.9 |
| NFR privacy | NFR-PRIV-01/02 | M1.7/M1.8, M3.6, M4.9 (docs) |
| NFR compat | NFR-COMPAT-01/02 | P0.4, M3.5, G2 |
| NFR quality | NFR-QUAL-01/02 | P0.3/P0.5, M1.9/M2.9/M3.10, M4.9 |

## 15. Changelog

| Date | Change |
|---|---|
| 2026-07-05 | v0.1 — initial plan created from spec v0.2 + tech-stack v0.2 |
| 2026-07-05 | P0.1 **done** — repo bootstrap: git init, pnpm workspace (apps/web, 3 packages, e2e), TS 6 strict base config, Biome 2.5 (lint+format+assist), AGPL root + MIT package licenses, directory skeleton, README Development section. `install`/`typecheck`/`lint` green. |
| 2026-07-05 | **ADR-001** — adopt Vite 8 (+ @vitejs/plugin-react 6, Rolldown) instead of Vite 7; tech-stack.md updated. |
| 2026-07-05 | P0.2 **done** — app scaffold: Vite 8 + React 19 (`base: './'`), `--waxwing-*` design tokens (light/dark, WCAG AA), runtime `config.json`+`theme.css` boot loader (typed, network-first), i18next en/de lazy locales + Intl helpers, strict production CSP + documented dev delta, Lucide. Booted under a path prefix (Playwright); 80.95 KB gz initial JS. |
| 2026-07-05 | P0.3 **done** — test infra: Vitest 4 workspace (`unit` node + `fake-indexeddb`, `web` jsdom + Testing Library), `axe-core` a11y helper (WCAG A/AA), Playwright skeleton (self-contained placeholder spec), one example test per level. `pnpm test` + `pnpm e2e` green; devDeps only. |
| 2026-07-05 | **ADR-002** — Stalwart dev/E2E fixture design: v0.16 has no static accounts (provision over JMAP mgmt API); unauth session is 200 anonymous (not 401); plain-HTTP localhost (no TLS); domain `waxwing.test`. Plan P0.4 smoke wording updated. |
| 2026-07-05 | P0.4 **done** — Stalwart JMAP dev/E2E fixture: `e2e/stalwart` (compose `dev`+`main` profiles, pinned v0.16.11-alpine, port 18080, ephemeral volumes, healthcheck), idempotent `fixture.mjs` provisioner (domain `waxwing.test` + admin/alice/bob/carol, shared pw), self-verifying smoke check. `pnpm e2e:server` / `e2e:server:down` verified up→provision→smoke→clean teardown; lint + typecheck green. |
| 2026-07-05 | **ADR-003** — local verify scripts now, GitHub Actions CI later (owner decision): `pnpm verify` / `verify:e2e` / `verify:all` run the same checks a CI would; GitHub Actions + branch protection deferred until a repo exists. |
| 2026-07-05 | P0.5 **done** (re-scoped, ADR-003) — local verification gate: `pnpm verify` (typecheck+lint+test+`size-limit` ≤ 300 KB gz, ~80.6 KB actual) and `pnpm verify:e2e` (`scripts/verify-e2e.mjs`: chromium + Stalwart fixture smoke + Playwright + guaranteed teardown). `pnpm verify:all` green. GitHub Actions CI / compat job / badges deferred. |
| 2026-07-05 | SP.1 **done** — `@waxwing/jmap` core: zero-dep MIT client (session discovery, `bearer`/`basic` auth abstraction, batched requests + back-references, auto-chunking against session limits, RFC 8620/8621 types + typed method registry, blob upload/download). tsup build **9.32 KB gz**; 64 hermetic unit tests + a 4/4 live integration test against the Stalwart fixture (list mailboxes, `Email/set`→back-ref query→get, blob round-trip). Review caught + fixed a chunking blocker and a split-`/set` data-loss bug. Starts Phase 1 (Spike). |
| 2026-07-05 | **ADR-004** — account-scoped auth storage from day one (FR-AUTH-07 readiness): `SecretStore` scoped by IndexedDB database name; a second account is purely additive, no migration. |
| 2026-07-05 | SP.2 **done** — auth module `apps/web/src/auth/` (oauth4webapi 3.8.6): `AuthController` (OAuth Auth-Code+PKCE + Basic behind `@waxwing/jmap` `bearer`/`basic`), `SecretStore` (secrets wrapped by a non-extractable AES-GCM `CryptoKey` in IndexedDB — never `local`/`sessionStorage`, NFR-SEC-02), memory-only access token, single-flight silent refresh, offline start, RFC 8414 discovery, `document.baseURI` redirect (FR-DEP-02), logout wipe (FR-AUTH-05). 31 hermetic auth tests (93 total) **+ live OAuth+Basic verification** against Stalwart v0.16.11 (login → `Mailbox/get` → forced refresh → logout). SP.5 findings: no client registration, no RFC 7009 revocation endpoint, opaque tokens (reused refresh), unsolicited ES256 `id_token` stripped. |
| 2026-07-09 | **ADR-005** — SSE via a fetch-based reader, not the native `EventSource`: Stalwart's SSE (and WS) endpoints authenticate only via the `Authorization` header, which `EventSource`/browser `WebSocket` cannot send; SSE uses `fetch`+`ReadableStream` with `Authorization: Bearer` (+ optional `AuthProvider.token()`), and WS is server-side-only against Stalwart. tech-stack §4.2 + FR-NOTIF-01 note updated. |
| 2026-07-09 | SP.3 **done** — push transports in `packages/jmap/src/push/`: fetch-based `SseChannel` (Stalwart SSE needs an `Authorization` header — native `EventSource` unusable, ADR-005), RFC 8887 `WebSocketChannel` (server-side-only vs. Stalwart), shared full-jitter `ReconnectLoop`, `createPushChannel` WS→SSE→polling-stub auto-select. Both deliver `StateChange` 2–5 ms and survive `docker restart`. 72+4 hermetic + 3 live tests (178 total green); push tree-shaken from `apps/web` (budget untouched at 80.55 KB gz; +5.59 KB gz in the `@waxwing/jmap` barrel → 14.91 KB gz). SP.5 answers recorded: SSE + EventSource auth mechanism, CORS default-off; WS-over-browser evidence left open for D2 at G1. |
| 2026-07-09 | SP.3 **post-review fix** — runtime transport failover (tagged SP.4 in the push suite; SP.3 stays **done**). Live footgun: the static single-transport pick left a browser on the eligible-but-401ing WebSocket forever → zero push unless the caller passed `prefer:'sse'`. Fix: `createPushChannel` now returns a `FailoverPushChannel` that connects the eligible transports (`eligibleTransports`, WS→SSE→polling) in turn and auto-degrades when one never opens (`failoverAfterAttempts`, default 2); once a transport opens its own loop owns every drop (never downgrades), the last real transport is never torn down onto the polling stub (transient blips self-heal), and `prefer` is a soft reorder consistent with `pickTransport`. Four review findings applied at root cause + locked with regression tests (terminal-transport budget, `prefer` restrict→reorder, never-downgrade mutation lock, polling-only exhaustion). Tests: hermetic push suite 29 cases (**193 total green**); +1 live case — a browser-like WS (no auth header) fails over to SSE and delivers `StateChange` with the default preference. `apps/web` budget untouched (80.55 KB gz; push still tree-shaken); `@waxwing/jmap` barrel 14.91 → **15.95 KB gz** (+1.04, just over the deferred/unenforced 15 KB library note). ADR-005 Decision/Consequences + Deciders (owner ratification pending D2) reconciled. |
| 2026-07-10 | SP.4 **done** — raw end-to-end demo. Dev-only `apps/web/src/demo/` (login/mailboxes/paged list/raw message view/`Email/parse`), gated on `import.meta.env.DEV && VITE_WAXWING_DEMO==='1'` behind a dynamic import so Rollup DCEs it — grep-proven absent from `dist/`, budget unchanged (**80.55 KB gz**). New one-command harness `pnpm demo [--lan]` (`scripts/demo.mjs` + `e2e/stalwart/seed-demo.mjs`): resolves the browser origin, brings the fixture up advertising it via the now-overridable `STALWART_PUBLIC_URL`, seeds 25 deterministic mails (plain, hostile HTML, `message/rfc822` attachment), starts Vite behind a demo-only same-origin proxy, guarantees teardown. Live-verified from a real browser (2 Playwright specs: Basic + full OAuth PKCE via Stalwart's `/login`). **SP.5 answers:** `Email/parse` **supported** (no `postal-mime` for server-held blobs; `bodyValues` must be named in `properties`), `SearchSnippet/get` supported (returns `<mark>` markup — sanitise it), `Email/queryChanges` supported but did **not** raise `cannotCalculateChanges` for a bogus `sinceQueryState` (M1.3 must not read its absence as freshness). Further findings: Stalwart ignores `Host`/`X-Forwarded-*` when advertising session/OIDC URLs; blob download requires the `Authorization` header (no `<img src>`); a plain-http LAN origin is an insecure context, so `crypto.subtle` — hence OAuth PKCE and all `SecretStore` persistence — is unavailable there (Basic works). Review: 8 findings raised, 3 confirmed and fixed at root cause (`Email/parse` missing `bodyValues`; demo i18n leaking into the production locale chunks; `pnpm demo` teardown volume-wiping a fixture it never started), 5 adversarially refuted. 214 tests green. |
| 2026-07-10 | **ADR-006** — OAuth token posture: Stalwart v0.16.11 exposes **no** RFC 7009 revocation and **no** RP-initiated logout; access tokens are opaque 1 h, refresh tokens are 30 d, **not rotated on use, reusable, and not `client_id`-bound**. Decision: Waxwing does not attempt server-side revocation; logout is a local encrypted-store wipe + natural expiry, and the AES-GCM `SecretStore` (NFR-SEC-02) is the security boundary for the refresh token. Ratifies existing `oauth.ts`/`controller.ts` behaviour; complements ADR-004/005. |
| 2026-07-10 | SP.5 **done** — spike report: all five open checklist items answered **live** against Stalwart v0.16.11-alpine (fixture), with adversarial/negative probes recorded. **(a) OIDC:** no pre-registration (arbitrary `client_id` accepted); RFC 7591 `/auth/register` open→201 but rejects `:5173` loopback ports; opaque tokens (`sw1.`, not JWT), `expires_in=3600`; refresh 30 d **not rotated / reusable / `client_id` unchecked**; **no `revocation_endpoint`/`end_session_endpoint`** (probed → 404) → **ADR-006**. **(b) Limits:** core all positive (get/set 500, calls 16, req 10 MB, upload 50 MB) so `@waxwing/jmap` fallbacks never engage and the `maxObjectsInSet:0` split-loop is unreachable; mail limits + 9 `emailQuerySortOptions` in `accountCapabilities` (top-level `mail` is `{}`). **(c) Blob:** Content-Type echoed not sniffed, `blobId` content-addressed; oversize → **400** `urn:…:error:limit` (**not** RFC 8620 §6.1's mandated 413) **plus** an unadvertised **429** per-user quota (1000 files / 50 MB, `Retry-After` ~1 h); upload `{accountId}` not authz-checked; download header-auth only, `?accept=` reflected unvalidated → fetch→`blob:`; RFC 9404 `Blob/upload` available. **(d) FR-DEP-02:** Applications mount mechanism live-verified via Stalwart's own `/admin/` Portal app (`<base href="/">`→`/admin/` rewrite on index + deep routes, relative assets resolve, `immutable` asset cache, `/seg`→302, unconditional SPA fallback); **build gap** — `apps/web/dist/index.html` emits no `<base href="/">` (source has none), so M4.9 must add it. **(e) Sharing:** `principals` (+`:availability`) and `mail:share` advertised, `myRights.mayShare` present, `principals:owner` absent, **no delegation seeded** (M4.4 fixture prerequisite); `capabilities.ts:26` mislabels the URN (RFC 9670, not "RFC 8620 §8"). D2 (browser WebSocket) evidence stays in SP.3/ADR-005, **left open for Heiko at G1**. Docs-only WP: plan §SP.5 + M4.9 + status board updated; ADR-006 added; no code changed; 214 tests still green. |
| 2026-07-10 | **M1.1 done** — design-system foundation. `docs/design-system.md` (principles, token catalog, contrast table, scales, motion, component inventory, contract). Tokens finalized with **machine-verified WCAG 2.2 AA contrast**: `contrast.ts` (WCAG relative-luminance math) + `tokens.contrast.test.ts` parse the shipped `tokens.css` and assert 21 pairs × 2 themes = **42 assertions**; the audit surfaced and fixed three real gaps — added `--waxwing-border-strong` (control boundaries, ≥3:1; `--waxwing-border` stays a sub-3:1 decorative hairline), raised dark `--waxwing-danger` (was 4.09:1 as card text), and added `--waxwing-{danger,success,warning}-contrast` labels for solid semantic fills; also added elevation tokens. **14 base components + shared primitives** in `src/ui/` (Button, IconButton, TextInput, Select [styled *native*], Checkbox, Switch, Spinner, Skeleton, Badge, Avatar, VisuallyHidden, Tooltip, Menu, Dialog, Toast, SplitPane; primitives Portal/useFocusTrap/useDismiss), public barrel `index.ts`, each with keyboard + APG-ARIA + both themes + 44px + a co-located jsdom/axe test (**96 tests**). Default user-visible strings via a new `ui.*` i18n namespace (en+de). **Dev-only gallery** (`VITE_WAXWING_GALLERY=1`, dynamic-import + DCE — prod bundle unchanged at **80.69 KB gz**); a real-Chromium **axe scan (WCAG 2.x A/AA incl. `color-contrast`) reported zero violations in light AND dark**, static page and open Dialog/Menu/Toast. **D5** (owner design sign-off) now actionable. |
| 2026-07-10 | **M1.1 density revised (D5 feedback)** — owner found the controls too bulky and the layout too airy for a phone. Clarified WCAG: the 44px minimum I had applied everywhere is AAA (SC 2.5.5); AA (SC 2.5.8) is 24px. Renamed `--waxwing-tap-target` → **`--waxwing-control-min`, now responsive**: 34px on pointer devices (compact, > AA floor), 44px on touch via `@media (pointer: coarse)` (AAA). Buttons slimmed (inline padding space-4→space-3, sm→space-2); gallery/layout whitespace tightened. Owner chose **responsive** over uniform-compact or a density switch, so a phone gains space from less whitespace, not smaller finger targets. Browser axe re-scan: `target-size` **PASS** and zero violations at 34px in both themes; 328 tests green. design-system.md §2.6 + principles updated. |
| 2026-07-10 | **M1.1 accent revised (D5 feedback)** — owner found the orange accent read as a perpetual warning. Replaced with a **calm, theme-aware blue** (`--waxwing-accent` `#2f6fe0` light / `#5e93f0` dark, matching `--waxwing-accent-contrast` and `--waxwing-focus-ring`); warm signal colors (red/orange/amber) are now reserved for warnings/errors. `branding.accentColor` is now optional: `null` (the new default in `config.json` + `DEFAULT_CONFIG`) keeps the built-in theme-aware accent, and `applyBranding` only overrides when a hoster sets a value. Contrast test + browser axe re-scan green in both themes (accent-contrast 4.70/5.54, focus-ring ≥ 4.58); 328 tests pass, 80.69 KB gz. Design-system.md tokens/contrast tables updated. |
| 2026-07-10 | **Gate G1 passed** — owner reviewed the SP.5 report and decided **D2: SSE-first, WebSocket deferred** to a post-SSE enhancement (browser WS cannot authenticate against Stalwart v0.16.11; V1 push runs on the fetch-based SSE reader). **ADR-005 ratified**; ADR-006 (token posture) noted. Phase 1 (Spike) complete → **M1 unblocked**; next `todo` is **M1.1** (design-system foundation). Also folded the SP.5-verified Stalwart-Application mount recipe (`x:Application/set` over `POST /jmap/`, recovery-admin Basic, `resourceUrl` accepts `http://`, `urlPrefix` is an object) into the M4.9 deployment-guide item. |
| 2026-07-10 | **D5 signed off** — owner approved the design system after two revisions (calm blue accent; responsive compact controls). Broad UI build-out (M1.4+) unblocked. |
| 2026-07-10 | **ADR-007** — own hash-free History-API router (base from the `<base href>` element, not `document.baseURI`) instead of react-router; React context + `useReducer` for app/session state instead of Zustand (deferred to M1.6's list view-state). Fills the router gap the tech-stack left open; neither dependency added. |
| 2026-07-10 | **M1.4 done** — app shell. Own base-path-safe router (`app/route/`, lazy `/contacts`+`/settings` chunks, `.size-limit.js` now measures the entry chunk); responsive 3/2/1-pane shell (`computePaneLayout`, folder off-canvas drawer, SplitPane divider, reading opens via history PUSH, reading-pane mode right/bottom/off pref); onboarding FSM (same-origin autoconnect / manual email→domain connect / `config.json` pin, OAuth+Basic per config, secure-context gating) in a tested reducer + `SessionProvider` holding the connected `JmapClient` for M1.5/M1.6; FR-AUTH-06 re-auth as an overlay over the still-mounted shell (silent refresh handles the common case; Basic reconnects in place, OAuth stashes route+target); FR-AUTH-05 sign-out ± remove-data (confirm); branding product name/logo/accent/links all from config (`BrandLinks`, no hardcoded "Waxwing" — guard test). **401 web/unit/axe tests**, real-browser axe of the login **clean in light+dark**, **105.5 KB gz** entry chunk. Built via a design-panel workflow (5 lenses) + a 3-fork parallel implementation + an **adversarial review workflow** that confirmed **6 defects** (Basic-reauth wiping the "stay signed in" opt-in; a non-announced login error live region; a stale OAuth stash driving a wrong-server reconnect; the closed folder drawer left in the a11y tree; focus stranded on drawer-close and on the single-pane Back swap) — all fixed + regression-tested. Follow-ups: engine sync-status stub → M1.3; live `connect()`→shell E2E → M1.9; `<base href>` in `index.html` → M4.9. |
| 2026-07-10 | **ADR-008** — replica account-scoping: **one shared `waxwing-replica` Dexie DB** with compound `[accountId+id]` keys (the plan's M1.2 spec), **not** a database-per-account (ADR-004's auth pattern). Deciding difference: the replica holds no secrets, so ADR-004's per-DB crypto-isolation rationale does not transfer, while a shared DB gives a natural `accounts` registry and keeps cross-account views (unified search/list) open. Per-account eviction = scoped bulk delete; full wipe = `db.delete()`. |
| 2026-07-10 | **M1.2 done** — local replica schema (`apps/web/src/sync/`, Dexie 4.4). Ten account-scoped tables keyed `[accountId+id]` (`accounts`/`mailboxes`/`threads`/`emails`/`emailBodies`/`blobsMeta`/`syncState`/`queryCache`/`outbox`/`localPrefs`); folder/keyword membership via derived account-scoped multiEntry indexes `amb`/`akw` (IndexedDB has no compound-multiEntry) — the ordered list renders from `queryCache.ids` (server collation), not a local re-sort. `db.ts` (schema + JMAP→row mappers + `clearAccount`/`wipeReplica`), `query-key.ts` (canonical `{filter,sort,collapseThreads}` key — order-independent filter, explicit `isAscending` default, order-preserving sort), `repo.ts` (indexed CRUD + the M1.5/M1.6 read paths), `react.tsx` (`ReplicaProvider` + liveQuery hooks). Migration policy = append-only `version()` chain (`db.ts` header). **ADR-008** for the shared-DB scoping. 29 tests (**430 total green**); size **105.5 KB gz** (Dexie tree-shaken until M1.5/M1.6 import the replica; projected entry delta ≈ **+31 KB gz** → ~136 KB, well under 300). Built via a 3-way parallel research fan-out + an adversarial review workflow. Follow-up (M1.3): wire `wipeReplica` into "Sign out & remove data". |
| 2026-07-10 | **M1.3 done** — sync engine core + action-queue skeleton (`apps/web/src/sync/engine/`). Single-writer via `navigator.locks` leader election (`leader.ts`) + `EngineBus` (BroadcastChannel, leader status only). Push-driven delta sync (`delta.ts`): `Mailbox/Thread/Email changes` with the Mailbox `updatedProperties` patch, per-watched-query `Email/queryChanges` bounded by the window `upToId` (removed-then-index-splice-added, beyond-window adds clamped), `cannotCalculateChanges`→`fullRequery`, and a periodic forceFull re-probe (SP.4 "absence ≠ freshness"). Windowed backfill (`backfill.ts`, day-stable window key, `loadMore` paging). Optimistic action queue (`outbox.ts`): apply→replay→confirm/rollback, `ifInState`, method-level vs transport error handling, `inflight` recovery, mailbox-create id + dependent-ref reconcile; actions setKeywords/move/destroy/mailbox-CRUD. A narrow `JmapPort` (`port.ts`) is the only RFC-DSL adapter, so the logic is hermetically testable. **Real polling transport** added to `@waxwing/jmap` (`push/polling.ts`, session-state polling → resync `StateChange`) replacing the SP.3 stub. Wired live: `SyncEngineHost` (starts/stops on connect, `ReplicaProvider`), `StatusRegion` (offline/error live region + non-announced syncing spinner), `SessionProvider` exposes `getAuthProvider()` and `endSession` now stops the engine + `wipeReplica`s before the auth wipe (FR-AUTH-05 ordering). Built via 3-way parallel research + a 5-fork parallel implementation + an **adversarial review workflow that confirmed 8 defects** (2 high: windowed `queryChanges` order corruption from a missing `upToId`; a poison outbox intent wedging the FIFO tail + terminal-error re-replay) — all fixed + regression-tested. **473 tests** (60 files, incl. the jmap push suite); **147 KB gz** entry chunk (Dexie + push now shipped). Live two-tab consistency / leader hand-over / offline-replay E2E deferred to **M1.9**. |
| 2026-07-10 | **M1.5 done** — folder tree (`apps/web/src/mail/`, FR-MBX-01/02/04). Pure `folder-tree.ts` (`buildFolderTree`: role mailboxes pinned in order, custom folders nested by `parentId`, orphan/cycle-safe, `aria-posinset`/`setsize`; `folderDisplayName`; `visibleRows`). `FolderTreeView` — a from-scratch APG `role="tree"` with roving `tabIndex`, keyboard nav (Up/Down/Left/Right/Home/End/Enter), localized role names + icons, live unread `Badge` + SR count, and a per-folder `Menu` gated by `myRights`. `FolderTree` container binds it to the replica (liveQuery), the router (selection + `aria-current`), persisted collapse state (`localPrefs` `folders.collapsed`), and the create/rename/delete `Dialog`s (name required / ≤255 / no-duplicate-sibling) that dispatch mailbox intents through the engine outbox (`useFolderActions`, client ids via `crypto.randomUUID`). Wired into `MailScreen`'s folder `<nav>`. Added `mailbox.*` i18n (en+de) + a `triggerTabIndex` prop on `ui/Menu` so the tree stays a single tab stop. Built via a 2-way research fan-out + a fork implementation + an adversarial review that confirmed 6 defects — a **high** WCAG 2.1.1 keyboard blocker (a stale selection could strand the tree's only roving tab stop) fixed by validating the tab stop against the visible rows (+ regression test), plus menu-button roving tabIndex, `aria-setsize/posinset`, a double-announced badge, and a non-localized dialog title. **491 tests** (63 files); 151 KB gz. Live folder-CRUD/2nd-client E2E → **M1.9**; re-nav off a temp mailbox id after the server-id swap → **M1.6**. |
| 2026-07-10 | **M1.7 done** — `@waxwing/mail-html` (AGPL): the HTML-mail security boundary (NFR-SEC-01, tech-stack §4.5). `sanitize.ts` — hardened **DOMPurify** (SVG/MathML excluded via `USE_PROFILES{html:true}`; `base/meta/object/embed/iframe/form/link/style/noscript/template` forbidden; `SANITIZE_DOM`+`SANITIZE_NAMED_PROPS`) + a per-call `uponSanitizeAttribute` remote-content firewall that blocks/records remote `src`/`srcset`/`style url()`, resolves `cid:` via a caller-supplied `resolveCid` (the sanitizer never imports jmap or fetches — SP.4 Authorization-header constraint), and permits only raster `data:image/*`. `frame.ts` — a **script-free** sandboxed-iframe renderer: `sandbox="allow-same-origin"` with NO `allow-scripts` (so a sanitizer miss cannot execute JS at all — a deliberate stricter posture than the plan's postMessage auto-height), inner `<meta>` CSP (`script-src 'none'`), conservative light theme, outer-page ResizeObserver height + anchor/`<area>` link interception. `text.ts` — plain-text renderer (escape → http(s)-only linkify → native `<details>` quote folding, script-free). Built via a 2-way research fan-out + a fork + an **adversarial XSS-bypass security review** (high-effort, per-payload verified) that confirmed **8 real bypasses** — a **high** ReDoS in the inline-style `url()` regex (cubic backtracking → main-thread freeze on mail open) plus CSS-hex-escape scheme hiding, `image-set()`/`cross-fade()` bare-string images, malformed-`url(` leaks, `<area href>` link escape, a `100vh` ResizeObserver height loop, unbounded quoted-text recursion, and an un-revalidated `cid` resolver output — **all fixed fail-closed** (inline styles drop wholesale on any residual danger; linear ReDoS-safe regex; depth/height/length caps) and regression-tested, with the CSS firewall tested DIRECTLY (jsdom normalizes `style` and masks these attacks). dist **18.5 KB gz** (DOMPurify bundled); **529 tests** (67 files, +38). apps/web budget untouched (mail-html enters the app bundle at M1.8). Wiring into the reading view → **M1.8**. |
| 2026-07-11 | **M2.7–M3.1 independent review + remediation** (see **ADR-009**). The M2.6 fork over-ran its brief and committed **M2.7** (attachments/inline images), **M2.8** (send pipeline + undo-send), **M2.9** (write E2E suite), **M3.1** (search) to `main` with only its own self-reviews. The owner chose to **keep** the work and directed an **independent adversarial re-review** (read-only agents told not to trust the self-reviews) + first-party review of the send path and the snippet renderer, then **"fix everything now."** The **snippet XSS boundary was independently re-derived SAFE** (escape-then-re-allow-bare-`<mark>`; no attribute/tag survives). Fixed every confirmed defect (full list in ADR-009): **HIGH** — engine-inactive `send()` silently dropped mail while returning `{ok:true}` (now returns `engineUnavailable`, draft untouched); a submission rejected after the undo grace was invisible until reload (now a live `useSendErrorNotifier` toast + reopen, `DraftRow.errorKind` separates send- from save-errors). **MED** — composer DOMPurify hook leaked into the reading-side sanitizer of untrusted mail (now an isolated `DOMPurify(window)` instance); a server-rejected search filter crashed every sync pass and stalled the outbox (per-key `try/catch` in `reconcileWatched`); HTML-only outgoing mail (now `multipart/alternative` with a text/plain part); Send not gated on invalid pills / over-budget attachments; a rejected send orphaned/duplicated the server draft (adopt the sibling `Email/set` id). **LOW** — undo-send sub-ms race (both sides now single `rw` txns), identity `replyTo`/`bcc` applied, inline-image phantom-prune + close-eviction + close-mid-upload guard + non-retryable-Retry suppression + toast-every-error-code, calendar-overflow dates rejected, `aria-live` result count, `search.hint` wired, value-stable snippet fetch, cross-folder result opens under a real containing folder. **Owner decisions:** undo-send **10 s** (Apple; `undoSendSeconds` clamped 0–30, was 15); search-history/saved-searches/advanced-modal/offline-search **stay V1.x**. `pnpm verify` green — **861 tests** (+9), **193.67 KB gz** entry. NOTE: §15 rows for **M1.8–M3.1 were not appended by their sessions** (their per-WP sections + the §3 status board are current); not backfilled here. |
| 2026-07-11 | **M1.6 done** — virtualized message list (`apps/web/src/mail/`, FR-LST-01…07, FR-ORG-01). `MessageList` binds TanStack Virtual to the replica's server-ordered `queryCache` window (kept fresh by the M1.3 engine) and hydrates ONLY the visible slice (`useEmailWindow`) so a 100 k-message window never bulk-loads. New engine seam `SyncEngine.watchWindow(mailbox, {sort, collapseThreads})` (computes the key synchronously via a generalized `windowQueryKey`, adopts/backfills, keeps it in the watched set) + an observable `useActiveEngine` (`setActiveEngine` now notifies) so the list re-watches the moment the engine starts. `MessageRow` (Avatar initials, sender/subject/preview, `formatMessageTime` relative→weekday→date, unread/flagged/attachment/answered indicators with SR labels), a pure `message-selection.ts` reducer (click / shift-range / ctrl-toggle / select-all-in-folder over the query id-set), a bulk bar (read/unread, flag, archive/junk/trash via `useMailboxByRole`, delete-with-confirm → `useMessageActions` → outbox), sort (date/from/subject/size + unread-first, each its own watched query) / density / flat-vs-threaded toggles (persisted). Wired into `MailScreen`; `list.*` i18n (en+de); `e2e/stalwart/seed-large.mjs` (`pnpm seed:large`, chunked `Email/set`) seeds a 100 k "Large" mailbox for the M1.9/M4.8 perf pass. Built via a 2-way research fan-out + a fork + an adversarial review that confirmed **16 defects (4 high)** — a broken/lost roving focus under virtualization (fixed by the **aria-activedescendant** grid model), move-type bulk actions not clearing the selection (→ dual archive+trash membership), a `watchWindow`↔`setActiveEngine` start-order race (perpetual spinner on a deep-linked folder), and positional row-hydration painting a neighbour's data during scroll — all fixed + regression-tested. **553 tests** (70 files, +6 M1.6 regressions); **163 KB gz** (+~12 KB TanStack Virtual, well under 300). Live 100 k 60 fps + 500-message bulk-move-syncs measurement → **M1.9/M4.8**. |
| 2026-07-12 | **M3.2 done** — keywords/labels + folder cleanup (FR-ORG-02/04). Gmail-style labels over JMAP custom keywords (which have no server registry): a curated `localPrefs['labels']` registry (`{keyword,name,color}`, mutated via an `updateLabels` Dexie `rw` read-modify-write) MERGED read-only with keywords discovered on cached mail (the `akw` index) so a label created in another IMAP/JMAP client surfaces (gray). The wire keyword is an immutable IMAP-safe slug (`label-model.slugKeyword`; leading-`$` rejected, so no system-keyword collision); **rename edits the display name only** (keyword immutable, no messages rewritten); **delete is non-destructive by default** (registry entry only) with an optional chunked keyword-strip; adopting a discovered keyword keeps its EXACT wire form (no re-slug). Assign via a three-state `LabelMenu` whose membership is computed from the replica over ALL selected ids (hydrating missing envelopes via `fetchEnvelopes`, not the visible slice) — in the bulk bar, the reading view, and an `l` shortcut; browse via a `/mail?label=<keyword>` route on the M3.1 `hasKeyword` query-window seam (`label` wins over `?q=`); per-row colored swatches (7 Apple-flag `--waxwing-label-*` theme tokens); a sidebar `Labels` section (APG tree). Cleanup: engine `emptyMailbox`/`deleteOlderThan`/`trashOlderThan` page ALL matching ids oldest-first (total-driven termination — a short page never stops a purge early) then enqueue chunked `destroyEmails`/`move` outbox intents sized to `maxObjectsInSet`, never `ifInState`; **delete-older-than MOVES to Trash for a normal folder (recoverable) and destroys only in Trash/Junk**, so a message multi-filed elsewhere is never permanently destroyed everywhere; day input clamped 0–3650. Built via a read-only Plan-agent brief → a guarded implementation fork (no-commit, single-WP) → an **adversarial review** that confirmed **9 real defects** (2 MED: bulk tri-state read only the visible rows so a large select-all could silently mis-toggle a label + the `l`-menu lost keyboard focus; 2 MED destructive-op: short-page under-collection + the all-mailbox-destroy foot-gun → move-to-Trash semantics; plus plurals, discovered-keyword case desync, unbounded day input) — all fixed + regression-tested; the snippet XSS path was re-confirmed safe. Owner decisions: non-destructive delete + optional strip; per-row swatches. i18n en+de. **+45 tests (906 total, 108 files); 198.95 KB gz entry.** **Deferred to M3.10:** the live labels round-trip with another client + the thousands-message purge E2E. |
| 2026-07-12 | **M3.3 done** — offline outbox hardening + conflict UX (FR-OFF-03: **never silent data loss**). The replay path is the highest-risk code in the app; an independent audit of the M1.3 queue confirmed **8 defects**, all fixed here. **The core change is a DURABLE UNDO:** `applyOptimistic` no longer returns an in-memory `Rollback` closure (deleted, with `SyncEngine.rollbacks` and `ReplayOptions.rollbacks`) but an `OutboxUndo` *value* persisted on the row — so `status==='error' && undo!=null` means "a rollback is still OWED", and `drainOwedUndos` retries it at the start of every pass. A rollback now survives a reload, a tab hand-over and an hours-long outage, and the leader can roll back an action a FOLLOWER dispatched. A destroy's undo is a *re-fetch of the rejected ids* (they still exist server-side precisely BECAUSE the destroy was rejected): ~26 bytes, and it self-corrects a partial rejection for free. **Defects:** D1 `rejection()` returned only the FIRST `SetError` and the caller rolled back the WHOLE intent — a 500-id destroy with one `notFound` restored all 500; now `rejections()` returns a per-object `Map` and `applyUndo(…, onlyIds)` undoes only the failed ids, leaving the succeeded ones applied. D2 `notFound` on a destroy is `satisfied` ("already gone server-side" ⇒ the optimistic delete was RIGHT), not a rollback + dead-letter that resurrected the message. **D3 (the worst): a transient failure past `maxAttempts` rolled back AND dead-lettered — five offline/online flaps silently destroyed a queued action.** That branch is gone: a transient failure (network/`TypeError`, 5xx, 429, `serverFail`/`serverUnavailable`, per-object `rateLimit`, and anything we cannot PROVE is permanent) backs the row off (`backoff.ts`: half-jittered 2 s→5 min; a `Retry-After` wins, clamped to 15 min so a hostile header cannot park the queue) and leaves it `pending` — forever if need be — reported as `EngineStatus.stuckActions` but never discarded. `JmapHttpError` gained `retryAfterMs` (a 429 with a non-problem body carried no hint). D4 `pendingOutbox` counted `error` rows, permanently inflating `pendingActions`; it now returns `pending`+`inflight` only, with new `failedOutbox`/`queuedSends`/`outboxRow` reads. D5 `rewriteIntentTarget` rewrote a mailbox intent's *parent* but not its SUBJECT id, so create-then-rename-a-folder-offline replayed the rename against the temp creation id (bogus `notFound` + an orphaned server folder); `reconcileCreate` also skips `inflight` rows now. D6/D7 the persisted undo + a new `EngineBusMessage` `wake` type: a follower's action (a SEND, possibly) no longer waits for the leader's next push event or 60 s sweep. D8 the hardcoded English `'interrupted before confirmation — may or may not have sent'` was persisted into `DraftRow.lastError` and regex-matched by the notifier — it is now the CODE `sendInterrupted`, and `use-send-error-notifier` maps stable `SetError`/`ConflictCode` values to i18n keys exactly instead of regexing prose. **Conflict detection:** new pure `conflict.ts` — `classifySetError`/`classifyThrown` → `retry` / `refresh` / `satisfied` / `conflict` + 11 stable `ConflictCode`s (never prose: the row is persisted, so stored English would freeze the language at write time). `ifInState` guards **`Mailbox/set` only** (rename/move/delete): the Email state is account-GLOBAL and advances on every inbound message, so guarding `Email/set` would turn every offline replay into a conflict — and the auto-chunker throws on a state-guarded set over `maxObjectsInSet`, which would break every M3.2 bulk chunk. A `stateMismatch` auto-resolves by re-syncing mailboxes and re-executing against the fresh state, bounded to 3 rounds by a PERSISTED `refreshes` counter (so a server that always mismatches cannot spin forever across reloads), then surfaces as `stateConflict`. **Reconnect storms:** replay is split out of sync (`requestReplay()`, coalesced under the same guard as `sync()`), so dispatching N cleanup chunks flushes a LOCAL queue in ONE pass instead of N full delta round-trips; `online` bursts are debounced (750 ms) into a single pass; and a transient DELTA failure no longer skips `replayOutbox` (it used to starve the outbox — a queued send sat unsent while one `Email/changes` kept failing). Intent-level coalescing is a deliberate NON-goal (merging two `setKeywords` over overlapping id sets reorders user intent). **UX:** new `outbox/` module — a gentle `warning` toast per newly-surfaced conflict with ONE action ("Keep in Inbox" = accept the rollback / "Try again" / OK), **plus** a persistent header affordance (hidden at zero) opening a lazily-imported problems dialog (retry / discard / discard all) because a toast alone auto-dismisses and that is not "never silent loss"; a `stuck` line in the polite `StatusRegion` (offline > error > stuck); durable `QueuedSends` chips ("Will send when you're back online", "Retrying…") with Cancel. `cancelSend`'s `notBefore` clause is DROPPED — the only safety property is "the submission has not been dispatched", i.e. `status==='pending'` enforced transactionally against replay's claim-to-`inflight`; the old check added zero safety and made an offline-queued or backed-off send uncancelable. `retryFailed` bails while an undo is still owed (else the optimistic change would be applied twice) and never re-queues a send (EmailSubmission is not idempotent). **No Dexie version bump** — every new field (`undo`, `conflict`, `nextAttemptAt`, `refreshes`) is optional, non-indexed and served by the existing `[accountId+status]`/`[accountId+createdAt]` indexes (precedent: `DraftRow.errorKind`, M2.8); the policy note in `db.ts` now says so explicitly. **Chaos tests are HERMETIC** (`engine.chaos.test.ts`: a virtual clock, a driven online flag, an in-memory server the test mutates mid-flight, `random: () => 0`) — zero lost actions + exactly-once under 30 flaps, concurrent folder-deletion/message-destruction under a queued intent, reconnect-storm dedup, cleanup-burst coalescing, durable replay across a restart, offline-send cancel, follower wake; they run in ~1.4 s. The LIVE Playwright offline/chaos suite stays **M3.10** (which already owns "wire the chaos tests from M3.3 into CI"). i18n en+de (`outbox.*`, `status.outbox.stuck`, `compose.sendErrorInterrupted`). **Independent adversarial review — 6 further confirmed defects, all fixed + regression-tested:** **(HIGH) double-send** — a thrown network error on a `sendEmail` was treated as transient and RE-SENT, though the submission may already have reached the server (the response can simply be lost); now dead-lettered as `sendInterrupted` like a stranded one (`EmailSubmission` is not idempotent), with both a unit test and a new chaos scenario. **(HIGH)** `isAuthExpiry` matched only `JmapHttpError`, so a 401 in a JSON problem body (`JmapProblemError` is a sibling class, not a subclass) was misread as a per-action conflict and **dead-lettered + rolled back the ENTIRE queue** with no re-auth. **(MED)** a MIXED per-object rejection silently dropped the TRANSIENT objects — now any transient failure wins and the whole (idempotent) row backs off. **(MED)** a non-5xx transport status (moved endpoint, proxy 400) destroyed the queue — transport-level errors prove nothing about an individual action, so they are transient. **(MED)** `discardFailed`/`cancelSend` did not wake the leader, whose stale counts overwrote the badge cross-tab. **(MED)** the chaos fake checked online-ness BEFORE its side effect, so "applied server-side, response lost" was unsimulatable and the suite could never have caught the double-send — a lost-response mode + a send scenario were added. Plus: a real (rare) test flake turned out to be a genuine bug — the conflict toast is fired once and never re-rendered, so firing it before the mailbox names loaded permanently degraded "Keep in Inbox" to a bare "OK"; the notifier now waits for its data. German strings switched from `du` to the app's `Sie` register (also retro-fixing M3.1/M3.2 strings). **+92 tests (998 total, 116 files); entry chunk 196.7 KB gz** (the dialog is a separate 0.69 KB lazy chunk). **Discharges both ADR-009 debts** (persisted rollback across reload/tabs; follower wake). |
| 2026-07-12 | **M3.4 done** — cache policy & storage management (FR-OFF-02/04). **Two BESTAND defects surfaced before a line was written:** `blobsMeta` was a **dead table** — `repo.putBlobMeta`/`getBlobMeta` existed with **zero callers**, so attachments and inline images were re-downloaded on every open and "LRU eviction of bodies/**attachments**" had nothing to evict; and `repo.deleteEmails` deleted only from `db.emails`, so every delta-synced destroy **orphaned its body forever** (a 500-message purge left 500 bodies). Both fixed: `deleteEmails` cascades in its own `rw` txn, and a **write-through blob cache** (`blob-cache.ts`; 10 MB/blob cap measured on the DOWNLOADED bytes, not the server-reported `size`, so a lying server cannot get a 45 MB blob persisted; cached only for a blob the user explicitly opened) makes the FR-OFF-04 promise real. **Dexie v5** — the first genuine bump since M2.6, and the migration-policy note in `db.ts` now records why: `bytes` is **INDEXED** (`[accountId+lastAccessedAt+bytes]`), so the "additive, optional ⇒ no bump" rule does **not** cover it — IndexedDB omits a record lacking an indexed key path from that index **entirely**, which would make every legacy row invisible to metering *and* to eviction. v5 also adds a multiEntry `ablob` (blobId → owning body), without which there is no link from a cached blob back to its message and a pinned folder's attachments cannot be protected. `BlobMetaRow.data` is an `ArrayBuffer`, not a `Blob` (a jsdom `Blob` does not survive `structuredClone` — it round-trips as `{}`, silently losing the bytes and making the cache untestable); the MIME type is re-applied on rehydration. **Architecture:** the planner (`eviction.ts`) is **PURE** — no Dexie, no clock, no I/O — so every hard invariant is a unit test over a plain function rather than an integration test over a database; the I/O pass (`maintenance.ts`) is gather → plan → chunked `rw` deletes (`EVICT_CHUNK = 200`, a failing chunk stops its stage and never the pass). **`outbox` and `drafts` are unreachable BY CONSTRUCTION** — no maintenance transaction names either table — and everything they REFERENCE is protected first: every `emailId` of every intent (incl. an **`error`** dead letter, whose undo may still re-fetch them), every draft's attachment blobIds (an evicted one would ship a queued send with a broken attachment), reply sources, pinned folders, the open message. Order is load-bearing: reap stale windows → evict (orphans → blobs → bodies, oldest-first, ties by larger row) → prune envelopes past `cacheDays` + 7 d grace that NOTHING references → drop threads whose members are all gone → top up the pins. `navigator.storage` sits behind ONE injectable seam (`storage.ts`), so the whole suite is hermetic (fake-indexeddb has no StorageManager). **Owner decisions:** the pin **exempts AND prefetches** (≤ 100 bodies/pass, leader+online only, stops at the watermark — exempt-only would mean a folder "kept offline" in which only the messages you happened to have opened are actually there); envelopes **are** pruned (FR-OFF-02 promises an index of the recent N days, and delta sync only ever adds); `cacheDays`/`maxStorageMB` stay **deployment config**, displayed read-only (a user override is M3.7); **`persist()` on install is handed to M3.5**, which owns `appinstalled` — its checklist now says so. **The independent adversarial review confirmed 5 further defects, every one of them invisible to a green build — all fixed and regression-tested.** **(HIGH) a pressured pass deleted the ENTIRE body/blob cache, on every pass:** `planEviction` seeded its usage with **envelope bytes it can never free** (only the prune can), so as soon as the envelopes alone exceeded the target — the *normal* state, not a corner: 20 000 envelopes ≈ 24 MB against a few MB of opened bodies — the loop drained BOTH lists to completion and still missed the target, and the next pressured pass re-wiped whatever had been cached since. The comment claimed "it converges"; it converged on an empty cache. The loop is now driven by the EVICTABLE pool alone, and a pressured pass frees a **bounded** share (~20 %, floored at `MIN_EVICTABLE_BYTES` — 6 MB of mail is not what filled a 900 MB origin). **(HIGH) the orphan classifier deleted live attachments:** it decided "garbage" from a body snapshot taken several awaits BEFORE the owner map was read from the live `ablob` index, so a body cached in that gap (the user had just clicked the message) had no owner in the snapshot — and orphans are dropped with **no budget check at all**. The rule is now the pure, separately-tested `classifyBlobOrphans`: a blob is garbage only when it has **no owner at all**, or **every** owner is itself an orphan. **(HIGH) a full disk left the reading pane spinning forever:** the pane is local-first — it renders from a liveQuery over `emailBodies` — so a body that could not be persisted simply never appeared, `loading` stayed true, and the effect never retried; every message the user opened would spin, permanently. `fetchBody` now RETURNS the un-storable body and `useMessageBody` renders it from memory, which is what "caching is best-effort and must never fail the read" was always meant to mean. **(HIGH) the envelope prune could delete the results of a search that was still loading:** the pass built its referenced-id set from a window snapshot read at the TOP of the pass but its prune candidates several stages later — and `backfillQuery` makes a **network round-trip** (`fetchThreadsFor`) between writing its envelopes and writing its window row, so the gap is hundreds of milliseconds, not microseconds. Fixed in BOTH halves, which makes the invariant *provable*: the backfill now persists the window row **before** the envelopes it lists (a claim can never be younger than what it claims), and the pass re-reads the windows **after** the candidates. Therefore any envelope old enough to be a candidate had its window written earlier still, and the pass sees it. **(MED)** quota recovery COALESCED into an in-flight pass that had been planned with `needBytes: 0` and had already run its eviction stage — so it freed nothing, the retry hit `QuotaExceededError` again, and the user was told the disk was full while megabytes of evictable rows sat there. **Plus:** `chooseBudget`'s floor overrode the quota cap (a 10 MB-quota origin was handed a 50 MB budget — five times the space it may use — so budget-driven eviction could never fire), **and its test asserted that as correct**; the v5 `.upgrade()` could **THROW** on a legacy row with a malformed `bodyValues`, and a throw inside `modify()` aborts the upgrade transaction, which makes `db.open()` reject **on this start and every start afterwards** — a permanently bricked app, the one truly unrecoverable failure in the WP (both estimators are now total, and each row transform is additionally wrapped); the pin prefetch had no abort check (sign-out could block on up to 100 request timeouts) and returned on its FIRST failure, so one server-side-destroyed message starved every id behind it forever; and "Free up space now" reported the **plan's** bytes rather than what was actually deleted, and counted no pruned envelopes — a pass that dropped 5 000 aged-out envelopes toasted "Nothing to free up". **Four tests were rewritten** because they asserted a count where a total wipe would pass just as happily, or encoded a defect as the expected behaviour. i18n en+de (`settings.offline.*`, `mailbox.actions.keepOffline*`, `status.storage.full`); a11y: native `<progress>`, a `<dl>` breakdown, the pin inside the existing APG menu. **+96 tests (1094 total, 121 files); entry chunk 207.22 KB gz** (the Settings section is inside the existing lazy `/settings` chunk). |
| 2026-07-12 | **M3.5 done** — PWA: manifest, service worker, offline shell, updates (FR-OFF-01, FR-DEP-06, tech-stack §6). **A BESTAND defect blocked the whole WP and had to be fixed first:** the built `index.html` emitted relative asset URLs (`base:'./'`) with **no `<base>` element**, so on any plain static host — FR-DEP-01, a *Must* — a deep-link reload of `/mail/inbox/42` resolved `./assets/index-*.js` against the ROUTE path. Confirmed empirically against the real bundle: the SPA fallback answers `200 text/html` and the browser refuses it as an ES module. **White screen.** `config.json` (via `document.baseURI`) and the OAuth `redirect_uri` misresolved identically. It was invisible only because Stalwart injects a `<base href>` and every E2E starts at `/` — and a service worker turns it from a rare bookmark bug into the *guaranteed* path, since `navigateFallback` answers every offline deep link with `index.html`. SP.5 had already written down the exact fix (a literal `<base href="/">`, scheduled for M4.9), so it is **pulled forward, not invented**; a static host mounting the app in a subdirectory now edits that one line. **Stack:** `vite-plugin-pwa` 1.3 + Workbox 7.4, **`injectManifest`** — M3.6 must add `push`/`notificationclick`/`pushsubscriptionchange` to the same `src/sw/sw.ts`, and `generateSW` would have forced an untyped, unbundled `importScripts` side-file. Compatibility with Vite 8 / **Rolldown** (ADR-001) was the one genuine show-stopper risk and was smoke-tested before anything else was written: it builds, and the emitted worker is fully bundled with **zero ESM syntax**, so it registers as a CLASSIC worker (no `{type:'module'}` cliff in Firefox). The worker compiles in its own program (`tsconfig.sw.json`, `lib: WebWorker`), so **no test file may live in `src/sw/`** — every rule worth asserting is a pure function in `src/pwa/sw-routes.ts`. **Owner decisions:** the **manifest is a hoster-editable deployment file** (`public/manifest.json`, network-first, never precached), not a build artifact — FR-DEP-04 ("the same build artifact serves all installations; no rebuild for rebranding") is a Must, and a white-labelled install whose home-screen icon reads "Waxwing" breaks it. That also turned out to be **forced**: whenever vite-plugin-pwa owns the manifest it appends it to `additionalManifestEntries`, which workbox-build applies *after* `manifestTransforms`, so no option can keep it out of the precache — and a precached copy would shadow the network-first route and freeze the rebrand until the next release (verified in the library source, then on the built `sw.js`). Install guidance is **one account-menu item + a per-platform dialog** (Chromium's captured `beforeinstallprompt`; iOS has no such event, so Share → Add to Home Screen plus the note that Web Push needs the home-screen install) — no banner, no nag. `registerType: 'prompt'`: `autoUpdate` would activate a new worker under a live tab, drop the old precache and 404 that tab's next lazy chunk, and the routes, the composer and the dialogs are all lazy. **`skipWaiting()` runs only on the user's word**, `clientsClaim()` never. **Security:** the invariant *the worker caches zero bytes from JMAP* is **structural, not a denylist of guessed paths** — every cache predicate is anchored to the worker's own directory (`self.location`). A download URL's path comes from the SERVER's session object and its last segment is the ATTACHMENT FILENAME, chosen by whoever sent the mail; a basename test would hand an attachment named `config.json` straight into Cache Storage — plaintext, outside the AES-GCM SecretStore (NFR-SEC-02), outside M3.4's eviction budget, and surviving a plain sign-out. FR-SRV-01 promises "any JMAP server", so "Stalwart puts downloads under `/jmap/`" is not a guarantee we may assume. **The independent adversarial review found 8 further defects, every one under a green build.** **(HIGH) the runtime caches were never filled at all:** with `clientsClaim()` correctly absent, the page that registers the worker is never *controlled*, so its `config.json` / `theme.css` / `branding/*` fetches never reach the `fetch` handler — and the first controlled load of a freshly installed PWA is, typically, its first **offline** launch. It would find both caches empty and boot on `DEFAULT_CONFIG`: no hoster branding, no theme override, broken icons — FR-DEP-04 and FR-THEME-01/02 quietly defeated *inside* the promise of FR-OFF-01. The worker now **warms both caches at install**, through the strategies (so the expiration bookkeeping stays honest) and under `allSettled` (so a deployment that ships no `theme.css` cannot abort the install and cost us the precache). Verified in a real browser. **(HIGH) the `<base href="/">` fix broke the skip link**, reproduced in jsdom: a bare `#main` resolves against the mount root, so on `/mail/inbox/42` the **first tab stop** for a keyboard or screen-reader user navigates to `/` and reloads the app instead of jumping to the content. **(HIGH) the new chunk error boundary did not cover the composer** — it wrapped only the route `<Suspense>`, while `ComposerHost` and the header's dialogs sit on their own boundaries, and after a deploy the composer is the *first* lazy chunk most people load. A mutation test settles it: with the boundary back inside `<main>`, the failing chunk **unmounts the entire application** — the sibling tests can no longer even find the navigation. **(HIGH) a rejected draft flush stranded the user permanently:** `await flushOpenDrafts(); activate()` over a `Promise.all`, so a flush that rejects — a full disk, which is precisely the state M3.4's storage notifier exists for — swallowed the `activate()`; the toast had already dismissed itself on the click, and the latch meant the offer never came back. On the `controllerchange` path it was worse: the tab kept running stale code while the new worker had already swapped the precache under it. **(MED)** the worker was registered from `AppShell`, i.e. **only after a sign-in** — a first-time visitor precached nothing (no offline shell) and Chromium, whose installability check needs a registered worker, offered no install on the sign-in screen; it now registers above the auth gate. **(MED)** `beforeinstallprompt` was captured in a component effect, but it fires **once**, is never replayed, and on a repeat visit Chromium fires it while the boot is still awaiting `config.json` — the install offer would simply never appear; the capture moved into `main.tsx`, before the first `await`. **(MED)** the registration's listeners were never removed and the browser hands back the **same** `ServiceWorkerRegistration` object, so a sign-out → sign-in stacked one update toast per session. **(MED)** the boundary never reset, so one broken screen left the panel up forever and the navigation looked dead. **Plus:** an update was offered to an **uncontrolled** page (a shift-reload), where `skipWaiting()` re-parents only the *outgoing* worker's clients — that toast could never have reloaded anything, and clicking it would have done visibly nothing; workbox-routing silently installs a **second, undeclared `message` listener** (`CACHE_URLS`, verified in the emitted bundle) that the worker's own comment claimed did not exist — it is bounded by the scope-anchored predicates, and now documented rather than denied; and the new `loadConfig` deadline had a test that **still passed with the deadline deleted** (it threw the `TimeoutError` itself). **Four tests rewritten** for asserting a count where a total failure would pass, or encoding a defect as the expected behaviour. **Also fixed here, because the worker made them unavoidable:** the app had **no `ErrorBoundary` anywhere**, and `loadConfig()` had **no timeout** while `main.tsx` awaits it before rendering a single pixel — a captive portal left the app blank forever. Icons are committed PNGs (192 / 512 / maskable-512 / apple-touch-180) rendered by `scripts/icons.mjs` through the Playwright Chromium the E2E suite already installs — no `sharp`, no native toolchain; the maskable variant is a separate SVG because the plain icon's artwork reaches outside the spec's 80 % safe circle and Android would crop it. i18n en+de (`pwa.*`, Sie); a11y: the update toast reuses Toast's existing live regions (no second `aria-live`), the install dialog the existing `ui/Dialog`. **+81 tests (1175 total, 130 files); entry chunk 209.17 KB gz.** |
| 2026-07-13 | **M3.6 done** — notifications + preferences (FR-NOTIF-01/03, NFR-PRIV-01/02), **rescoped by its own central finding: no JMAP server in existence can deliver a Web Push to a browser** (**ADR-010**). This was proved on the wire, not inferred. Chromium refuses `PushManager.subscribe()` without an `applicationServerKey` (`AbortError: Registration failed - missing applicationServerKey`, reproduced on the real engine) and WebKit throws `NotSupportedError`; supplying a key binds the endpoint to a VAPID signature that the server must then produce (RFC 8292 §4.2). **No JMAP server implements RFC 9749** — the Standards-Track capability (`urn:ietf:params:jmap:webpush-vapid`, March 2025) that would publish that key: Stalwart returns zero `vapid` hits at **both** v0.16.11 (the pinned fixture) and v0.16.13 (latest), Cyrus does not support `PushSubscription` at all, and Apache James's VAPID PR was closed unmerged. And Stalwart **base64-wraps the aes128gcm ciphertext** while `Content-Encoding: aes128gcm` promises the raw octets (RFC 8188), so the payload is undecryptable in **every** browser — which closes the one door left open, Firefox being the only engine that would have accepted the unsigned POST at all. Captured live: a CA minted for the fixture, an HTTPS listener on the host, and Stalwart's actual POST read off the wire — `content-encoding: aes128gcm`, **no `Authorization` header**, body `"0m-mFr7336M5fHU1TOs9YAAAEABB…"` (ASCII), which fails to decrypt as aes128gcm and decrypts perfectly *after* undoing the base64 into `{"@type":"PushVerification",…}`. Everything else in Stalwart's chain is correct — the verification round-trip and `StateChange` delivery both ran clean — so the fault is **two lines** at the HTTP layer, and the base64 bug also explains upstream #3169 ("verify successfully but never deliver StateChange"), closed by a bot without triage. Three upstream reports written up in `docs/upstream/`. Spec and tech-stack corrected: FR-NOTIF-02's claim that *"Stalwart supports this natively"* is struck and replaced by the server precondition. **Owner decision: build nothing that cannot be verified against a real counterpart.** So M3.6 ships the same notifications from the **live push channel** (ADR-005's SSE reader, already feeding the sync engine) — i.e. whenever the app is running, a backgrounded or minimised tab included — plus the full FR-NOTIF-03 preference surface (per-folder, quiet hours incl. crossing midnight, preview on/off, sound on/off), the permission flow, and a capability probe that states plainly what this server cannot do (NFR-PRIV-02). **The "new mail" signal had to be rebuilt before any of it could be correct:** `drainChanges` folded `Email/changes`'s `created` into `updated`, so a `$seen` flip, a move or a label edit from another client was indistinguishable from an arrival; `syncEmails` now returns the created envelopes, and it is the **only** seam — `putEmails` is also called by the `forceFull` re-probe and by every backfill page. **An adversarial review found 12 defects under a green build, and — sharper — four MUTATIONS that destroy a stated guarantee while leaving every test green.** **(HIGH) notifications survive sign-out.** The OS owns them: across sign-out, across reload, across a browser restart. "Sign out and delete local data" wiped IndexedDB while banners carrying sender and subject sat in the notification centre for the next person at the machine, and clicking one still deep-linked into the mailbox just abandoned. FR-AUTH-05 promised otherwise. **(HIGH, tests) the floor test asserted nothing.** "passes a floor stamped at leadership, so pre-session mail can never notify" checked only `sinceMs > 0` and `now >= sinceMs` — vacuous under the incrementing fake clock. Moving the stamp into `runSyncPass`, i.e. **destroying the floor entirely**, kept all 86 tests green. **(HIGH, tests) the mid-pass leadership re-check had zero coverage** — the guard whose own docblock calls it "a bug someone would otherwise ship" could be deleted with every test still passing. **(MED)** `isAppClient` filtered **nothing** at the recommended root deployment: `startsWith('/')` is true of every page on the host, so a notification click could focus Stalwart's own admin portal, post it a route it ignores, and open no mail window at all; it now also requires `matchRoute` to recognise the path. **(MED)** a rejected `focus()` escaped `waitUntil` and took the `openWindow` fallback down with it — the user clicks the banner and *nothing* happens. **(MED)** the registration is published the moment `register()` resolves, which is **before** the worker activates, and `showNotification()` rejects on a registration with no active worker — swallowed by `allSettled`, so the first mail of a fresh session was silently never announced. **(MED)** a client clock running **fast** suppressed every notification for the length of the skew, with no error and no diagnostic (the floor is the *client's* clock; `receivedAt` is the *server's*) — the floor is now clamped to the newest `receivedAt` the replica already holds, which is a timestamp in the server's own units. **(MED)** the foreground guard asked only the **leader's** tab — but leadership is a sticky Web Lock, so the leader is the tab opened *first*; open a second tab and work there and you are bannered about mail you are watching land. It is now a query/ack over the existing `EngineBus`: the leader asks, any focused tab answers, silence is the "no" — no heartbeat, no TTL, and a crashed tab simply does not reply. **(MED)** the burst cap was applied per **pass**, but push fires a pass per `StateChange`: a mailing list delivering 20 messages 2 s apart produced **20 banners** and never once tripped the cap it is named for; it is now a rolling 60 s budget with a summary that accumulates across replacements. Plus an unguarded `email.keywords` deref that lost a whole pass's notifications silently (the codebase does not trust the server here — `toEmailRow` guards, this did not), and a dismissed permission prompt that bounced the switch back with no explanation at all. **Verified in a real browser against the real production bundle** — and in *Chrome*, not Playwright's bundled Chromium, which denies the notification permission outright and would have made the check meaningless: the page is genuinely **uncontrolled** (M3.5 deliberately omits `clientsClaim()`) and `showNotification()` works anyway, which is the single assumption the whole WP rests on and which no unit test can reach; Chrome accepts every option object we emit, including the summary's `renotify` + `tag`; preview-off leaks neither sender nor subject; the notification `data` carries ids only. **+124 tests (1299 total, 137 files); entry chunk 211.92 KB gz.** |
| 2026-07-13 | **M3.7 done** — settings area: capabilities panel, vacation responder, quota (FR-SRV-04, FR-VAC-01, FR-QTA-01), plus the Reading and Compose toggles that had accumulated without a UI (FR-RD-02, FR-CMP-02/08). **Owner decisions:** no accent picker (deferred to M4.5 — `tokens.contrast.test.ts` machine-verifies WCAG-AA only for the built-in accent, and a free colour picker would ship unverifiable contrast into an app whose a11y is a *Must*); the undo-send default goes **10 → 15 s**, closing a code-vs-spec drift nobody had decided (FR-CMP-08 and M2.8's own note both said 15). **The fixture was probed live before a line was written, and it changed the plan:** `vacationresponse` *and* `quota` are both advertised — but `Quota/get` returned an **empty list**, because the capability was advertised with no quota ever assigned. The WP's own Done-when ("the quota bar reflects a filled test account") was therefore untestable, and would have surfaced at the E2E as the plausible-but-wrong diagnosis "our quota code is broken". Stalwart's management API is a JMAP extension (`urn:stalwart:jmap`); `x:Account/set` with `quotas: { maxDiskQuota: … }` seeds it — **`maxDiskQuota` exactly; `MaxDiskQuota` and `max-disk-quota` are both rejected with `invalidPatch`** — and `fixture.mjs` now does so for every account, verified on a wiped volume. Also confirmed: Stalwart's **top-level `mail` capability is `{}`** and the real limits live only in `accountCapabilities`, so the capabilities panel reads `getMailCapability(session, accountId)`; the obvious implementation renders an empty table against the very server we test against, and passes every hermetic test written with a hand-made session. **The size budget was measuring a lie, and the ruler is now fixed.** `.size-limit.js` measured `index-*.js` alone, on a documented assumption ("correct only while the build keeps a single eager entry chunk") that had quietly expired: the emitted `index.html` eagerly `modulepreload`s four further chunks the entry statically imports. M3.7's re-chunking moved `ui` (7 KB gz) and `i18next` (13 KB gz) out of the entry, so the reported number **fell by 17 KB while the code merely moved sideways** — a budget that rewards shuffling is worse than none. The rule is inverted: everything under `assets/` counts as initial JS *unless it is explicitly named as a lazy chunk*, so a new eager chunk is counted automatically and a new lazy one has to be declared where a reviewer sees it. **True initial JS: 220.63 KB gz** (budget 300); M3.6's reported 211.92 was itself ~5 KB short on the same bug, so the honest delta here is about +3 KB. **Three defects that no unit test could have seen — every one of them found by actually running the E2E.** **(HIGH — and it is an M3.5 defect, exposed rather than caused by M3.7) the service worker was hijacking the OAuth sign-in redirect.** M3.5's navigation denylist anchored the reserved server paths with `(?:/|$)`, but Workbox matches a NavigationRoute denylist against `pathname + search` — and an OAuth authorization URL *always* carries a query string. `/login?client_id=…` was therefore **not denied**, and the worker answered the sign-in redirect out of the precache: the user clicks "Sign in securely", the app shell comes back instead of the server's login form, and **OAuth is broken for every returning visitor** — i.e. everyone whose worker has activated. FR-AUTH-02 is a *Must*. It stayed hidden because it needs the worker to be controlling that particular navigation, which is a race; M3.7's re-chunking changed the activation timing enough to make it deterministic, and the M1.9 OAuth E2E — which had been passing — went red. Proved by bisecting the working tree against HEAD, not by reasoning: the same test passes without M3.7 and fails with it, and the cause turned out to be neither. Anchor is now `(?:[/?]|$)`; **every existing denylist test used a query-less path**, which is why a suite of seventeen assertions never noticed. **(HIGH) the vacation form was an unbounded request loop.** `makeVacationClient()` returns a fresh object, so an unmemoized client is a new identity on every render; the load effect depended on it, so every `setDraft` from a load scheduled the next load. `VacationResponse/get` was hammered for as long as the Settings screen was open — Stalwart answers **HTTP 429** within seconds — and each in-flight load overwrote whatever the user had just typed with the server's copy, so the switch **physically could not be turned on**. The unit tests could not see it: they *inject* a client, and an injected client has a stable identity, so the loop cannot form. The regression test therefore goes through the **session**, which is the only shape that can fail. **(HIGH) the away message was silently dropped.** `RichTextEditor` debounces `onChange` by 200 ms to keep typing off the parent's render path, and the vacation form built its patch straight from React state — so a user who typed their message and reached for Save inside that window saved an **empty body**: the subject and the on-switch reached the server, the message did not. This is precisely the data loss `RichTextEditorHandle.flush()` was added for in **M2.8**, when the composer hit it on send; the vacation responder simply did not use the solution the codebase already had. Both fixes are **mutation-verified** — the new tests fail when the fix is reverted. Two E2E defects fixed alongside: the spec reached Settings with `page.goto()`, a full reload, which correctly drops a session that never ticked "Stay signed in"; and it filled the Squire editor with `locator.fill()`, which sets text without the input events the editor listens to (the existing suite already knew to click and type). **E2E: read 10/10** (OAuth back to 467 ms from a 60 s timeout) **and write 8/8**, including the three new settings specs — the vacation responder round-trips against the live server, the capabilities panel agrees with the live session document, and the quota bar reflects the seeded allowance. **+86 tests (1385 total, 146 files); initial JS 220.63 KB gz.** |
| 2026-07-14 | **M3.8 done** — keyboard shortcuts + command palette (FR-UI-04). New eager `shortcuts/` module: a pure-data registry (`id`, `titleKey`, chords, scopes, `enabled(ctx)`, `run(ctx)`) driven by ONE `window` keydown listener in the bubble phase, so every existing React `onKeyDown` (Squire's ⌘B/I/U/K, the composer's ⌘↵/Escape, the APG grid's arrows) runs first and its `preventDefault()` becomes a free, precise veto — capture phase would have broken all of them. Escape is never bound (`useDismiss` owns it, LIFO). `[data-waxwing-portal]` doubles as the "an overlay/composer is up" test, so no single-letter chord fires inside a dialog or the composer. Chords match on `event.key`, NEVER `event.code` (on de-DE, `KeyZ` produces `y`) and **symbol chords never test `shiftKey`** (on en-US `#` is Shift+3, on de-DE it is unshifted; `/` is Shift+7 on de-DE) — plus AltGr (`ctrlKey && altKey`) is accepted for symbols, which is how fr-FR/es-ES/it-IT actually produce `#`. Defaults: `j/k` rove, `o` open, `u` back (reading) / mark unread (list — the scopes are disjoint, Owner D2), `x` select, `e` archive, `#` trash, `!` junk, `s` flag-toggle, `l` labels, `v` move, `c`/⌘N compose, `r`/`a`/`f` reply/all/forward, `/` search, `?` cheat-sheet, `⌘K` palette; the editor keeps ⌘K for links while the caret is in the body (Owner D1). Auto-advance after a triage keystroke, or a mouse-free session stalls on a dead reading pane. The `?` cheat-sheet and the `⌘K` palette are LAZY chunks generated FROM the registry (`registry.test.ts` pins: unique ids, no two actions sharing a chord in an overlapping scope, every `titleKey` resolving in en AND de); the palette is an APG combobox with an own ~60-line subsequence fuzzy matcher (NFD-folded, so `entwurfe` matches `Entwürfe`), recent-first ranking persisted account-scoped in `localPrefs['palette.recents']` (rw read-modify-write), and reaches every action + folder + label + Settings/Contacts. To make "the keystroke and the button are the same code path" literal, `MessageList`'s selection/roving-focus/window were hoisted into a `list-store`, the open `MessageView` publishes its own action-bar callbacks into a `reading-store`, and a shared `use-triage` seam (over the unchanged `useMessageActions`) now backs BOTH the keyboard and the bulk-bar/reading-pane buttons — which also gives archive/junk/trash an **Undo toast** they never had (Owner D3; the inverse `move` is one dispatch). The two ad-hoc listeners (`/` in AppShell, ⌘N in NewMessageButton) were deleted — two owners for one key is exactly the conflict the WP forbids. Built via a read-only Plan-agent brief → a guarded implementation fork → **two independent adversarial reviewers**, which is what earned this WP: `pnpm verify` was green and MEANINGLESS — deleting the ENTIRE scope gate left 1165 tests green, and the auto-advance could be shifted by four rows undetected. Confirmed and fixed: the **⌘K palette bypassed the scope gate** (Settings → ⌘K → "Archive" archived an off-screen message nobody selected — found independently by both reviewers), the module-scoped stores **survived sign-out** (the M3.6 lesson, repeated: cross-account writes were possible because JMAP mailbox ids are per-account and the window key is not), auto-advance left the roving focus **one row past** the open message (so the next `e` archived the wrong mail), `x` in the reading scope selected an invisible row, a stale selection **hijacked `e`** after opening a message with the mouse, `#` was **dead on fr/es/it keyboards** (and `keys.test.ts` had pinned that wrong behaviour), every letter chord was **dead while a row checkbox had focus** (the commonest mouse+keyboard flow), `j/k/u` destroyed the `?q=`/`?label=` context, and `s` could flag but never unflag. Every fix is mutation-verified. **Two E2E-only findings the unit suite could not see** (this is the second WP running where the fork reported "green" on unit tests alone): three of the four new keyboard E2E were wrong (the row's first line is the "Unread" badge, not the subject; the palette query `archive fol` is not a subsequence of `Go to folder: Archive`, so its own matcher could never satisfy it) — and, far more seriously, the sync defect below. **+114 tests (1499 total, 156 files); 224.91 KB gz initial JS.** i18n en+de. Live-verified against the fixture: read+keyboard E2E 17/17, write E2E 8/8. |
| 2026-07-14 | **Sync defect fixed (found by M3.8's live E2E; PRE-EXISTING, not caused by M3.8).** A moved or destroyed message was **never removed from the cached list window**. `useMessageList` renders `queryCache[key].ids` verbatim, but the optimistic apply of a `move` patched **`emails.mailboxIds` only** — it never touched the window. And `dispatch` deliberately runs a REPLAY-ONLY pass (no delta round-trip), so the window was corrected **only when the server's push echoed the change back**. Two user-visible consequences, both reproduced live: **(1) archiving OFFLINE showed no effect at all** — the row sat in the Inbox list until the connection returned (mouse, the ordinary button, no keyboard involved: a plain FR-OFF-01 violation, and the outbox's own doc-comment promises "instant UI"); **(2) archiving within ~500 ms of boot** — before the EventSource channel connects, i.e. exactly what fast keyboard triage does — left the row there **indefinitely** (verified: still present after 8 s, while the server had correctly moved the message). Fix, in the optimistic apply and in ONE transaction with the envelope patch: prune the ids from every `queryCache` window whose stored `filter` **proves** membership of the mailbox they left (`AND`-only; never `OR`/`NOT`), and **void that window's `queryState`**. The void is the load-bearing half and the reason the first attempt was still broken: `Email/queryChanges` computes its delta against the state we last saw, so an archive followed by an **Undo** (archive → inbox again) is a **net-zero change** from the server's point of view — it truthfully reports "nothing changed", that delta is applied to `ids` we had already edited, and the window stays **permanently** wrong. (Caught only because the live Undo E2E was added; the sync unit tests were green and mutation-clean, they simply never moved the same message twice.) The destination windows are voided rather than guessed into — the server owns the collation. Two further defects fell out: `delta.ts`'s `windowLimit` was derived from `ids.length`, which the prune had just shrunk (so a re-query would silently drop the oldest row, ratcheting the window down one row per triaged message), and `loadMore` overwrote a voided `queryState`, re-opening the same hole through another door. `destroyEmails` prunes every window. **Known limitation (documented):** an Undo while OFFLINE restores the envelope but not the row's place in the list until reconnect — we cannot place an id in the server's collation locally. **Known remaining defect → B1 (§13), fix before G2:** `setKeywords` has the same staleness for keyword-filtered windows (`is:unread`, `?label=`); it is bidirectional (a keyword can make a message NEWLY eligible for a window), so it is not a copy of this fix. |

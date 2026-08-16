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
| M3.9 | Reading & triage polish (headers, .eml, phishing, DnD, swipe) | M | M1.8 | done | |
| G2-gaps | Close the §13 gaps due before G2 (B1–B5) | L | M3.9 | done | **2026-07-20.** Taken as one work package on the owner's instruction ("erst die G2-Lücken, damit wir sie später nicht vergessen"). All five closed; see §13 for each. **Three of the five gap descriptions were wrong about their own subject, and finding that out was most of the value:** B4's prescribed "one-line fix" would have turned self-healing push into permanently dead push *and shipped green*; B2's premise named a window default the app does not use, so the fix as scoped would have covered no real user; and B5's proposed remedy was aimed at the class's rarer half — the check it did **not** propose found two live WCAG 2.4.7 defects, while the one it did proposed finds nothing today. B1's scope was too narrow (it missed arrival/departure by **sort**) and B3's single predicate could not serve both surfaces it was specified for. Two documented decisions were reversed with ADRs (**014** the swipe's Archive→Trash fallback, **015** B5's widened scope); ADR-005 amended, tech-stack + design-system + FR-LST-06 + FR-UI-04 updated. Four new open rows filed rather than quietly absorbed (**B6**–**B9**). **A process failure worth recording:** a parallel implementation agent used `git checkout -- .` to undo a mutation, which reverted the whole tree and destroyed another agent's finished work package; it was detected by checking `git status` against the reported file list, and rebuilt from the agent's own report. Concurrent agents now get an explicit prohibition, and neighbouring-file work packages are run strictly sequentially. |
| M3.10 | E2E: offline & push suites | M | M3.3, M3.5, M3.6 | done | **2026-07-20.** Four waves. It began by finding that the gate it was meant to extend **did not run**: `pnpm verify:e2e` had been red since M1.4, under two stacked defects. Now green end to end — **66 E2E tests** (1 shell + 4 mount + 49 read + 9 write + 3 deploy) plus `pnpm verify` at 1909. New: a `/mail/` **mount** harness for the deployment shape Stalwart actually produces and no suite had ever seen; offline scenarios incl. the three G2 payoffs; PWA/service-worker deploy staging; a notification suite on `channel: 'chromium'`. Two product defects fixed on the way (the update toast's draft flush was inert; `read.spec`'s 75 s push budget was 60 s of dead time). **Sized honestly: `M` was wrong — this was `L`.** Boundaries held rather than eroded: background push stays uncovered because no code exists (ADR-010), a notification CLICK is undispatchable, and `visibilityState` cannot be driven to `hidden` — each stated in the spec headers instead of faked. |
| G2-followups | Close the remaining §13 rows due at G2 (B7–B9) + raise the fixture pin to Stalwart v0.16.14 | L | M3.10 | done | **2026-07-21.** Six waves, and the shape of the session is the finding: **every single round, an independent checker found a real defect in work that was already green, mutation-proven and self-reported as done** — a per-id membership fix that widened a rollback bug, an "exact retraction" that had to be reverted, an unsound state-machine predicate, roughly a dozen guard clauses that survived deletion with the whole suite green, and eight comments asserting properties their code did not have. **Two of the wrong prescriptions were mine, not the plan's** (see B7 and B14). The technique that found most of it was not review but *deleting each guard and requiring the suite to object*. The fixture bump was expected to be routine and was not: v0.16.14 auto-generates a VAPID key on a virgin registry, which made a settings assertion — one deliberately written to fail the day a server shipped RFC 9749 — do exactly its job, and exposed a **live product defect**: against any real v0.16.14 the app promised background notifications it has no code to deliver (**D6**). |
| G2-review | Independent cross-cutting review of the whole M3 phase, ahead of the gate | L | M3.10, G2-followups | done | **2026-07-22.** Eight review dimensions no single work package owned (requirement coverage, i18n, a11y, security/privacy invariants, "is the plan telling the truth about the code", "are the ADRs still true", cross-surface consistency, dead wiring), each finding then attacked by two refuters with different lenses; 100 agents, 5.3 M tokens. **46 raised, 38 survived, 2 HIGH.** Then four fix waves, each broken by an independent checker — the same six-for-six pattern as G2-followups, now ten for ten. **The finding that stops the gate is a live security defect in shipped code: the phishing gate (FR-RD-08) could be switched off by the attacker with one hidden `<span>`.** It is much stronger now and it is still not sound; see **B19**, which is the row that matters. Second HIGH: "Mark as unread" undid itself 1.5 s later, because the auto-mark-read effect had `$seen` in its dependencies — reachable from the action bar and from another client. Also fixed: an offline "Empty folder" that failed silently and told nobody; list toolbar controls enabled, writing their preference and doing nothing on the search and label seams; two identical Trash icons side by side, one permanent; every comfortable-density row carrying a literal `undefined` class; the vacation preview opening links with no host check at all; and six document claims gone false — including the spec's own FR-NOTIF-02, which still asserted that no JMAP server can do Web Push. **A correction to the review's own method, recorded because it is the same failure it was hunting:** five findings were first recorded as refuted by a single dissenting lens while the other said verbatim "CONFIRMED — could not refute". The aggregation rule (`survives = no dissent`) was wrong for two voters with different jobs; caught by reading the refutation prose rather than trusting the boolean, and the five are recovered and filed. Nine new rows filed rather than absorbed (**B19**–**B27**), and the Web Push decision renumbered **D5 → D6** (D5 was taken by the design-system sign-off of 2026-07-10, which `design-system.md:4` points at). |
| **G2** | **Gate: owner reviews M3** | — | M3.10, G2-followups, G2-review | done | **Passed 2026-07-23.** Three decisions taken. **D3 deferred 2026-07-21** — there is no v1.0 to raise the baseline to. **D6 decided: build Web Push, contentless (D6a)** — probing the fixture before deciding cut the assumption the `L` estimate rested on, because `PushSubscription` carries a server-side `types` filter that Stalwart honours, so the worker is woken only on `EmailDelivery` and needs no JMAP call, no token and no `SecretStore` access; sender+subject stays unbuilt as **B28**, since that is what would drag auth into the worker. [ADR-017](adr/017-web-push-contentless.md), work package **M4.0**. **B19 decided (copy half): the phishing interstitial is not touched** — its text is accurate whenever it appears, and a hedge inside it would weaken the one warning that did fire in order to qualify the ones that did not; the limitation goes into the release notes and security guide of M4.9 under NFR-PRIV-02 instead. The code half of B19 stays open: twelve named bypasses, none fixed and none claimed fixed. |

### Phase 5 — M4 "V1 release"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M4.0 | Web Push, contentless (FR-NOTIF-02 — decision D6a) | M | G2, M3.5, M3.6 | done | **2026-07-23.** FR-NOTIF-02's headline is met for the first time: notifications while the app is fully closed. `@waxwing/jmap` gains `PushSubscription/get|set` (RFC 8620 §7.2 — the one `get`/`set` pair with no `accountId`, since a subscription belongs to the credentials); the page subscribes with `types: ['EmailDelivery']` so the **server** filters; the worker raises one contentless banner. **The security property is now a build gate, not a promise:** `check:dist` fails if `dist/sw.js` ever contains `SecretStore`, `oauth.refreshToken`, `waxwing-auth`, `Authorization`, `Email/get`, `Email/query` or `Dexie` — so B28 (sender + subject) cannot arrive as a side effect, only as a decision that deletes those lines and says why. Verified against the shipped worker: 0 hits for all seven. **Five things the build made necessary that the plan did not foresee:** (1) the worker cannot run i18next, so the PAGE writes the already-translated strings into a tiny raw-IDB store (`waxwing-push`) and a language switch rewrites them — carried by react-i18next handing back a new `t`, which a test pins; (2) `quiet-hours.ts` was split out of `notify-model.ts` so both transports share ONE copy of the midnight-crossing rule (a second copy would make quiet hours work with the app open and fail with it closed, silently, at 3 a.m.); (3) sign-out must destroy the subscription **while the client is still usable** — a subscription outlives a sign-out on the SERVER, so a browser left subscribed keeps announcing new mail for a mailbox nobody is signed into, possibly to the next person at the machine; (4) the whole `waxwing-push` database is wiped with it, `deviceClientId` included, so a shared machine cannot re-register under the last user's identity; (5) an endpoint is bound to the VAPID key it was minted against (RFC 8292 §4.2), so a server key rotation has to replace the BROWSER subscription too — the old endpoint still answers `getSubscription()` and every push to it is rejected. **28 mutations run, 2 survived and both were real test defects, both of the same shape the G2 review kept finding — a test that passes for the wrong reason.** The sign-out test asserted the worker state was gone without ever having written one; the device-id test asserted against `ensureDeviceClientId`, whose own call was what persisted the id, so it stayed green against a pass that minted a fresh one per start. Both are now asserted on what reaches the SERVER. **`pnpm verify`: 178 files / 2479 tests** (from 2459), **236.9 KB gz** of 300. **Not verified and filed as B29: the closed-app delivery itself.** Playwright cannot observe a closed app and Chromium here has no push service, so `subscribe()` fails and the app degrades to `unsupported` — by design, and it means the one thing this work package is named after has never been seen working. |
| M4.1 | `@waxwing/jscontact` (JSContact ↔ vCard 4) | M | P0.1 | done | **2026-07-23.** Built against **RFC 9555** — the normative JSContact↔vCard mapping — rather than an invented one, which also answered the plan's *lossless-where-possible* item outright: unmapped vCard properties ride in `Card.vCardProps` as jCard values (§2.15.2) and are **written back on export**, so an Outlook card keeps its `X-MS-*` and an Apple card keeps `item1.X-ABLabel` bound to the right phone number. Three layers, because the failures are in the bottom one and they are all silent: a lexer (unfold, group prefixes, RFC 6868 parameters), a value layer, and the mapping. **Structured values are split BEFORE unescaping** — `\\;` is a literal backslash followed by a separator, and unescaping first makes a Windows path in an address swallow the town name. **Folding counts OCTETS**, computed per code point rather than measured, so the package needs no Web API at all and cannot split a surrogate pair; the test measures the same strings with a `TextEncoder` as an independent oracle. **20 mutations, 2 survived, both real test defects:** the `PROP-ID` test used CONVENTIONAL ids (`e1`, `tel1`), which a re-deriving implementation reproduces exactly, and the photo-URI test used a bare base64 blob — which contains neither a comma nor a semicolon, so it stayed green against a writer that escaped every URI. A real `data:image/png;base64,…` has both. **A third defect was found by the documentation, not by the code:** `NICKNAME` and `URL` were in the converter's `MAPPED` set (so excluded from `vCardProps` as handled) while nothing converted them — they were dropped entirely, silent data loss in the package whose whole promise is that nothing is lost silently. Invisible to every other test, because nothing looks for a property that is simply absent; found because `matrix.test.ts` reads the README's own table and checks it against behaviour. Both are converted now. Corpus: the RFC 6350 example plus transcribed Apple, Google and Outlook export shapes, a `data:` URI card, a group card and an escaping torture case — each asserted as a **fixed point** of import→export→import, which is what catches asymmetry without anyone guessing in advance which property it would be. **111 package tests; `pnpm verify`: 181 files / 2590 tests.** Builds standalone (`tsup`, 25.8 KB ESM + 13.5 KB d.ts) with the corpus tree-shaken out, and the built bundle was exercised from Node. Not wired into the app — that is M4.2/M4.3. |
| M4.2 | Contacts area (books, cards, groups) | L | M4.1, M1.1, M1.3 | done | **2026-07-25.** Six stages, each its own green commit. RFC 9610 wire types in `@waxwing/jmap` (`AddressBook`/`ContactCard`, get/changes/query/queryChanges/set; `ContactCard` extends the jscontact `Card` via `import type`, so the zero-dep client keeps no runtime edge and unmapped JSContact props + `vCardProps` stay lossless). Account-scoped, delta-synced replica (additive Dexie `version(6)`) mirroring the mail sync exactly, incl. the `cannotCalculateChanges`→full-requery recovery and the periodic `forceFull` reprobe; the contact query cache is its OWN store rather than a typed lie over the Email-typed `queryCache`. A three-pane area on the mail screen's `SplitPane`/`useLayoutTier` machinery (rights-aware address-book rail, virtualised list, hybrid local+server search whose needle is local state so a live-query echo cannot reset it mid-keystroke, detail view with blob photo). **Full offline-parity CRUD** through new durable Outbox intents (optimistic apply + persisted prior-row undo + state-guarded conflict; creation-id reconciliation rewrites queued intents that referenced a temp id — a chained edit, or a card created into a book itself just created). A progressive form with a lossless `ContactCard`⇄form mapping (existing map-keys reused → single-key patches; `Card→Form→Card` is `toEqual`) and a downscale→`uploadBlob`→`blobId` photo upload. Groups as `kind:'group'` cards plus the pure `expandGroup(uid)→EmailAddress[]` seam M4.3 will consume (member uids kept distinct from JMAP ids). **Verified end-to-end against the live Stalwart fixture** (RFC 9610 confirmed advertised; a default writable book per account): a Playwright suite creates a contact AND a group through the UI and confirms the server effect over JMAP; **full `verify:e2e` green, no regression to the read/write/mount/deploy suites.** The `shared book respects read-only rights` half is an honest premise-skip in E2E — cross-account sharing/delegation is not provisioned on the fixture (M4.4 groundwork) — with the rights gating covered by the `ContactDetail`/`ContactForm`/`GroupForm` component tests. **Two facts learned from the real server:** Stalwart derives `name.full` from the components (validates the client's name-rebuild) and assigns its OWN `uid` (so group membership resolves against the synced server uid, not the client's). Also hardened two latent-flaky `MessageList` swipe tests that the added parallel test-load surfaced (readiness gate strengthened, no assertion weakened; 5 consecutive green full runs). **`pnpm verify`: 199 files / 2778 tests, 238.89 KB gz** of 300 — contacts lives in the lazy `ContactsPage` chunk (~13.6 KB gz), the entry bundle is unchanged (~228 KB gz). |
| M4.3 | Contacts↔mail integration (autocomplete, hover cards, import/export) | M | M4.2, M2.4 | done | **2026-07-25.** Three commits (FR-CON-03/05/06). Composer autocomplete v2: a contact source on the SAME `RecipientSuggestionSource` interface, merged contacts-first so a contact beats a stale recent (its real name wins over a harvested envelope name), ranked within by an `addressStats`-usage join; photo avatars from the LOCAL blob cache (`Avatar` gains `photoSrc` — local blobs, not the remote images FR-LST-03 forbids). From a message: the sender avatar opens a light `role="dialog"` popover (`useFocusTrap`, Escape restores focus to the trigger) offering add-to-contacts / edit-contact / a recent-conversation link (`from:<addr>`); "add" seeds a card into the writable book via the M4.2 outbox (server assigns the uid). Import/export: a lazy dialog reads/writes vCard 4.0 + JSContact JSON, dedupes by email (skip by default + keep-both, **no merge** — a field union risks silent loss), CSV stays out; the ~26 KB jscontact conversion runtime loads only through `import('./jscontact-runtime')` — verified in `dist` that `BEGIN:VCARD` lives in that chunk alone, never the entry or the `ContactsPage` read chunk. **Done-when met, verified end-to-end against the fixture:** autocomplete-prefers-contact is a deterministic unit test; sender-to-contact AND vCard-import round-trips are Playwright tests that drive the UI and confirm the server effect over JMAP; full `verify:e2e` green, no regression. **`pnpm verify`: 205 files / 2825 tests, 246 KB gz** of 300 — import/export sits in its own lazy chunks (jscontact-runtime 4.5 KB gz); the entry held (the +7 KB gz over M4.2 is rolldown re-chunking shared `contact-fields` helpers now reachable from composer + reader — reuse over duplication, an M4.8 budget item). |
| M4.4 | Shared accounts (delegated mailbox trees) | M | M1.3 | in-progress | **2026-08-16.** Four stages: session model (`7fe3376`), engine fleet (`68ff625`), account-grouped sidebar + active-account store, and stage 4 — account-aware dispatch (ADR-018). Stage 4 closed a data-corruption defect stage 3 made reachable: one `activeEngine` singleton meant a write from a shared tree carried that account's SHORT mailbox id to the primary's engine, where it names a different real mailbox (`emptyMailbox` destroys it). Engine selection is now keyed by account — `getEngineFor(accountId)` / `useAccountEngine()` resolved from `useReplica().accountId`; `getActiveEngine()` narrowed to "the primary". Engine routing alone was not enough: the keyboard layer and `useSearch` resolved role/`in:` ids against the primary while acting on the active account, and the drag subject carried no account — all three moved. Fixed en route: B33, B35, B36 + sign-out now stops the whole fleet. Deliberately unchanged: the no-op status sink and primary-only notifier — see **B32/B34**, which stage 4 unmasks. **Not done:** send-as from a shared account, and the E2E delegation fixture, without which M4.4's own "Done when" is unprovable. |
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

- [x] Header details on demand: full addresses, date, message-id, authentication results
      where exposed (FR-RD-06). **Live-probed (M3.9 step 0):** `headers` (Raw) is deliberately
      NOT fetched — RFC 8621 returns it RFC-2047-encoded and folded, and everything we show is
      available server-decoded via dedicated properties. Auth results use
      `header:Authentication-Results:asText:all` and read `[0]`: RFC 8621 §4.1.2 makes the
      un-suffixed form return the **last** instance, which on a phishing mail is the sender's own
      forgery. Rendered neutrally + attributed, never as a verdict (RFC 8601 §7.1).
- [x] "View source" / download `.eml` — an unconditional authenticated download of the Email's
      own `blobId`. **The capability gate this task used to prescribe does not exist** →
      **ADR-011**; `downloadUrl` is mandatory in RFC 8620 and RFC 9404 `Blob/get` is strictly
      worse (base64-in-JSON, capped at `maxSizeRequest` = 10 MB vs the endpoint's 50 MB).
      Must NOT use the blob cache: the Email's own blobId has no owner link, so the next
      maintenance pass reaps it as an orphan (`eviction.ts:217`).
- [x] Attached `message/rfc822` opens as nested in-app message view via `Email/parse`
      (FR-RD-07). **No `postal-mime` fallback** — the `Email/parse` answer is the SP.4 record
      (`:589-597`), not SP.5. `bodyValues` MUST be named in `properties` (SP.4 caveat) — proven
      live: removing it turns the E2E's body assertion red (an empty body comes back with no error).
      The parsed Email carries its body inline in `bodyValues`, has NO stored id and never enters
      Dexie, so it reuses only the pure, id-agnostic transforms (`pickHtmlBody`/`pickTextBody`,
      widened to a structural `RenderableBody`), never the id-keyed `useMessageBody` — and it fetches
      NO blob, sidestepping the ADR-011 orphan trap by construction. Renders through the SAME
      `sanitize` + `MailBodyFrame` path as the outer message, with `allowRemote:false` and no
      `resolveCid` (the inner sender is untrusted independently of the outer, so remote content AND
      inner `cid:` images stay blocked). Nesting is bounded to **one level, structurally**: the leaf
      renders header + body only, no inner `AttachmentList`, so an inner `message/rfc822` exposes no
      Open control. Owner decision (2026-07-17): **inline reveal** under the attachment row (Apple
      Mail parity), not a dialog.
- [x] Phishing friction: display-name vs. address reveal on hover/tap; warn when link
      text host ≠ target host (FR-RD-08).
- [x] **5a — the non-pointer paths FIRST** (WCAG 2.2 **SC 2.5.7 Dragging Movements** makes them a
      *prerequisite* of the drag, not a companion — the task used to read as though only the drag
      were missing): a `Move…` entry in the list's bulk bar, the `v` move chord widened from
      `reading` to the list scope, and a folder "Move to…" action. Pure `folder-tree` guards
      (`isSelfOrDescendant`, `subtreeDepth`, `legalParents`; no cycle, `mayCreateChild` on the
      TARGET, `maxMailboxDepth`, top-level gated on `mayCreateTopLevelMailbox`) are where the
      correctness lives. `Triage` gains `moveTo`. **This task's own text was wrong in four ways —
      corrected here rather than silently:** (1) it said a move dialog was missing; `MoveDialog.tsx`
      has shipped since M1.8 — 5a was wiring, not construction. (2) `MessageView.tsx:382` was a
      dead line number (M3.9 §1-2 moved it); the direct `actions.move` was at :536. (3) It framed
      the Undo bypass as the `v` chord's problem — the same `onMove` served the reading bar's Move
      BUTTON, so the mouse had the identical hole and a keyboard-only fix would have fixed nothing.
      (4) It called `moveMailbox` "undoable", which is true only of the engine's server-reject
      rollback; **owner decision (2026-07-17): no user-facing Undo toast for folder actions in 5a** —
      rename/delete have none either, and a move-only toast would make those two look broken. All
      three land together in a later WP or not at all.
- [x] **5b — drag & drop** on top of 5a: messages → folders, folder re-parenting (FR-MBX-03).
      HTML5 DnD (not pointer events). **Correction to this task's own text:** it said the drag and the
      swipe "are separated by `pointerType`" — a `DragEvent extends MouseEvent`, NOT `PointerEvent`,
      so a drag handler has no `pointerType` to read. The separation is real but one-directional: only
      the swipe (step 5) can filter `pointerType !== 'touch'`; the drag cannot check anything.
      ~~which makes it desktop-only~~ — **ADR-012 was amended on 2026-07-19: that claim is false.**
      Chrome-on-Android has entered a drag from a long-press on `draggable="true"` by default since
      Chrome 100, and iOS Safari does the same via `UIDragInteraction`; only Firefox-Android does not.
      The drag has therefore been live on touch since `770182b`, untested. The two gestures are kept
      apart by mechanism instead: movement past the tap slop cancels the pending long-press, a drag
      taking over emits the spec-mandated `pointercancel` that the swipe treats as "abandon", and
      `onDragStart` additionally bails when a swipe has **locked an axis** (`swipe.isSwipeActive()`,
      i.e. `direction != null` — NOT "a finger is down", which would cancel the very long press that
      starts a touch drag). Routes
      through the existing `move`/`moveMailbox` intents via the 5a seams (`triage.moveTo` for a
      message drop, so it inherits the Undo toast; `useFolderActions().move` for a folder) and the 5a
      guards (`legalParents`, snapshotted into a Set at dragstart) — no new write path, no parallel
      legality check. `dragover` may only consult `dataTransfer.types` (values are unreadable until
      `drop`, by spec) — so the kind rides in the MIME type and the subject in module-level state.
      No `aria-dropeffect` (deprecated); an **always-mounted** `aria-live` region (Toast's rule)
      announces "Drop on {folder}". Dragged-set rule: a row inside the selection drags the whole
      selection, a row outside it drags just that row (the opposite of `targetIds`, which is
      selection-first — wrong under a pointer). Proven live incl. a mutation check (removing the
      `mayAddItems` gate turns the E2E red).
- [x] Swipe gestures on touch: configurable archive/delete/read actions (FR-LST-06) → **ADR-013**.
      **Owner decision (2026-07-16): Apple parity** — default right = mark read, left = archive
      (→ trash when the account has no archive role), configurable per direction in Settings, as
      iOS Mail does. Routed through `use-triage.ts` so a swipe, a button and a keystroke are one
      code path. Mouse pointers are ignored (that is 5b's drag). No confirmation on a destructive
      swipe — the Undo toast is the safety net (Apple parity) — but swipe-to-trash **inside**
      Trash must never mean destroy (`destroy` has no undo).
      **What was actually built**, and where this task's own text was wrong — corrected here rather
      than silently:
      (1) **Pointer events, not touch events, and this was forced, not chosen**: React 19 registers
      `touchstart`/`touchmove` as PASSIVE, so an `onTouchMove` could never `preventDefault`.
      `pointerType !== 'touch'` is what ignores the mouse — the only discriminator needing no jsdom
      stub. No `setPointerCapture` (it does not exist in this jsdom); `pointermove`/`pointerup`/
      `pointercancel` live on `window` for the gesture's life.
      (2) **"Mouse pointers are ignored (that is 5b's drag)" was only half the story.** The drag is
      NOT mouse-only — ADR-012's platform claim was false (see 5b) — so one finger can enter both
      gestures on the same node. They are separated by what the finger does, and `onDragStart` bails
      only when the swipe has LOCKED AN AXIS.
      (3) **"swipe-to-trash inside Trash must never mean destroy" was satisfied by construction, and
      pointed at the wrong hazard.** `destroy` is not a member of `Triage` at all, so a swipe cannot
      reach permanent deletion. The hazard that WAS real is a **self-move**: `moveWithUndo` had no
      `to === from` guard, and with `from === to` the outbox patch writes the same `mailboxIds/<x>`
      key twice (`true`, then `null` — the removal wins), asking the server to take the mail out of
      the only mailbox it is in. **Reachable today from the bulk bar's Trash button while viewing
      Trash** — i.e. a live data-loss path that predates this WP and had nothing to do with swiping.
      Fixed at the seam (`use-triage.ts`), so the bulk bar, the chords and the swipe are covered once;
      the swipe additionally renders such a direction **inert** (no layer, no follow, no commit).
      (4) **The archive → trash fallback did not exist before this WP** — the task's "(→ trash when
      the account has no archive role)" described something unbuilt. It must NOT be driven off
      `triage.archive()`'s boolean, which is also `false` while the liveQuery is merely unresolved
      (the ~7 % silent no-op M3.9 step 1 fixed) — `if (!archive(…)) trash(…)` would trash mail on the
      first render tick of an account that HAS an Archive. Resolved instead from one `useMailboxes()`
      read, with both move directions inert until it resolves.
      (5) **Commit-only, no iOS "peek"**: under `SWIPE_COMMIT_PX` the row rubber-bands and nothing
      happens. Zero React state while the finger is down (one `--swipe-x` custom property, two
      `data-` flags, one class) — a `setState` per `pointermove` would re-render every virtual row at
      60 Hz.
      (6) **SC 2.5.7 needed work after all**, contrary to the assumption that the existing paths
      covered it: swipe-right toggles `$seen` while the bulk bar's read button only ever SET it, so
      mark-UNREAD had no single-pointer path (`u` is a keyboard chord — SC 2.1.1, not 2.5.7). The
      bulk-bar button is now a toggle. See ADR-013's Consequences: read/unread had drifted into three
      behaviours across button, chord and swipe.
      (7) Per-direction prefs are two scalar `localPrefs` keys (`swipe.left`, `swipe.right`), so no
      read-modify-write transaction; `none` disables a direction outright.
      **Known interaction:** swipe-to-read makes **B1** (§13) user-visible in the commonest touch
      flow (a swiped-read row stays in a `?q=is:unread` view until the server echoes; offline,
      until reconnect). Accepted and noted; B1 lands before G2 as planned.
      **Test shape:** unit tests drive the gesture through pointer events in jsdom; a **new
      `chromium-touch` Playwright project** (`e2e/tests/swipe.spec.ts`, phone viewport, `hasTouch`,
      gestures dispatched via CDP `Input.dispatchTouchEvent` — Playwright has no swipe primitive)
      exists because jsdom computes NO CSS and therefore cannot see `touch-action`, the transform or
      the reveal layer's colour — gap **B5**.

Done when: each item demo-able; **the non-pointer path exists for every drag operation** (SC
2.5.7); swipe has a keyboard/button equivalent.

### M3.10 — E2E: offline & push suites

Spec: NFR-QUAL-01. Size: M.

- [x] Playwright: offline outbox scenarios (compose offline → reconnect → delivered),
      cache/eviction smoke, PWA install + offline boot, push-driven live update, (where
      runnable) notification display.
- [x] Wire the chaos tests from M3.3 into CI (may be a nightly job if slow). **Resolved
      2026-07-20:** `engine.chaos.test.ts` is a plain `*.test.ts`, so `pnpm test` already collects
      it and it has been inside the `pnpm verify` gate all along — there was nothing to wire.
      The work this task actually named is making its **live counterpart** part of the same gate
      (the chaos file's own header says that counterpart is M3.10), and that is done: the new
      browser suites are in `scripts/verify-e2e.mjs`'s ordered run list. Writing a GitHub Actions
      workflow would contradict ADR-003 and is not done here.
- [x] **Handed over by the G2 gap package (2026-07-20).** Three things it built are unverifiable
      without a browser and a live server, and each is the *payoff* of its gap rather than a
      detail:
      - **B2:** offline, archive a message and Undo it — the row must come **back into the
        list without reconnecting**. This is the whole point of the gap; the unit suite proves
        the splice, only the browser proves the user sees it. Cover the collapsed-thread
        default, not a flat window.
      - **B4:** the two WebSocket 401s must be **gone** and SSE must be the push transport at
        login. Measured before the fix at WS 85 ms → 401, WS 584 ms → 401, SSE 586 ms; assert the
        negative (no WS attempt), since that is what regressed silently for a milestone.
        **Instrument correction, M3.10:** "gone from the console" is not assertable — a WS
        handshake never surfaces as a Playwright `request` and its failure is not reliably a
        console message. `page.on('websocket')` is the only instrument that sees it, anchored on
        the SSE request as a positive and paired with a control socket so the listener itself is
        proven live. The mutation is **deleting the `transports` allowlist** (→ WS-first default
        order), *not* `prefer:'sse'` — `prefer` reorders without restricting, so SSE still wins
        and the test would stay green, which is the same false-green the G2 entry above records.
      - **B1:** with "Unread first" on, marking a message read must re-sort it **without waiting
        for the server's push echo** — corrected wording, M3.10: the earlier "without waiting for
        the server's echo" overstated the code. `resorted` VOIDS the window's baseline
        (`outbox.ts`); it does not re-order `ids` locally, so the row moves on a client-initiated
        `fullRequery` once the outbox drains. That is **online-only** and it is **not** a local
        splice. The test is written to that guarantee, and it has to **block SSE** to assert it at
        all: B4 — shipped in the same milestone — made the server's echo arrive in ~100 ms, so
        against a live push channel a build with `resorted` disabled re-sorts anyway and the test
        passes for the wrong reason (observed, not predicted). With the eventsource stream aborted
        the channel falls back to 30 s polling and a 15 s budget isolates what B1 actually buys.
      Note for whoever runs it: B2 makes the `j o e u x #` `keyboard.spec` sequence exercise a
      path it did not before — an arrival editing a window while `pendingOutbox` is non-empty.
      M3.9 recorded that path going 7 % → 2 % → 0 % flake across two fixes. A new flake there
      is more likely this than a new defect; the unit-level burst test passes.
- [x] **Handed over by M3.6.** Background push (app **closed**) is **not coverable at all** —
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
- [x] **Handed over by M3.5** (a real browser is the only place these can run; do not fake
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
      - ~~WebKit + Lighthouse installability~~ — **dropped by owner decision (2026-07-20), with
        the reason recorded.** Neither exists in the repo: no Playwright config declares a WebKit
        project, only chromium binaries are installed, and Lighthouse appears in no `package.json`.
        More to the point, **WebKit has no install API at all** — `beforeinstallprompt` is a
        Chromium-only non-standard event — so a "WebKit installability" test could assert nothing
        beyond MIME types and an `apple-touch-icon`, both already covered at source level. And
        Lighthouse's PWA installability audit reports substantially what Chromium's CDP
        `Page.getAppManifest` plus the build-artifact precache check already establish, in exchange
        for a heavyweight dependency and a second maintained runner. Installability is therefore
        covered via `Page.getAppManifest` + the dist check. **Engine breadth is still wanted, but
        not here:** WebKit is far better spent on the sanitizer and the reading pane, where engine
        differences actually bite — filed as **B11**.
      - the deep-link reload under a `/mail/` prefix — **kept, and the mount harness is built**
        (owner decision, 2026-07-20). It is where M3.5's white-screen defect lived: without a
        `<base>` element a deep-link reload resolved `./assets/index-*.js` against the ROUTE path.
        That class of defect is **invisible at the root and fatal in the mount**, which is the
        deployment Stalwart actually produces. The same harness serves M3.6's click-route
        coordinate spaces, which is why it is built once here rather than twice later.

Done when: **suites green in `pnpm verify:all`** (restated from "green in CI" by owner decision,
2026-07-20 — there is no CI: ADR-003 defers it deliberately and no `.github/` exists, so the
original wording was unmeetable rather than demanding). The new suites are added to
`scripts/verify-e2e.mjs`'s ordered run list, which is the gate that actually exists. Flaky tests
quarantined with issues, not ignored.

**Gate G2:** owner reviews M3; **decision D3** (raise server baseline to Stalwart v1.0?)
is made — v1.0 is expected ~Oct 2026, which likely coincides with this phase. Outcome
recorded; CI pins updated if raised.

**Phase 4 exit criteria:** all M3 WPs done; G2 passed; Waxwing is usable against a real mailbox
locally (`pnpm dev`).

> **Daily-driver dogfooding moved to G3 (owner decision, 2026-07-21):** the original wording asked
> team members to "(and do) use Waxwing as their daily client against a real mailbox". That cannot
> be met here, and not for want of effort — the work that makes Waxwing *deployable at all*
> (`<base href>`, the Stalwart Applications mount, the deployment guide) is **M4.9**, which sits
> behind this gate. The criterion demanded daily use before the package that enables delivery.
> The owner's reason for moving it is the better one and is recorded verbatim: *"Wir können nur
> Sachen testen die wir auch schon implementiert haben."* Real dogfooding is now a **G3** criterion.

---

## 10. Phase 5 — M4 "V1 release"

Goal: contacts, polish to spec (theming, i18n, a11y, perf), and shipping.

### M4.0 — Web Push, contentless

Spec: FR-NOTIF-02 (+ FR-NOTIF-03's master switch, quiet hours, sound). Decision **D6a**;
scope, evidence and the four measured facts in [ADR-017](adr/017-web-push-contentless.md).
Size: M.

The property to protect while building this: **no access token, no `SecretStore` access and no
JMAP call may enter the service worker.** That is what makes this an `M` and it is what B28
would trade away. If a task below seems to need one, the task is wrong.

- [x] `@waxwing/jmap`: `PushSubscription` types + `PushSubscription/get|set` (RFC 8620 §7.2),
      and the `PushVerification` object. Keep the transport-agnostic shape of `push/` — this is
      a data type, not a fourth transport.
- [x] Subscribe flow in the app (not the worker): `PushManager.subscribe()` with the server's
      `applicationServerKey` from `getWebPushVapidCapability`, then `PushSubscription/set`
      with **`types: ['EmailDelivery']`** so the server filters. Guarded by the existing
      permission state — a subscription is never created without an explicit opt-in.
- [x] `PushVerification` round-trip: the worker relays the verification push to the page,
      which echoes `verificationCode` back via `PushSubscription/set update`. Until it does,
      the server pushes nothing — so a stuck verification must be visible, not silent.
- [x] `push` listener in `apps/web/src/sw/sw.ts`: decrypt (the browser does this), confirm the
      frame is a `StateChange` naming `EmailDelivery`, then `showNotification` with the
      contentless copy. **Suppress when a client is visible** (`clients.matchAll`) — the live
      channel already raised the richer banner and a double notification is worse than none.
- [x] Preferences the worker can honour, read from `localPrefs` (unencrypted IndexedDB):
      master switch, quiet hours, sound. Per-folder is **not** applicable while closed and the
      settings UI must say so rather than let a dead control look effective.
- [x] Renewal: the subscription expires after **7 days** and the ceiling is the server's
      (measured: a 90-day request returns 7). Renew on start and on a long-running session;
      treat a `410 Gone`, a rotated endpoint and a missing subscription as ordinary and
      re-subscribe. State the 7-day limit in the Notifications settings (NFR-PRIV-02).
- [x] Settings copy replaces `notify.background.notImplemented` with the truthful states,
      en + de. No key may claim more than the code does — the reason that string exists.
- [x] Tests: the subscribe flow, the verification round-trip, the suppression rule, renewal
      and the `push` handler's frame filtering. 28 mutations run; the two that survived were
      both real test defects (see the status-board note) and are fixed.
- [ ] **The closed-app delivery itself — NOT DONE, filed as B29.** Playwright cannot observe a
      closed app and Chromium in the harness has no push service, so `subscribe()` fails and
      the app degrades to `unsupported` exactly as designed. That means the one behaviour this
      work package is named after has never been observed working. Needs a real browser against
      a real push service, per platform, including whether iOS still requires a Home-Screen
      install. Everything around it is tested; this is the gap, and it is not a small one.

Done when: **all of the above AND B29 closed.** A real browser, app fully closed, raises one
contentless banner on delivery to the fixture and none on a message read elsewhere; opening it
lands in Waxwing; the settings state the 7-day limit and the per-folder gap; and no token or
`SecretStore` call exists in `sw.ts` — the last of these is now enforced by `check:dist` rather
than by inspection.

### M4.1 — `@waxwing/jscontact`

Spec: FR-CON-06, tech-stack §5. Size: M.

- [x] MIT package: JSContact (RFC 9553) ↔ vCard 4.0 (RFC 6350) conversion, both
      directions; explicit supported-property matrix documented (name components, emails,
      phones, addresses, org/title, birthday, notes, photo, groups).
- [x] Lossless-where-possible: unknown vCard properties preserved on round-trip where
      JSContact allows, else documented as dropped.
- [x] Test corpus: vCards from Apple/Google/Outlook exports + RFC examples.

Done when: corpus round-trips within the documented matrix; package builds standalone.

### M4.2 — Contacts area

Spec: FR-CON-01/02/04. Size: L.

- [x] Extend `@waxwing/jmap` with RFC 9610 types (`AddressBook/*`, `ContactCard/*` incl.
      query/changes) and the sync engine + replica with contact tables (same
      account-scoped, delta-synced pattern as mail).
- [x] Address book list incl. shared books, rights-aware (FR-CON-01).
- [x] Contact list: search-as-you-type (local + server query), detail view; photo via
      blob (FR-CON-01).
- [x] Create/edit/delete with progressive form — common fields visible, rest behind
      "add field" (FR-CON-02).
- [x] Groups: create/manage; group → recipient expansion hook for the composer
      (FR-CON-04).

Done when: contact CRUD + groups round-trip against the fixture (Stalwart supports RFC
9610 natively); shared book respects read-only rights. — **Met 2026-07-25.** `verify:e2e`
drives the UI against the live fixture and confirms create-contact + create-group over
JMAP. The read-only-rights half is a premise-skip in E2E (no cross-account share is
provisioned — that is M4.4 groundwork) and is covered by the component tests. Server
notes: Stalwart derives `name.full` from the components and mints its own `uid`.

### M4.3 — Contacts ↔ mail integration

Spec: FR-CON-03/05/06. Size: M.

- [x] Composer autocomplete v2: all address books + recents, ranked by usage, avatars
      from contact photos (FR-CON-03) — plugs into the M2.4 interface.
- [x] From a message: "add sender to contacts" / "edit contact"; hover-card with contact
      info + recent-conversation link (FR-CON-05).
- [x] Import/export: vCard 4.0 and JSContact JSON via M4.1 (file picker/download,
      duplicate handling on import) (FR-CON-06). CSV import stays backlog (Could).

Done when: autocomplete prefers a contact over a stale recent; sender-to-contact flow
round-trips. — **Met 2026-07-25.** Autocomplete-prefers-contact is a deterministic unit
test; sender-to-contact and vCard-import round-trips are Playwright tests against the live
fixture (full `verify:e2e` green). Ranking is order-first + an `addressStats`-usage join
(no new telemetry); import dedupes by email with skip/keep-both (no merge); CSV stays out.

### M4.4 — Shared accounts

Spec: FR-AUTH-08. Size: M.

- [x] Surface non-primary accounts from the JMAP session as additional mailbox trees in
      the sidebar (visually grouped by account).
- [x] Replica/sync already account-scoped (M1.2/M1.3) — one engine per account (fleet),
      `accountId` in context, tests.
- [x] **Account-aware dispatch (stage 4, ADR-018).** Engine selection keyed by account;
      the keyboard layer and `useSearch` moved inside the acting-account scope; the drag
      subject carries its account. Closed B33/B35/B36 and the sign-out fleet teardown.
- [ ] Read/write per server-granted rights (**B34**) — **partly done.** Landed: the rule
      (`mail/rights.ts` — which right governs which write, quantified over the subjects'
      `mailboxIds` rather than the folder on screen; ALL rather than Stalwart's ANY; an
      account-floor clause that keeps the single-account path provably unchanged); the triage
      seam as defence in depth; `Button`'s `unavailableReason` (`aria-disabled` + an accessible
      description, and the control stays FOCUSABLE — `disabled` would hide the explanation from
      the one user who needs it); the **auto-mark-read dwell**, which no longer arms without
      `maySetSeen` — the only write nobody asks for, so silence is the right refusal; and
      "Empty Trash/Junk", the most destructive action in the app, which now gates on
      `mayRemoveItems` like its sibling entry always did. i18n keys in en + de.
      **The surfaces now refuse in the register each one can afford:** the reading-pane and bulk
      action bars and the label menu EXPLAIN (`aria-disabled` + an accessible description, and the
      control stays focusable); the swipe and the row drag go INERT, because there is nowhere under
      a finger to put a sentence and the bulk bar's Move button is the pointer alternative that does
      explain (SC 2.5.7); and the chords `u`/`s`/`e`/`!`/`#`-in-Trash gate on the same verdicts and
      SAY so — a keystroke that silently does nothing is defect B3 again. `l` stays ungated on
      purpose: it opens a picker, exactly like `v`, and the picker explains itself.
      **Still open:** the Undo in `useTriage` is offered even when the INVERSE move is not
      permitted (rights that allow a move do not imply the way back), and `MoveDialog`'s target
      list still filters silently rather than saying when nothing is left.
- [ ] Surface a shared account's sync status, queue and dead letters (**B32**) — today a
      failed write on a shared account is invisible.
- [ ] Identity handling when sending from a shared account (send-as): `FromField` lists only
      the provider account's identities, so reopening a shared draft autosaves into the
      primary's Drafts. Gating the reopen affordance to the primary is the cheap interim.
- [ ] Account-qualify the route (**B37**) — blocker for notifications on delegated accounts.
- [ ] Device-global storage maintenance and usage reporting (fan `runMaintenance` over
      `getRunningEngines()`, sum cache usage across accounts).
- [x] **E2E delegation fixture + `e2e/tests/shared.spec.ts`.** Settled by probing the live
      fixture, not by reading docs: sharing is `Mailbox/set` + `shareWith` keyed by the
      grantee's **principal** id, performed by the **grantor** (the admin cannot do it for
      them). The acceptance criterion holds — alice's session then lists the account with
      `isPersonal:false` and `urn:ietf:params:jmap:mail` in its OWN `accountCapabilities`,
      and she sees only the shared mailbox. Two findings that change other work:
      **`Account.isReadOnly` stays `false` even for a read-only share** (so the account
      badge is not a permission signal — B34 must gate on per-mailbox `myRights`), and
      writes beyond the grant are rejected **per id** as
      `notUpdated[id] = {type:'forbidden'}`, which the engine already classifies.
      Delegation is **opt-in**, not part of `provision()`: it turns the sidebar into
      account-grouped sections, which makes the `treeitem name=/Inbox/` locator used by 19
      call sites in 8 suites ambiguous (measured — enabling it broke the whole read suite),
      and it would leave the single-account path with no E2E coverage at all. The suite
      grants in `shared.setup.mjs` and revokes in `shared.teardown.mjs`; `smoke()` asserts
      the single-account default so a leaked share fails loudly at its source. Five specs
      green, in the `verify:e2e` gate as `e2e:shared`.

Done when: a fixture delegation setup shows the shared mailbox; actions respect rights;
primary-account UX unchanged.

Note (not a defect): multi-tab cost — a shared engine gets a no-op bus, so a shared-account
write dispatched from a NON-leader tab is persisted but not woken promptly; the leader's
engine drains it on its next sync/push/online event. Non-issue in the single-tab case.

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
      **Owner decision B19 (Gate G2, 2026-07-23) lands here.** The threat-model document must
      state what the FR-RD-08 link check is and is not: it compares the host a link's text
      claims against the host it opens, both written by the attacker (the CSS included), so it
      is **friction, not a boundary** — and **the absence of a warning means "nothing found",
      not "checked and safe"**. The interstitial's own copy was deliberately left unhedged,
      which is exactly why this has to be written down somewhere the reader can find it. §13
      row B19 lists the twelve open bypasses; the document states the shape of the limit, not
      the list, which would age into a false floor the day one is closed.
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
| D3 | Raise server baseline to Stalwart v1.0 (expected ~Oct 2026)? | Heiko | Gate G2 | **deferred 2026-07-21 (G2) — there is no v1.0 to raise to.** Checked against the GitHub releases API on the day: the newest release is **v0.16.14 (2026-07-20)**, preceded by .13 (07-12) and .12 (07-06). The baseline therefore stays **v0.16.x** (NFR-COMPAT-02) and the decision returns when v1.0 actually ships. What DID move is the pin *within* the baseline: `e2e/stalwart/docker-compose.yml` now runs **v0.16.14-alpine** instead of v0.16.11-alpine, which needs no ADR because NFR-COMPAT-02 already scopes the baseline to the minor line. The upgrade delta was read rather than assumed: the registry schema is purely additive across .12–.14 (0 removals), ADR-006's token posture is untouched, and no SSE/EventSource file changed. Revisit under D3 when v1.0 lands — and note D2's standing rider, that a v1.0 with browser-viable WebSocket auth would reopen the SSE-first decision. |
| D4 | Secure free namespaces early: GitHub org, npm `@waxwing` scope / package names (decision log #1 recommends) | Heiko | ASAP, independent of code | open |
| **D6** | **Reverse ADR-010 and build Web Push (FR-NOTIF-02)? — newly decidable, and it was not before.** ADR-010 deferred FR-NOTIF-02 on three grounds and named its own reversal condition: *"It is fulfilled the day a JMAP server ships RFC 9749 and a spec-conforming payload encoding."* **Stalwart v0.16.14 (2026-07-20) fulfils it on all three counts**, and all three are the reports in `docs/upstream/` — the base64-wrapped `aes128gcm` payload (fixed: `http.rs` now sends raw octets), the rejected unpadded base64url keys (fixed: `push/set.rs` uses `DecodePaddingMode::Indifferent`, verbatim the engine our report suggested), and RFC 9749 VAPID (implemented: `Capability::WebPushVapid`). Verified live against the bumped fixture, not inferred: alice's session carries `urn:ietf:params:jmap:webpush-vapid` with an 87-char unpadded base64url `applicationServerKey`, the exact shape `PushManager.subscribe()` wants. Stalwart appears to be the **first JMAP server to implement RFC 9749**. **What this decision is NOT:** the client half was never built and this session did not build it — no `PushSubscription` type in `@waxwing/jmap`, no subscribe flow, no `push` listener. **Sized honestly before deciding: this is an `L`, comparable to M3.6 itself** (~6 new files, ~10 modified, two packages, four documents). The cost driver is not the subscription handshake, which is small; it is that a JMAP push payload is a bare `StateChange` carrying no sender and no subject, so a banner raised while the app is CLOSED requires the service worker to make an authenticated JMAP call — dragging the access token, the AES-GCM `SecretStore` and the OAuth refresh path into a DOM-free worker, and requiring a fresh NFR-SEC-02/NFR-SEC-04 review. The honest cheap alternative is a contentless "New mail" with no sender, no per-folder filtering and no FR-NOTIF-05 actions. Note also that the closed-app half stays **unautomatable** (Playwright cannot observe a closed app), so it would be verified per platform by hand. Until this is decided the UI states the truth and no more (see the M3.10-followups row). | Heiko | Gate G2 / M4 planning | **decided 2026-07-23 (G2): BUILD IT, contentless — D6a. Sender+subject stays unbuilt as B28.** [ADR-017](adr/017-web-push-contentless.md); work package **M4.0**. The `L` above was sized on the assumption that a closed-app banner must fetch its own content. Probing the fixture before deciding cut that assumption away, and all three facts are measured, not inferred: (1) Stalwart's `StateChange` carries **`EmailDelivery`** as a type distinct from `Email` — captured live on the SSE channel while bob submitted to alice, `{"changed":{"b":{"Thread":"sae","Mailbox":"sae","EmailDelivery":"sae","Email":"sae"}}}` — so "new mail arrived" is separable from "another client read something"; (2) **`PushSubscription` carries a server-side `types` filter and Stalwart honours it** (created with a real P-256 key, `PushSubscription/get` returns `"types":["EmailDelivery"]`), so the server does the filtering and **the worker needs no JMAP call, no token and no `SecretStore` access at all** — which is what turns the `L` into an `M` and, more importantly, leaves NFR-SEC-02's boundary untouched; (3) the capability carries an 87-char unpadded base64url `applicationServerKey`, the shape `subscribe()` wants. **A fourth fact, found while probing and owned rather than buried: the subscription expires after 7 days and the ceiling is the SERVER's** — requesting `expires: 2026-10-21` returned `2026-07-30`, identical to omitting it (RFC 8620 §7.2 permits shortening). A client can only renew while running, so background notifications stop, silently, for anyone who does not open Waxwing within a week; M4.0 renews on start and states the limit in the settings (NFR-PRIV-02) rather than letting it lapse unannounced. **What D6a does not deliver, stated so the requirement is not read as fully met:** no sender, no subject, no count in the closed-app banner; **no per-folder filtering while closed** (`EmailDelivery` names no mailbox, so FR-NOTIF-03's per-folder preference applies on the live channel only and the UI must say so, not let a dead setting look effective); and no FR-NOTIF-05 actions, since archive and mark-read are JMAP writes needing the very token this option avoids. |
| **B1** | **Known defect (found in M3.8, not fixed there): `setKeywords` leaves a keyword-filtered window stale.** M3.8 fixed the same class of bug for `move`/`destroyEmails` (the cached `queryCache` window is now pruned + its `queryState` voided in the optimistic apply). `setKeywords` was left alone deliberately: it is **bidirectional** — marking a message read must REMOVE it from an `is:unread` window, but adding a label must ADD it to a `hasKeyword` window, and a prune cannot express that. Today, marking read/unread or (un)labelling leaves a `?q=is:unread` result or a `?label=` view showing the message until the server's push echoes back — and **offline, until reconnect**. Same two failure modes as the `move` bug. Fix before **G2** (see the M3.8 changelog entry for the mechanism). | — | Gate G2 | **FIXED 2026-07-20 (G2).** `setKeywords`' apply now runs in one `emails`+`queryCache` transaction like `move`, driving `updateWindows` with three effects. `filterPinsKeyword` is a **sibling** of `filterPinsMailbox`, not a generalisation: same AND-only recursion, and an **allow-list** — only `hasKeyword`/`notKeyword` are understood, the three thread-level conditions are refused because a single message's keyword can never disprove them. The bidirectionality that made this look hard dissolves into one polarity argument: `left` asks the predicate for `!value`, `entered` for `value`. **The scoping was wrong in a way the gap text above does not show:** the defect is not only about *filtered* windows. With the shipped "Unread first" toggle a just-read message stays **pinned to the top** of a window whose membership never changed — arrival and departure by **sort**, not by filter — which needed a third `WindowEffects` member (`resorted`) rather than the fold-into-`entered` the mapping proposed; that proposal was proven unable to fire (the guard it reused excludes exactly the windows the sort case is about) and the failed design is pinned as a mutation. Verification caught the sharpest thing here: **the allow-list test was passing for the wrong reason** — every window in it was routed to the prune branch, so widening the *arrival* branch to accept the thread-level conditions stayed green. Fixed with an entered-half twin. 12 + 1 mutations, all independently reproduced RED. **Offline scope, stated plainly:** the REMOVE direction is immediate; the ADD direction still waits for reconnect — the same limitation M3.8 recorded for moves, and the reason B1 and B2 are separate rows. |
| **B2** | **Known gap (found and half-fixed in M3.9): offline, a message moved INTO a visible window does not appear until reconnect.** A cached `queryCache` window is in the SERVER's collation (and, under `collapseThreads`, its entries are thread representatives), so the optimistic apply refuses to guess an index: a departure is pruned locally, an arrival only voids the baseline and waits for a re-query. M3.9 made the ONLINE case immediate (`runReplay` now reconciles the windows the apply voided — before that, Undo looked dead for up to 60 s). Offline there is nothing to re-query, so undoing an archive offline puts the mail back server-side-eventually but the row reappears only on reconnect. Fixing it means placing the row locally — feasible for the default `receivedAt desc, collapseThreads:false` window (compare against the neighbours' envelopes), wrong for a collapsed-thread or server-sorted window. Decide scope before **G2**; a partial fix gated on the window's sort/collapse is the likely shape. | — | Gate G2 | **FIXED 2026-07-20 (G2), owner scope: collapsed windows included.** **The gap text above rests on a false premise** — it calls the fix "feasible for the default `receivedAt desc, collapseThreads:false` window", but the default is `collapseThreads: **true**` (`backfill.ts`, `use-message-list.ts`), so the fix as written here would have covered essentially no real user while letting the row be marked done. A move now **splices** the arrival into the destination window in the same transaction as the envelope patch, behind four allow-listed gates: the filter provably accepts the envelope (AND-only; `after` is honoured, so a message older than the cache horizon is refused rather than appended past the tail), the sort is locally reproducible (`receivedAt`/`size`/`hasKeyword` only — `from`/`subject` are server collation, and the thread-keyword comparators are **refused** here although B1's void-only sibling accepts them), every neighbour envelope is actually present in the replica, and under collapsing the thread is not already represented. **Honest limit, recorded in the code rather than around it: under thread collapsing the POSITION is a guess too, not only the preview line** — the server orders collapsed results by a key it picks for the thread. It is a heuristic the next reconcile corrects, and it beats showing nothing at all, which read as a failed Undo. A **tail-drop rule** (an insert into an incomplete window pays for itself by dropping the last id, so `ids.length` is unchanged) closed two seams the mapping had listed as "no change required": `delta.ts`'s window ratchet and `MessageList.tsx`'s load-more re-arm, both left byte-identical. Rollback needed a genuinely new `retractWindows` — `invalidateWindows` only voids, and voiding leaves the phantom id in `ids` — intersected with `undoTargets` for partial rejection. 19 + mutations, all independently reproduced RED. **Effort was rated `medium` and was `large`.** |
| **B3** | **Known gap (found in M3.9 while hunting the keyboard flake): a triage chord whose target role mailbox does not exist does nothing, and says nothing.** `ShortcutProvider` runs `if (!isRunnable(action, context)) continue`; no other action claims `e`, so the loop falls through and the keypress evaporates — no toast, no hint, no log. Proven live by deleting alice's Archive mailbox: `e` produced no toast, no `aria-live`, no navigation, nothing (JMAP does not mandate an archive role, so this is a real account shape). M3.9 fixed the far worse half of this — the pane no longer *advances* over a move that never dispatched, which used to make it look like success — so what remains is honest inaction rather than a lie. Silence is right for "nothing to act on" (empty folder, no selection) but wrong for "this account has no Archive": the user deserves to know the key is inert. Decide the shape (feedback vs. hiding the chord from the cheat-sheet) before **G2**. Note `registry.test.ts` asserts only the registry's *shape*; `run-move.test.ts` (M3.9) is the first test of what a chord actually does. | — | Gate G2 | **FIXED 2026-07-20 (G2). Owner decision: both surfaces.** A `tone: 'warning'` toast at the press AND a dimmed, explained row in the `?` cheat sheet — the chord stays **listed**, because the key exists and the mailbox does not; an absent row would tell a different falsehood. The message names `v` (move-to-folder, which needs no role) as the way forward. The predicate had to be **split**, which the mapping missed and verification caught: the account-shape reason ("this account has no Archive") is independent of whether it is worth saying *right now*, and a single `unavailable()` gated on `targetIds.length > 0` would have shown the cheat sheet as available in exactly the state a user opens it — nothing selected, right after the key did nothing. **Scope boundary, by decision not oversight:** role mailboxes only; the self-move case and the transient roles-unresolved case stay silent. **Also reversed here, with an ADR (014):** the swipe's Archive→Trash fallback. A left-swipe configured "Archive" used to move mail to **Trash** on an Archive-less account while `e` refused the identical shape silently — and after B3 says so out loud, the two surfaces would have visibly contradicted each other. The direction is now inert. A gesture the user labelled "Archive" can no longer be the thing that bins mail, with no confirmation under a thumb and a reveal strip that said "Archive". **Note what remains:** the repo still has three answers for a missing role — the bulk bar hides the button, the reading pane disables it, the keyboard now dims and explains. B3 converged the keyboard onto the most informative one; it did not unify the other two. |
| **B4** | **Known gap (found in M3.9): the G1 decision D2 ("SSE-first") is not implemented in the app.** ADR-005 records that `prefer:'sse'` exists precisely so a browser "skips the (doomed) initial WS attempt entirely", but `engine.ts` calls `createPushChannel(session, options)` with no `prefer`, so every login still runs the runtime failover. Measured live: WS attempt at 85 ms → 401 → close, a second attempt at 584 ms → 401 → close, SSE request only at 586 ms. Costs ~500 ms of delayed push per login plus two console errors; push itself works (the failover is doing its job), so this is polish, not breakage — but it is a ratified decision that never reached the code, which is exactly the kind of drift ADRs exist to prevent. One-line fix; verify the WS transport stays reachable for the Node/server-side path ADR-005 keeps it for. | — | Gate G2 | **FIXED 2026-07-20 (G2) — and the "one-line fix" prescribed above is ACTIVELY HARMFUL; that characterisation must not survive.** `prefer` **reorders and never restricts**, so `prefer:'sse'` yields `['sse','websocket','polling']`. That is strictly worse than doing nothing: today SSE is the last real transport and a transient failure retries forever until it heals, but with WebSocket sitting *behind* it SSE acquires a failover target, two pre-open errors spend the budget, `advance()` lands on the un-authable WebSocket — itself terminal — and push is **permanently dead** for the session instead of self-healing. Measured, not reasoned: substituting the prescribed line into the new regression test yields `expected 'websocket' to be 'sse'`. And `channel.test.ts` carries a test named *"reorders (does not restrict) for an explicit prefer"*, so **the prescribed fix would have shipped green**. Actual fix: a genuinely restrictive `CreatePushChannelOptions.transports` allowlist in `@waxwing/jmap`, applied before the eligibility filter, plus `BROWSER_PUSH_TRANSPORTS = ['sse','polling']` in the app. `'polling'` is permitted regardless, so an allowlist can never silently produce a dead channel. Library default deliberately unchanged (MIT, published; the browser's WS auth problem is a property of the browser, not the library). The app-side blindness that let D2 drift for a milestone — three engine test files discarding `createPush`'s `options` entirely — is closed for `engine.test.ts`. ADR-005 amended, tech-stack §4.2 rewritten, `packages/jmap/README.md` reconciled at three contradicting sites. **Not verified: the payoff itself** — that the two WS 401s vanish from the browser console — needs a live check. |
| **B5** | **Fixed in M3.9 (5b prep), recorded because the CLASS is still open: CSS is the one layer nothing in this repo verifies.** Two defects, both invisible to `pnpm verify` and both measured in a real browser rather than reasoned about. **(1) The message list had no selection or current-row highlight AT ALL, since M1.6** (`7bb3b1e`): `message-list.module.css` referenced `--waxwing-surface-hover` and `--waxwing-surface-selected`, which were **defined nowhere** in `tokens.css`. An undefined custom property is invalid at computed-value time, so `.row:hover`, `.row[aria-current="page"]` (the OPEN message) and `.selected` (every ticked row) all computed to `transparent` — measured live: selected `rgba(0,0,0,0)`, opened `rgba(0,0,0,0)`, plain `rgba(0,0,0,0)`, identical. For eight milestones the reader could not see which message they had open. **(2) The move picker had no focus indicator** (WCAG **2.4.7, Level A**): `reading.module.css` paired `outline: none` with `box-shadow: var(--waxwing-focus-ring)`, and that token is a bare colour — `box-shadow` requires offsets, so the declaration was dropped and nothing replaced the outline it had just removed (measured: `boxShadow "none"`, `outlineStyle "none"`). It shipped in M1.8's `MoveDialog` and M3.9's `FolderMoveDialog` inherited it — i.e. the keyboard path that SC 2.5.7 makes the *prerequisite* for the drag was itself unfocusable. **Why nothing caught either:** CSS custom properties are not typechecked; Biome, `tsc` and `size-limit` are all blind to them; `expectNoA11yViolations` runs under jsdom, which computes no CSS; and the E2E assert `aria-current`, never colour. **The gap that remains:** the contrast test now pins the two new fills, but nothing pins that a referenced token EXISTS, or that a focus style resolves to something visible. A token-reference lint (grep every `var(--waxwing-*)` against `tokens.css`) is cheap and would have caught (1) on the day it landed; the focus case needs a real browser. Decide before **G2**. **(3) A third instance, M3.9 step 5 (swipe): `touch-action: pan-y` on the row wrapper silently disabled PINCH-ZOOM across the entire message list.** The property's grammar is `[ pan-x \|\| pan-y \|\| pinch-zoom ]` and whatever is not named is DISABLED — so the one declaration that gives the browser back its vertical scroll also took zoom away, and `.rowWrap` tiles the whole virtual list contiguously, making the app's primary surface a zoom-dead zone. `index.html` deliberately keeps zoom available everywhere (no `user-scalable=no`, no `maximum-scale`); killing it here would have been a **WCAG 1.4.4** failure for low-vision users, shipped by a correct-looking one-liner. Fixed to `pan-y pinch-zoom`. **No tool caught it and none could have:** jsdom computes no CSS, so `touch-action` is invisible to every unit test and to `expectNoA11yViolations`; Biome and `tsc` do not read CSS semantics; and the value is *valid* CSS, so a linter would have had nothing to say. It was caught by reading the property's own grammar, not by anything in the pipeline — i.e. exactly the class this row tracks, now with an instance whose only defence was a reviewer's attention. The new `chromium-touch` E2E project pins `pan-y` AND `pinch-zoom` on the element the finger lands on, which is a regression net for this one rule, not for the class. | — | Gate G2 | **FIXED 2026-07-20 (G2) with TWO static checks, not the one proposed → ADR-015.** The mapping produced the evidence that changed the scope: **the focus class has produced three of the four known instances, and the token lint finds nothing at all today.** So B5 ships (1) the proposed **token-reference lint** — every `var(--waxwing-*)` resolves, all theme override blocks carry the same keys as `:root` (a naive `:root` regex matches the wrong block and the assertion passes **vacuously**, so a mutation proves it does not), and the three token names `public/theme.css` shows hosters by example still exist — and (2) a **focus-indicator guard**: a rule may switch the focus outline off only if it scopes the suppression away from keyboard focus, supplies a replacement on a sibling `:focus-visible` rule, or carries a `/* waxwing-focus-exempt: <reason> */` comment whose reason is mandatory and machine-checked, with stale exemptions failed so the licence cannot outlive its use. **The guard immediately found two live WCAG 2.4.7 (Level A) defects, both of which shipped AFTER the M3.9 fix of the same class:** the primary To/Cc/Bcc entry had no focus indicator at all since M2.4, and the label menu signalled keyboard focus only by a fill identical to hover (measured 1.19:1 light, 1.23:1 dark — invisible). Both fixed, each in the shape its own specificity forced. **Dead tokens warn, never fail.** **The class is NOT closed:** these two checks cover the two shapes that have actually fired; neither can see rendered output, so a ring that exists but is invisible against its background passes both — see **B6**. |
| **B6** | **Open (filed by B5, 2026-07-20): a browser-side computed-style focus sweep.** B5's two static checks read stylesheets; neither can see rendered output, so they prove a stylesheet no longer *says* the wrong thing, not that anything *looks* right — a focus ring that exists but is invisible against its background passes both, as does a token that resolves to the wrong colour. The generic check: for every element reachable by Tab on the main screens, assert `getComputedStyle` yields a non-`none` `outlineStyle` or a `box-shadow`, and that the focused appearance differs **measurably** from the unfocused one. The seam already exists (`page.evaluate` is used in `keyboard.spec.ts` and `swipe.spec.ts`). It is not mechanical: it needs a false-positive budget, a threshold for "differs measurably", and an opt-out story that lines up with the `waxwing-focus-exempt:` convention ADR-015 established. It is the only check that covers this class **generically** rather than one rule at a time — the static guard catches the *suppression* shape only. | — | Gate G3 / M4 a11y pass | open |
| **B7** | **Open (surfaced by B1+B2, 2026-07-20; pre-existing): folder counts go stale where the list no longer does.** `Mailbox.unreadEmails` / `totalEmails` are server-owned and are not patched optimistically. Until B1/B2 that was invisible, because the *list* was equally stale; they made the list update instantly, so the row now moves while the folder-tree badge beside it does not. Offline that gap lasts until reconnect. A genuine local-computation question, not a copy of the window fix. | — | Gate G2 | **FIXED 2026-07-21 (G2).** A DELTA PATCH, never a recompute — the replica holds a bounded, actively-shrinking horizon, so a local recompute of `totalEmails` is not merely stale but categorically wrong on any account larger than the cache window; it would trade a briefly-stale badge for a permanently confident wrong one. `countDeltasFor(intent, preimage)` is a pure function beside `updateWindows`, `adjustMailboxCounts` clamps both fields at zero, and `db.mailboxes` joins all three optimistic transactions so the count moves inside the same atomic unit as the envelope. `destroyEmails` now reads a pre-image at all (it previously read none). `$seen`-only for `setKeywords`; `totalThreads`/`unreadThreads` deliberately untouched, because a per-message mutation cannot imply a thread-count delta. **The brief's central prescription was wrong, and so were BOTH of my corrections to it — this row took three rounds to get right and the reason is worth keeping.** (1) It said to re-apply every row in `pendingOutbox`; that includes `inflight`, whose effect may already be in the server's number, and a double-count does NOT self-correct. (2) I narrowed it to `status === 'pending'`, arguing a pending row "has by definition never been dispatched" — **false in this state machine**: `recoverStranded`, an auth expiry, a thrown transient error and a per-object `rateLimit` all launder an already-dispatched row back to `pending`. (3) I then prescribed `attempts === 0` plus one increment in `recoverStranded`; the implementer found auth expiry does not increment either, and a checker found the fourth path. The shipped predicate is `status === 'pending' && attempts === 0` with **all four** paths incrementing, the enumeration of `status: 'pending'` writers re-derived and recorded as closed, and the asymmetry stated in code: **a missed re-apply self-corrects, a double-count does not — so when in doubt, SKIP** (residue: **B18**). Three guards that were correct and completely untested had to be pinned afterwards, two of them measured producing real wrong numbers. Two dialogs now quote the optimistic total (delete-folder, empty-folder), which is right and is disclosed. |
| **B8** | **Known gap (found in M3.9/B2 mapping, 2026-07-20; pre-existing, not a regression): a BULK move places none of its arrivals if the window already lists any one of them.** `updateWindows` split on membership with `window.ids.some(id => touched.has(id))` — one id present marked the whole window "listed", so a move of `[e1,e2]` into a window already showing `e1` placed neither and did not even void. | — | Gate G2 | **FIXED 2026-07-21 (G2).** The forward fix is the one-line quantifier inversion the row predicted (`emailIds.some(id => !holds.has(id))`, a `Set` per window so a 50-id bulk is N O(1) probes) — and it is the only part of this row that went as written. **What the row did NOT say, and a checker had to prove: the inversion WIDENS a known over-retraction in the rollback.** Before it, a window that already listed a touched id could never be in `insertedKeys`; after it, it can, so a rejected bulk move strips ids the window held *before* the mutation — and where inserts evicted the tail, the whole head page, leaving `{ ids: [], total: 41 }`. **An exact retraction was attempted, shipped, and then REVERTED** (see **B14**): narrowing the drop set by `hadTo` is unsound because `hadTo` is scoped to the ENVELOPE while the question is scoped to the WINDOW — a `hadTo` id the window does not list *is* spliced in by the apply and would then never come back out, nor would its `total`. Every B8 fixture put the `hadTo` id inside `window.ids`, so that branch was reached by no test and the unsound narrowing **shipped green**; the test whose absence allowed it is now the first one in the block. Also pinned here: the `entered` gate is deliberately NOT filter-aware (**B15**), arrivals are placed in intent order with the index recomputed against the running `ids` (pre-sorting is strictly worse on an incomplete window), and the order-independence claim was narrowed — it holds only for DISTINCT sort keys, because `compareSortKeys(...) < 0` is strict so equal-timestamped arrivals tie in by arrival order, which is the normal case for bulk-delivered mail. |
| **B9** | **Known gap (carried from M3.9, 2026-07-19): the bulk bar's FLAG button is hard-wired to `setFlagged(ids, true)` while the `s` chord toggles.** Two entry points to one user intent that do not agree. The row estimated "a two-line fix via `triage.setFlagged`". | — | Gate G2 | **FIXED 2026-07-21 (G2) — and the row's "two-line fix" was FALSE in a way that mattered.** Copying the read/unread control's predicate would have RELOCATED the drift, not closed it: `allSeen` is computed from `rowById`, which is hydrated from the VIRTUAL WINDOW only, while the `s` chord hydrates from the full target set — so select-all-then-scroll makes button and key disagree again, and the off-screen rows resolve to `undefined`. **The read/unread button had the identical defect and nobody had filed it**; both are fixed here by computing the predicates inside `BulkBar` from its own `useEmailWindow(ids)` with the four-clause guard shape (an unhydrated result must not count as qualifying). Two further defects rode on the same control: the label was permanently "Flag" though it now toggles (`IconButton`'s `label` IS the accessible name; both keys already existed in en and de), and it drew a `Flag` where every other surface draws a `Star`. The multi-selection predicate was NOT an open design question — precedent settles it as "set unless every target already has it". The proving test needed a **≥30-row fixture**: the jsdom harness stubs a 600 px viewport and renders ~16 rows, so any smaller fixture puts every selected id inside `rowById` and the mutation stays green. Two residues filed rather than absorbed: `BulkBar` now runs a THIRD live subscription over the same selection (**B10**'s shape), and there is no mark-as-READ chord at all (**B16**). |
| **B10** | **Open (root-caused while fixing a G2 test flake, 2026-07-20): every `useMailboxes()` call site is an independent liveQuery, so components can disagree about the mailbox list for one round-trip.** `useMailboxes()` is a plain `useLiveQuery`, and there are at least three live subscriptions in the triage path alone — `MessageList`, `useShortcutContext`, and `useTriage`'s own `useMailboxByRole`. They resolve on different ticks. **Proven directly, not inferred:** with the reveal layer already re-rendered without Archive, `e` still dispatched `{kind:'move', to:'archive'}` into the mailbox that had just been deleted. Bounded — one Dexie `storagemutated` → re-query → render cycle, single-digit ms, and only reachable if a *concurrent* client mutates the mailbox list at that instant — and it fails **visibly**, not silently: the move lands in the outbox, the server rejects it against a destroyed mailbox, and `use-outbox-problems.ts` surfaces it as a dead letter with retry/discard. Not shortcut-specific, so fixing it in one layer would be theatre. The airtight fix is **one shared mailbox subscription app-wide**, which is an architectural change and needs its own ADR — deliberately not attempted as part of a flake fix. **What this row really tracks is the test hazard**, which has now bitten twice (M3.8's `j o e u x #`, and this): an assertion barrier that waits on component A proves nothing about component B, and an ABSENCE assertion under that barrier passes while proving nothing. | — | Gate G3 / M4 | open |
| **B11** | **Open (filed by M3.10's scoping, 2026-07-20): the suite runs on ONE engine.** All four Playwright configs declare only `devices['Desktop Chrome']` and `verify-e2e.mjs` installs only chromium, so every browser-verified claim in this project is a Chromium claim. M3.10 dropped "WebKit installability" because WebKit has no install API to test — but that is an argument against testing *installability* on WebKit, **not** against engine breadth. The places where engine differences actually bite are the **sanitizer and the reading pane** (`@waxwing/mail-html` runs untrusted HTML through a sandboxed frame; WebKit's parser, CSS handling and iframe sandbox semantics differ from Blink's), plus layout of the split pane and the virtual list. A WebKit project over the READ suite would be worth more than any installability audit. Cost: a `playwright install webkit` in the gate, one project, and triage of whatever it finds — which is the real cost, and the reason this is filed rather than smuggled into M3.10. | — | M4 (a11y/polish pass) | open |
| **B12** | **Open (noticed while retargeting `shell.spec.ts`, 2026-07-20): `LoginForm` takes a `productName` prop and never renders it.** The sign-in step's `<h1>` is `auth.signInTitle` — "Sign in to {host}" — so the FIRST screen a visitor sees carries the server's hostname and no product identity at all. For the stock deployment that is merely plain; for a **white-label** one it is a gap against FR-DEP-04 (a *Must*), because the hoster's branding is configured, loaded, and then not shown at the one moment the user is deciding whether they are in the right place. Deliberately NOT fixed inside an E2E work package: whether the sign-in card should carry the product name, the logo, both, or neither is a design decision, not a wiring omission — and it is the reason no honest branding assertion can be written against that screen today. | — | M4 (theming/polish) | open |
| **B13** | **Open (noticed by M3.10 wave 3, 2026-07-20): two a11y regions are both named "Notifications".** The Settings section and the toast live region carry the same accessible name, which forced the settings E2E to disambiguate with a `filter()`. A test can work around it; a screen-reader user cannot — "Notifications" announced twice on one screen, meaning two different things, is a genuine navigation ambiguity. Not fixed by the test wave, deliberately: which one gets renamed (and to what) is a copy and IA decision, not a wiring fix. | — | M4 (a11y pass) | open |
| **B14** | **Open (2026-07-21, opened and closed by the B8 work): the window retraction is deliberately inexact, and making it exact needs a design change the persisted undo forbids.** `retractWindows` removes by intersection over the whole undo id set, because `insertedKeys` records WINDOWS, not which id landed in which window. That over-retracts: a rejected bulk move strips ids the window held before the mutation, and where the inserts evicted the tail it can empty the whole head page. A one-line narrowing (`ids.filter(id => !hadTo.has(id))`) was implemented and REVERTED the same day — `hadTo` is a property of the ENVELOPE, so it wrongly protects a `hadTo` id the window never listed, which the apply *did* splice in; that id and its `total` would then survive the rollback forever. Doing it correctly requires recording which ids were inserted into which window, i.e. growing `insertedKeys` from `string[]` into a per-window id map — and it is PERSISTED (`db.ts`, `OutboxUndo.insertedKeys`), so this is a schema and payload decision, not a refactor. `outbox.ts` states that growing the undo is the one thing it may not do. Both directions self-correct via the forced re-query, ONLINE only. | — | M4 / post-G2 | open |
| **B15** | **Open (2026-07-21, accepted cost of B8, pinned by its own test): the `entered` gate is not filter-aware, so a window that already holds every id it could accept is voided anyway.** The gate asks "does the intent contain an id this window does not LIST?"; it cannot ask "…that this window would ACCEPT", because the only per-id filter check available (`windowAcceptsLocally`) is an allow-list that REFUSES what it cannot decide — using it as a gate would skip the void exactly where we are least sure. Measured: a window `AND(inMailbox:archive, hasKeyword:$flagged)` listing `e1`, given a move of `[e1,e2]` where `e2` is unflagged, is voided where the old gate kept it. Over-voiding costs one re-query; under-voiding is a wrong list — so the direction is deliberate. Note B8 traded an under-void (correctness-adjacent) for an over-void (cost only). The accepted-cost test is the one to flip if this is ever made filter-aware. | — | M4 / post-G2 | open |
| **B16** | **Open (found 2026-07-21 while fixing B9): there is no mark-as-READ keyboard chord at all.** `setSeen` occurs exactly ONCE in the shortcut registry and only ever with `false` — `u` (`triage.unread`) is an unconditional mark-UNread with no predicate, so it cannot drift and it also cannot toggle. Every other triage verb the bulk bar exposes has a chord; read does not, in the read direction. This surfaced because B9's comment claimed `s`/`u` parity and only half of it was true. Product decision, not a cleanup: decide whether read/unread gets one toggling chord (matching `s`) or a second chord, and whether the cheat sheet changes with it. | — | M4 (keyboard/a11y pass) | open |
| **B17** | **Open (2026-07-21, found by a checker reading `delta.ts` after the B9 empty-state guard landed; UNPROVEN, and the experiment is the work): `applyQueryChanges` can write `ids: []` with a non-zero `total` and a NON-NULL `queryState`, which no detector recovers.** `delta.ts`'s `applyQueryChanges` filters removals out of `row.ids`, then drops any compensating `added` entry whose `index > ids.length`. If a `queryChanges` removes the whole head page and re-adds those ids far down (the plausible trigger: an "Unread first" keyword-sorted window whose head page is marked read from another device), the row is written empty but NOT voided — so `fullRequery` never fires, the next pass computes from `newQueryState` and finds nothing changed, and the window sticks while ONLINE. Every other producer of that shape voids. Grepped: no `queryCache` writer detects empty-ids-with-non-zero-total. **Not observed** — a strict RFC 8620 §5.6 server may instead raise `cannotCalculateChanges`, which `delta.ts` already rescues with `fullRequery`. First task is therefore to PROVE OR REFUTE it against Stalwart, not to fix it; if real it also falsifies the `list.stale` string's "will refresh" promise on that path. | — | M4 / post-G2 | open |
| **B18** | **Open (2026-07-21, the honest residue of B7): the optimistic count patch is not re-applied for an intent that may already have reached the server.** `reapplyPendingCounts` re-applies only rows that are PROVABLY undispatched (`status === 'pending' && attempts === 0`, with all four laundering paths made to increment `attempts`). Anything ambiguous — in flight, or returned to `pending` after a thrown error, an auth expiry, a stranded leader or a per-object rate limit — is SKIPPED, because a missed re-apply self-corrects (the badge reverts until the intent lands) while a double-count does not (the mailbox is only re-reported when it changes again). So in those cases the folder badge still reverts to the server's pre-mutation number until the intent completes. Deliberate and fail-closed, recorded so it is not rediscovered as "B7 didn't work". | — | M4 / post-G2 | open |
| **B19** | **Open (2026-07-22, the central finding of the G2 review): the link-phishing gate (FR-RD-08) is a best-effort heuristic, not a security boundary, and its enumeration of defeated techniques is OPEN.** The gate compares the host the link TEXT claims against the host it actually opens. Both come from text the attacker writes — including the CSS. Four fix waves and roughly 250 attack probes were spent here and *every* wave's independent checker found a family the wave before it had not imagined: a hidden `<span>` with a space (the original report), the same without a space so the words FUSE (`evil.tld/bank.test` — one token, the visible claim replaced rather than added to), `display:none!important` (the anchored regex; and `!important` is the spelling real mail overwhelmingly uses), twelve geometric vectors (`position:absolute;left:-9999px`, `clip-path`, `transform:scale(0)`, `text-indent`, `max-height:0`), `<img alt>` (and our own remote-image blocking is what GUARANTEES the alt renders, so a privacy default makes the attack reliable), `<input type=image alt>`, U+2800 BRAILLE PATTERN BLANK (renders as a gap, is neither `\s` nor `\p{Cf}` — no markup at all), and U+202E RIGHT-TO-LEFT OVERRIDE (`‮nigol/tset.knab` renders as `bank.test/login`; stripping it made the gate read a string nobody saw). **What was actually achieved, and it is real:** the quantifier was inverted (ANY honoured claim used to clear a link; now EVERY claim must be honoured, so hidden text can only make the verdict stricter), claims are unioned over two renderings (raw `textContent` plus one separated at element boundaries, so neither fusing nor splitting alone defeats it), attribute-borne labels are read, bidi overrides fail closed, and — the shape change that matters most — **the sanitizer's anchor rule became an ALLOWLIST of CSS properties instead of a denylist of hiding techniques**, which is why wave 4's checker could not break the property filter itself after 64 attempts. **Known open, none of them closed and none of them claimed closed:** `<bdo dir="rtl">` (the markup spelling of U+202E, pinned as `ok` in its own test); chromatic hiding (`color:#fff` against the frame's known white canvas — kept DELIBERATELY, because dropping `background` while keeping `color` would render legitimate white-on-coloured button text invisible, a worse defect than the one it fixes); a large POSITIVE `padding-left`/`border-left-width` displacing a run out of the visible column (a magnitude ceiling composes away under nesting); `aria-label`, which forms the accessible name and is read by nothing, so a screen-reader user gets no interstitial at all; the anchor's OWN inline style is never filtered (true for hiding, false for `direction`/`unicode-bidi` REORDERING); `splitDeclarations` closes a CSS string only on the matching quote where CSS also ends one at a newline (§4.3.5 bad-string-token), so a declaration we believe rejected can be applied; a digit inside a leading CSS comment is read as the size (`font-size:/*9*/1px` is kept while the browser renders 1px); `CSS_NUMBER` reads `5e-10px` as magnitude 5 with unit `e`, so scientific notation clears the size floor and is rejected today only *incidentally*, by the negative-value rule tripping on the exponent's minus — it comes apart the moment that rule is narrowed; `title` naming a host; bare-IP claims; `bank.test@evil.tld` userinfo; `bank。test` with U+3002; and the whole no-PSL family. **The product question, which is the owner's and is deliberately not answered here:** the interstitial was built non-disableable, which reads to a user as a guarantee — but the ABSENCE of a dialog means "nothing found", not "checked and safe". Either the copy says so or the app overclaims. No user-visible string was changed. | Heiko (copy) / — (code) | Gate G2 decision; code M4 | **copy question decided 2026-07-23 (G2): the dialog is not touched.** The interstitial's own text is accurate whenever it appears — it claims a mismatch was found, and one was. The honest gap is the *absence* of the dialog, and a hedge inside the dialog would land on the one reader who is being warned correctly, weakening the warning that did fire in order to qualify the ones that did not. The limitation is documented instead, where ADR-010's amendment already put the same kind of admission: **NFR-PRIV-02, "honest documentation of what a static client cannot do"** — release notes and the security guide of **M4.9**, which must state that Waxwing's link check compares the claimed host against the target and is best-effort against an attacker who writes both the markup and the CSS, and that no warning means "nothing found", not "checked and safe". **The code half of this row stays open**: the twelve named bypasses above are unfixed and none is claimed fixed. |
| **B20** | **Open (2026-07-22, G2 review): accessibility residue across the M3 surfaces.** Eight findings, each confirmed by two independent reviewers, none fixed because each is a small design decision rather than a wiring omission. (1) Attachment Preview/Open buttons carry no filename, so a message with N attachments exposes N identically-named buttons. (2) The reading-pane action bar declares `role="toolbar"` and implements none of the toolbar keyboard model (no roving tabindex, no arrow navigation). (3) Label create/rename validation errors render as a plain `<p>` — no `role="alert"`, no focus move — so the submit appears to do nothing and says nothing. (4) The command palette announces nothing when a query matches no actions, while keeping `aria-expanded={true}` and dropping `aria-activedescendant`. (5) Every label row's overflow menu is named "Label actions", one identical name per row. (6) Four `<span>` group headings in the server settings panel leave four `<dl>`s unlabelled. (7) The search chip strip carries the same accessible name as the search input AND is pulled into the input's `aria-describedby`. (8) Sidebar lists render nothing while loading where the message list shows a spinner. Related and already filed: **B13** (two regions both named "Notifications") and **B6** (nothing verifies rendered focus). | — | M4.7 (a11y audit) | open |
| **B21** | **Open (2026-07-22, G2 review): the M3 surfaces disagree with each other in ways a user notices.** (1) `#` is titled "Move to Trash" in the command palette and the cheat sheet, and inside Trash it runs a PERMANENT destroy; the same chord acts on one message when many are selected, or refuses silently. (2) The same intent is drawn with different glyphs across surfaces — Junk is `Ban` in the list and `MailWarning` in the reader, unread is `Mail` vs `MailMinus`. (3) "Delete older than…" is not styled destructive although in Trash/Junk it permanently destroys, while "Empty Trash" and "Delete folder" are. (4) The move picker lists folders flat with no path, so `Archive/2024` and `Projects/2024` are indistinguishable buttons named `2024`. (5) "Remove from this label" is silent and irreversible while the folder move beside it toasts with Undo. (6) The search scope control says "This folder" and "All mailboxes" in one dropdown, for the same concept. (7) Three cleanup dialogs name the folder with the raw server name where the menu item that opened them used `folderDisplayName`. (8) The `?` cheat sheet omits every message-list key — Space, Enter, arrows, Home/End, Escape and ⌘A — so select-all has no documented keyboard route. Apple Mail is this project's stated reference; most of these have a convention to follow. | — | M4 (polish) | open |
| **B22** | **Half fixed (2026-08-16); the other half open. Two test surfaces that look like coverage and are not.** (1) **Fixed:** the `@waxwing/jmap` integration suites (`vitest.integration.config.ts`) ran in NEITHER `pnpm verify` nor `pnpm verify:e2e`, and they `describe.skipIf` themselves away when the fixture is down — so a skip was indistinguishable from a pass and nothing had ever failed because they did not run. `pnpm gate` (ADR-019) now runs them against a live fixture **and asserts nothing was skipped**, which is the only form of the fix that holds: running them is not enough, the pipeline has to prove they ran. First real run: 8 tests. (2) **Still open:** `apps/web` resolves `@waxwing/mail-html` to built `dist/`, not `src/`, so a bare `pnpm vitest run` after editing that package silently tests the OLD library. `pnpm verify` runs `build:libs` first so the gate is sound; the hazard is every path that is not the gate, and nothing warns. | — | M4 (release engineering) | half-fixed |
| **B23** | **Open (2026-07-22, G2 review): a commitment handed from M3.4 to M3.7 was never built and was never tracked.** M3.4 recorded that `cacheDays`/`maxStorageMB` stay deployment config and that "a user override is M3.7"; M3.7 shipped without one and nobody noticed, because the deferral lived in a work-package note rather than in this table. `StorageSection.tsx` shows the window read-only. Decide whether the override is wanted at all — FR-OFF-02's "configurable" is ambiguous between hoster-configurable (already true) and user-configurable (not built) — and if not, say so in the spec rather than leaving the note dangling. | Heiko | M4 planning | open |
| **B24** | **Open (2026-07-22, G2 review): dead wiring.** `list.actions.notJunk` ("Not junk" / "Kein Spam") is translated in both locales and referenced nowhere — unlike the flag/unflag and read/unread pairs beside it, the junk action has no inverse in the UI, which is a missing FEATURE hiding as a stale key. Five further keys are translated and unreferenced (`shell.notFound.home`, `onboarding.connect.discovering`, `onboarding.error.config`, `auth.error.oauthUnavailable`, `mailbox.rename.nameLabel`); `onboarding.error.config` may indicate a missing config-validation path rather than a stale string, so check before deleting. Eleven exported repository/status/route helpers have no callers outside tests (`lruBodies`, `getEmailBody`, `emailsInThread`, `emailsInMailbox`, `outboxRow`, `upsertAccount`, `listAccounts`, `getAccount`, `getThread`, `patchEngineStatus`, `MANIFEST_FILENAME`). | — | M4 (cleanup) | open |
| **B25** | **Open (2026-07-22, G2 review; UNPROVEN — the experiment is the work): four security questions the review raised and could not settle.** Each needs a real browser or a live fixture, which review agents are not permitted to touch. (1) The app's `<meta>` CSP is inherited by the mail body's `srcdoc` iframe (a srcdoc document is a local-scheme response inheriting the parent policy) — establish whether that is doing work or whether the frame's isolation rests on `sandbox` alone. (2) `sanitizeToDOMFragment` in the composer (`squire-adapter.ts:40-46`) runs DOMPurify with NO `USE_PROFILES`, so SVG and MathML sit in the default allowlist — unlike the reading-side lockdown. Pasted content is attacker-adjacent. (3) `MessageView.tsx:161` falls back to the RAW `joinedHtml` when `sanitized` is null (inline images not yet downloaded) and that value reaches `buildReplyDraft` — determine whether unsanitized HTML can enter a draft. (4) Whether a navigation request to a JMAP path can reach the service worker's `NavigationRoute` under a `/mail/` mount, where `navigateDenylist` is anchored at the mount root. Prove or refute each before fixing anything. | — | M4 (security pass) | open |
| **B26** | **Open (2026-07-22, G2 review): the auto-mark-read dwell can still be undone from OUTSIDE the reading pane.** The dwell timer cancels correctly when the open message is marked unread in the reading pane. Two entry points are neither scope-gated nor covered, both pointer events on the list that stays interactive beside the open pane: the bulk bar's read/unread toggle and the swipe-right read action. Additionally the bulk bar's `allSeen` predicate is computed from a `useLiveQuery` that keeps returning its last resolved value while a new query is in flight, and its guard only compares cardinality (`selectedRows.length === ids.length`) — verified at the library level in `dexie-react-hooks` — so an equal-cardinality stale result passes and the "toggle" can issue a mark-unread against an already-unread message. Same class as **B10**: an assertion barrier that waits on component A proves nothing about component B. | — | M4 | open |
| **B27** | **Open (2026-07-22, G2 review): three documented guarantees are narrower than their prose.** (1) `maintenance.ts:23-24` says the pass "NEVER throws", but only the chunked deletes are wrapped — the READ stages are not. (2) `sw.ts:18` says "every route below is anchored to the app's own directory"; the `NavigationRoute` is the one that is not. (3) ADR-015's focus guard asserts that stale exemptions fail, but the test compares COUNTS, not identities, so a removed exemption and an added one cancel out. (4) `MailBodyFrame.tsx`'s `onOpenLink` doc still describes `info.text` as "what the reader saw"; since the link gate started classifying over two renderings plus attribute labels, `text` is the classification rendering and `raw` is the display field. None is a live defect; all four are the class this project has repeatedly been burned by — a comment asserting a property the code does not have, which the next person builds on. | — | M4 | open |
| **B28** | **Open (2026-07-23, the deferred half of D6a): the closed-app banner names no sender and no subject — D6b.** M4.0 ships Web Push contentless, because a JMAP push payload is a bare `StateChange` (RFC 8620 §7.1) carrying a state string per data type and nothing else. A banner reading *"Bob — Re: the quarterly figures"* needs the service worker to fetch that message itself while the app is closed, which means an authenticated JMAP call from a DOM-free worker: the access token, the AES-GCM `SecretStore` and the OAuth refresh path all cross into the worker, and the refresh **rotation** then lives in two contexts that must not both run it. **That is the property M4.0 is worth protecting** — as shipped, no token and no `SecretStore` access enters the service worker at all, so NFR-SEC-02's boundary is untouched by background push. B28 trades that away, and must therefore carry its own **owner decision and a fresh NFR-SEC-02/NFR-SEC-04 review**, not be folded into a later work package as an enhancement. Note that FR-NOTIF-03's *"preview content on/off"* is met by construction while closed (there is no content to leak) and only becomes a real toggle if B28 is built. Per-folder filtering while closed is a **separate** gap with the same root and is not fixed by B28 either: `EmailDelivery` names no mailbox, so the folder would have to be fetched too. | Heiko (decision) / — (code) | post-V1 | open |
| **B29** | **Open (2026-07-23, M4.0): the closed-app banner has never been observed working — and the FIRST hand-check run found three defects, none of which any test in this repo could have caught.** (1) **The permission was per-component state.** `useNotificationPermission` held it in a `useState`, so the settings screen granted it into ITS copy while `PushSubscriptionHost` — the component that actually subscribes — kept a stale `default` and never subscribed. Permission granted, switch on, nothing happening, nothing on screen able to explain it. Both fallbacks missed: `visibilitychange` never fires when the tab stays visible, and Safari does not deliver the Permissions API `change` event for `notifications` — which this repo's own comment already said, in the file the bug was in. Fixed with a shared store (`permission-store.ts`): the permission is a property of the BROWSER, not of a component. (2) **The verification code was posted and not parked.** `sw.ts` parked it only when no window was open, treating `postMessage` as the primary route — but a window WAS open, the listener was not attached yet, and the code was gone for good, leaving the subscription unverified forever with the server pushing nothing but the verification it was still waiting for. It is now parked unconditionally and the message is only the fast path. (3) **`navigator.serviceWorker.startMessages()` was missing**, without which a container that uses `addEventListener` (rather than `onmessage =`) never drains its queued messages at all. All three are fixed and mutation-proven; the observation that found them was a human closing a tab. **What is still unproven is the delivery itself.** Everything AROUND it is tested — the subscribe flow, the `PushVerification` round-trip, the renewal margin, the frame classifier, the four reasons to stay silent, the sign-out teardown, and a `check:dist` gate proving the shipped worker carries no credentials. **The delivery itself is not.** Playwright cannot observe a closed app, and Chromium in the harness has no push service to mint an endpoint against, so `PushManager.subscribe()` fails and the app degrades to `unsupported` — which is correct behaviour and also means the automated suites can never exercise the path. M4.0 shipped on that basis deliberately, because the alternative was to hold a finished feature behind a manual step; but the honest status is that the one behaviour the work package is named after is unproven, and no test in this repo can change that. **A harness now exists for it** (2026-07-23): `pnpm webpush` builds the PRODUCTION bundle — the step that cannot be skipped, since `devOptions.enabled: false` and the PROD-only registration mean `vite dev` has NO service worker at all — brings the fixture up advertising the browser's own origin, and serves at `http://localhost:5174` behind the same-origin JMAP proxy. `pnpm webpush:deliver` submits a real message from bob (a submission, not an `Email/set` create: only an actual delivery moves `EmailDelivery`), `--read` marks one read instead, and `pnpm webpush:status` prints the server's view — the `types` filter and whether the RFC 8620 §7.2.2 verification completed, the two ways a subscription is silently useless. **From another machine, tunnel rather than expose:** `ssh -L 5174:localhost:5174 <user>@<host>` makes the origin `localhost` on the client too, which is exactly what the Push API asks for — so **Safari on a MacBook can drive this**, and macOS Safari 16.1+ does Web Push for ordinary websites with no Home-Screen step (that rule is iOS-only). The push then travels browser → APNs → Stalwart's outbound POST, none of which needs this host to be publicly reachable. **iOS is the case the tunnel cannot rescue:** 16.4+ delivers Web Push only to a web app added to the Home Screen, and no SSH forward makes an origin trustworthy on a phone — that one needs real HTTPS, which this fixture must not be exposed to obtain. **Otherwise it is localhost-only, and that is a browser rule rather than a limitation of the harness:** the Push API requires a secure context, so `http://<lan-ip>` registers no service worker and there is nothing to push to. Testing from a phone needs an HTTPS certificate the phone trusts — and this fixture has world-known passwords, so it must not be exposed off-host to obtain one (ADR-002). What the SERVER needs is only outbound access, which it has. **What closing this needs:** a real browser against a real push service (Chromium/FCM, Firefox/Mozilla autopush, Safari/APNs), app fully closed, delivering to the fixture — checking that one banner appears, that a message read on another client raises NONE, that the click opens Waxwing, that quiet hours suppress it, and that nothing appears while a window is visible. Two further questions belong to the same pass and are assumptions today: whether iOS still requires a Home-Screen install for Web Push (the settings copy depends on it), and whether the seven-day renewal actually holds across a week.  **UPDATE 2026-07-23 — root cause of the Safari failure found and the whole chain proven, one leg at a time, by decrypting Stalwart's push on the wire.** The hand-check reached Safari and the subscription was CREATED but never VERIFIED. A capture-and-decrypt probe (register a PushSubscription pointing at a local endpoint whose CA the container was made to trust, then RFC 8291-decrypt what Stalwart POSTs) established, each independently: (a) Stalwart sends a correct, decryptable `PushVerification` — `aes128gcm` raw octets, VAPID-signed, exact field names our parser expects (this closes the ADR-010 concern not at source but on the wire); (b) our writeback format completes verification server-side (wrote the decrypted code back exactly as `submitPushVerification` does; the server cleared it → verified); (c) our SW parser matches the payload shape. So client and server are both PROVEN correct. **The break is a fixture-config artefact:** Stalwart's VAPID `sub` claim falls back to `mailto:postmaster@{hostname}`, and the container's hostname was the random Docker id `132e0ba72d04` — no dot, not a valid mailto domain. **Apple's push service rejects a VAPID token with such a `sub`; FCM/Chrome tolerate it** — which is exactly why it fails on Safari and would have passed on Chrome. Confirmed by decoding the JWT Stalwart actually sent. **Fixed** by giving the fixture container a real DNS-shaped hostname (`hostname: mail.waxwing.test` in docker-compose.yml), after which the probe shows `sub: mailto:postmaster@mail.waxwing.test` — valid. A production Stalwart has a real hostname and never hits this. The closed-app banner itself is now expected to work on Safari pending one owner re-test; the automated suites still cannot exercise it (no push service), so B29 stays open until that re-test confirms a banner appears with all tabs closed.  **RESOLVED TO ITS LAST LINK, 2026-07-23 — and the answer is that nothing in this repo, and nothing in Stalwart, is at fault.** After the VAPID-`sub` fix did NOT make Safari verify, a Chrome counter-test failed IDENTICALLY, which ruled out every Apple-specific theory. Stalwart's own trace log then gave the decisive line: **`push-subscription.success` with the FCM endpoint URL — Google ACCEPTED the push.** So the chain is: Waxwing's parser and writeback (both proven), Stalwart's encryption, VAPID and format (proven by decrypting its push on the wire), and Stalwart's POST to the push service (proven accepted) — all correct. **The break is the last hop, push service → browser: FCM accepts and does not deliver to Chrome, APNs does the same to Safari.** Two different push services failing identically while both accept the push points at the client machine's connectivity to them (Chrome holds a persistent FCM connection on 5228/443, Safari an APNs one on 5223/443 — commonly blocked on corporate networks), confirmable via `chrome://gcm-internals`. **No upstream report is warranted:** unlike the three in `docs/upstream/`, Stalwart does everything right here. **Getting to this took making the fixture observable at all** — Stalwart's default tracer targets `/var/log/stalwart`, which it cannot create as uid 2000, so the server had been running with ZERO diagnostics; the compose file now mounts a tmpfs there. B29 stays open because the banner itself is still unobserved, but its meaning has changed: this is no longer a question about Waxwing's correctness — that is settled — but about finding a network where the push services can reach the browser.  **THE ACTUAL ROOT CAUSE, found 2026-07-23 by reading Chrome's `gcm-internals`, and it was OURS after all.** Every earlier theory (Apple's `sub` validation, `userVisibleOnly`, network reachability) was wrong, and the browser's own log said so in three lines: the verification push **arrived and decrypted** (`Data msg received`, 557 bytes, empty Decryption Failure Log), the subscription was **unregistered in the SAME second**, and a **new one was registered 44 s later**. A loop: push arrives → subscription destroyed → app re-subscribes → server verifies the new one → repeat. The parked verification code always belonged to a subscription that no longer existed, so the handshake could never complete. **The destroyer was our own reconciler.** It collapsed four inputs into one `wanted` boolean — master switch AND permission AND server capability AND client — and tore the subscription down whenever it was false. Three of those four are TRANSIENT: `client` is null while the session reconnects, `serverSupports` is false until the session document loads, and the permission is `default` before it is read. So an ordinary reconnect destroyed a healthy subscription. **Fixed:** only an explicit "no" — the master switch off, or a `denied` permission — may tear anything down; every other falsy state returns a new `cannotAct` outcome and leaves the subscription alone. A real sign-out still tears down explicitly via `tearDownPushSubscription`, where the intent is known. Four regression tests, three mutations proven red. **`pnpm verify`: 182 files / 2602 tests.** This is the defect that made B29 unclosable, and no unit test could have found it: the suite drove the reconciler with `wanted: true` and never modelled the transient states the React layer actually produces.  **A CORRECTION THAT INVALIDATES PART OF THE ABOVE: the `verified` indicator this whole investigation leaned on was never real.** `pnpm webpush:status` derived it from `PushSubscription/get`'s `verificationCode` — but Stalwart requests that property (`crates/jmap/src/push/get.rs:42`) and never fills it: the match has no arm for it, so it falls through to `property => insert(Value::Null)` and returns `null` whether the subscription is verified or not. The line could only ever read "NO". Every "verification is stuck" conclusion drawn from it was therefore unfounded, and it drove several wrong turns (the Apple `sub` theory, the network theory). What was NOT unfounded is the defect Chrome's `gcm-internals` showed independently — the subscription being unregistered one second after the push arrived — and that defect was real, was ours, and is fixed. **Stalwart exposes no way to ask whether a subscription is verified**, so the tool no longer pretends to know: it prints the subscription facts and says plainly that the only honest check is the behaviour — close every tab, deliver, and see whether a banner appears. Filed here because the lesson generalises: a diagnostic that cannot fail is worse than none, and this one cost hours before it was noticed.  **A SECOND defect of the same family, found the same way (2026-07-23): overlapping reconcile passes destroyed each other's subscription.** With the teardown fixed, Stalwart's request log showed the app doing, inside three seconds: `PushSubscription/set create` with one FCM endpoint, `destroy` of the previous id, and a second `create` with a **different** FCM endpoint. The React host's effect legitimately re-runs several times while a session settles (the client arrives, then the session document, then the capability probe flips), and nothing serialised those passes — each one that found no matching server subscription created one and destroyed the other's. The subscription therefore never settled, so the verification code the service worker had parked never belonged to the subscription that currently existed, and the handshake could not close. **Fixed** with a module-level serialisation (`reconcilePush`): one pass at a time, waiting passes coalesced to the latest — the protected resource is the browser's single push subscription and its server twin, not a component. Regression test drives three concurrent calls and asserts exactly ONE create and ZERO destroys; removing the serialisation turns it red. **Also learned, the hard way, about the hand-check itself:** the verification code is parked per BROWSER, so opening Safari cannot complete a verification whose push went to Chrome — an obvious fact that cost a round because the two-browser test made it easy to lose track of which one was being exercised.  **UPDATE 2026-07-24 — the wiring seam is now under a lifecycle test, which is where all five defects lived.** `apps/web/src/notify/use-push-subscription.test.tsx` mounts the REAL `PushSubscriptionHost` (which had NO test at all) and drives the transient sequences the React layer actually produces — reconnect churn (client/serverSupports flapping), a grant obtained by the settings screen reaching the host, and the parked-verification round-trip over BOTH the `postMessage` fast path and the peek-on-reconcile path — modelling the browser's single subscription as ONE shared fake whose `create`/`destroy` are counted globally. Each case was mutation-proven to go RED under its defect: the transient teardown (#4), the per-component permission (#1), the missing `startMessages()` (#3), the dropped/uncleared verification (#2), and the master-switch teardown boundary. The overlapping-passes race (#5) is deliberately NOT reproduced at the host level — jsdom does not reliably interleave two passes, so a host-level test stays green with or without the serialisation, and a test that cannot fail is worse than none; it stays covered where it bites, the concurrent `Promise.all([reconcilePush, …])` case in `push-reconcile.test.ts`. This retires the plan's own note that "no unit test could have found it": for the wiring, one now can (`pnpm verify`: 183 files / 2609 tests). **What remains open is unchanged — the closed-app delivery itself is still unobserved**, and that needs the one-browser hand-test, not a unit test.  **UPDATE 2026-07-24 — the one-browser hand-test ran, and it found a SIXTH defect that every prior test and every prior hand-check missed.** Good news first, and it is real: Chrome's `gcm-internals` showed the delivery ARRIVING and DECRYPTING (`Data msg received`, 557 bytes, empty Decryption Failure Log, `Connection State: CONNECTED`) — so server, network and FCM→Chrome are all correct, and unlike the 2026-07-23 run the last hop is NOT the problem. But **no banner appeared**, and the Registration Log said why: reopening the tab **unregistered the working endpoint and minted a fresh one**, live — a subscription churn (four endpoints, two server rows, two device ids) on every single load. Root cause, proven from the log: a browser `unsubscribe()` comes only from the `!enabled || denied` branch; permission was `granted` and no sign-out happened, so `enabled` was read as **false** — because **`useLocalPref` returns `undefined` for a beat on every start, which the host collapses to the default `enabled: false`**, indistinguishable to the reconciler from the user switching it off. So every app start tore the subscription down and rebuilt it, and the half-built state never settled. **It is the same family as the original B29 defect — a transient state destroying the one subscription — just a transient the earlier fix did not cover: not `client`/`serverSupports`, but the pref still loading.** The lifecycle tests missed it precisely because they seeded the pref BEFORE mount; the real React layer produces `stored === undefined` on the first render. **Fixed** by threading `prefsLoaded` into `ReconcileDeps`: only a LOADED `enabled === false` (or a `denied` permission) may tear down; while the pref is still loading the switch reads as "not yet", never "off". Two regression tests — one host-level (`use-push-subscription.test.tsx` L7, mounts with the pref unseeded and a pre-existing subscription, asserts zero teardown) and one unit-level (`push-reconcile.test.ts`) — both mutation-proven red without the fix. `pnpm verify`: 183 files / 2611 tests. **B29 stays open**: the fix is proven in tests but the closed-app banner has still not been *observed* — the re-test with the rebuilt bundle is the immediate next step.  **OBSERVED, END TO END, 2026-07-24 (Chrome/FCM).** With the pref-loading-teardown fix in the rebuilt bundle the subscription settled to exactly ONE (gcm-internals Registration Log: one registration, zero churn — the four-endpoint churn was gone), the delivery arrived and decrypted (557 bytes, empty failure log), and **all five acceptance properties were confirmed by hand**: (1) app fully closed → one contentless banner "Neue Nachricht", no sender, no subject; (2) a message marked read elsewhere raised NOTHING (the server-side `EmailDelivery` filter — `webpush:deliver --read` stayed silent); (3) clicking the notification opened Waxwing — at `/mail`, the app home, since the worker holds no mailbox id and a specific-message deep link would need an authenticated fetch (that is B28, by design, not a defect); (4) with a window visible the contentless banner was suppressed and the LIVE channel showed the rich one instead, never two — the seam works exactly as designed: the worker suppresses on `visibilityState === 'visible'` while the live channel uses the stricter `visible && document.hasFocus()`, and a window sitting BEHIND another app is `'visible'` but not focused, which is the case that distinguishes them (observed precisely: terminal in front → worker silent, live channel showed "Bob — subject"); (5) quiet hours suppressed it. **The one presentation caveat was environmental, not ours:** macOS had two "Google Chrome" notification entries, one with style "None", which delivered to Notification Center without popping a banner — a system setting, not Waxwing (the notification WAS shown, with correct contentless content). **The behaviour M4.0 is named after is now observed — the headline of the whole feature.** Residual and still untested: whether the seven-day renewal holds across a real week, and whether iOS still requires a Home-Screen install (the settings copy depends on it); plus owner sign-off at G3. The two defects the hand-test surfaced are both fixed and committed — the pref-loading teardown (this row, `b9e0222`) and the quiet-hours time input ([B31](#), `test(web)`/`fix(web)`). | Heiko / — | before G3 (M4.9 release sign-off) | observed 2026-07-24; sign-off open |
| **B30** | **Fixed (2026-07-23): a server that cannot calculate a delta stranded the whole app on a permanent "sync problem" that a reload could not clear.** Found during the B29 hand-check, when recreating the dev fixture under a live Safari session reproduced it exactly — but it is a REAL production defect, not an artefact of the harness: a Stalwart restored from a backup, reset, or replaced answers `Foo/changes` with `cannotCalculateChanges` (RFC 8620 §5.2), because the client's cached `sinceState` names a point in a history the server no longer has. The QUERY path already recovered (`delta.ts#reconcileQuery` → `fullRequery`), but the TYPE-changes path (`syncMailboxes`/`syncEmails`/`syncThreads`, all through `drainChanges`) did NOT — the error propagated to `reportError` and set `phase: 'error'`, and because the bad `sinceState` is persisted in IndexedDB a reload replayed it straight back into the same wall. The only user recovery was sign-out (which wipes the replica) and sign-in. **Fixed** by catching `CannotCalculateChangesError` in `runSyncPass`: reset the three watched-type states to null and re-run the delta block once as a full resync, WITHOUT touching user data. The recovery is bounded by construction — the full-pull paths call `Foo/get`/`Foo/query`, never `Foo/changes`, so they cannot re-raise it — which a test pins by making a port fail EVERY `emailChanges` and asserting it still lands on `idle`. Two regression tests, both proven red without the fix. **Why no test caught it before:** the whole engine suite runs its fakes with states the fake server always recognises; nothing modelled a server that had FORGOTTEN a state the client still held. The hand-check modelled it by accident, because tearing a fixture down and recreating it is exactly that scenario. | — | (fixed) | done |
| **B31** | **Fixed (2026-07-24, found in the B29 hand-test): the quiet-hours time inputs were unusable — no user could set a two-digit hour.** Each bound was a controlled `<input type="time">` bound straight to the async `useLocalPref`: the pref is written on every keystroke, and the Dexie liveQuery re-emitted BETWEEN the two digits of an hour and reset the input's sub-field mid-edit, so typing "18" landed as "08". Quiet hours were therefore effectively unsettable for everyone. No automated test could see it — the race is between the human's second keystroke and the async round-trip, which jsdom does not drive (its own quiet-hours test already noted it "does not implement the time input's segment editing"). **Fixed** by giving each bound its own local editing state (`QuietBoundInput`), initialised once and never re-synced from the prop's own echo (the only other source of a change is toggling quiet hours off, which unmounts it). Pinned by a structural regression test — a re-render with the STILL-STALE minutes must not revert the field — mutation-proven red against the prop-controlled version. Same class as this session's push defects: React state colliding with an async source. | — | (fixed) | done |
| **B32** | **Open (2026-08-16, filed by M4.4 stage 4): a shared account has no status, no queue and no dead-letter surface at all.** `fleet.ts` gives every non-primary engine a discarding status sink; `EngineStatus` is one scalar store read by one badge (`StatusRegion`), and `QueuedSends`, the outbox-problems button and `useConflictNotifier` all mount ABOVE the acting-account scope and read the primary's rows. This was harmless while no user action could reach a shared engine — **stage 4 makes it materially worse**, because real actions now queue on shared engines whose failures nothing surfaces. Needs a per-account status model plus an aggregation policy for the chrome ("Sync error in {{account}}" ⇒ new i18n en+de), and it reverses the fleet's isolation invariant, so it is ADR-worthy and its own WP. |
| **B33** | **Fixed (2026-08-16, M4.4 stage 4): the outbox-problems UI read per-account rows and wrote through the primary engine.** `failedOutbox(db, accountId)` listed the acting account's dead letters while Retry/Discard keyed on the PRIMARY engine's `[accountId, id]` — a silent no-op the moment shared-account dead letters can exist. The write half now resolves `getEngineFor(accountId)`. The LISTING gap (shared dead letters are still not shown anywhere) folds into B32. |
| **B34** | **Open (2026-08-16, UNMASKED by M4.4 stage 4; pre-existing): message-level writes ignore `myRights` and `MailAccount.isReadOnly` entirely.** `myRights` is consulted only for folder operations and move TARGETS (`FolderTreeView`, `dnd.ts`, `MoveDialog`); nothing checks `maySetSeen`, `maySetKeywords` or the SOURCE mailbox's `mayRemoveItems`, and `isReadOnly` is a badge only (`AccountTrees`, `capabilities-model.ts:143`). Read/Flag/Archive/Trash are fully enabled in a read-only shared mailbox. Until stage 4 this was masked, because the write landed on the primary where the user does have rights; it now reaches the shared account, the server rejects it, and B32 makes that rejection invisible. Directly contradicts M4.4's "actions respect rights" — **the recommended immediate follow-on.** |
| **B35** | **Fixed (2026-08-16, M4.4 stage 4): engine-driven READS ran on the primary engine regardless of the pane's account.** The list watch, `loadMoreFor`, `fetchBody`, `fetchEnvelopes`, the label menu's hydration, snippets and the blob fetcher's quota recovery all used the ambient engine. The shared Inbox worked by accident (the shared engine's own `ensureInboxWindow` produces a byte-identical window key at the default sort); every other folder, sort, unread-first, flat, search or label view backfilled under the wrong account's key and spun forever, and `fetchBody` cached a DIFFERENT message's body into the primary's replica. All now resolve `useAccountEngine()`. |
| **B36** | **Fixed (2026-08-16, M4.4 stage 4): `getActiveReplica()` flipped to the shared account after the first account switch.** Every `ReplicaProvider` claimed the app-wide handle unconditionally, and stage 3 nests them — on a switch only the INNER effect re-runs, so the handle stayed on the shared account for good. `flushActiveDraft` (M3.5's "open drafts are saved first") would then `putDraft` under the shared account while the composer read the primary's: the exact M3.10 data loss, reintroduced by nesting. Only the OUTERMOST provider claims it now. |
| **B37** | **Open (2026-08-16, filed by M4.4 stage 4): the route is not account-qualified.** `mailPath()` yields `/mail/:mailboxId/:emailId` with no account segment and `useActiveAccountStore` is in-memory, so a reload resolves back to the primary while the URL still names a SHARED mailbox id — which, per-account and short, names a different existing primary folder. Same mechanism for notification click navigation. This is the blocker for ever notifying on delegated accounts. |
| **B38** | **Open (2026-08-16, filed by M4.4 stage 4): a registry MISS is silent in the folder path.** The cleanup path already surfaces "Couldn't clean up …", and `useMessageActions` now at least suppresses the false "Moved to …" toast (`available`, gating `useTriage`), but `useFolderActions` still swallows a miss as `void undefined` with no affordance. |
| **B39** | **Open (2026-08-16, seen once and not reproduced): opening a SHARED mailbox before the own account's window has ever loaded, then switching back, timed out waiting for the own list.** Observed exactly once, in the `verify:e2e` gate, against a freshly created volume immediately after a cold Stalwart boot and two preceding suites' load; the same assertion passed in 12 targeted repeats afterwards and in every standalone run. The suspicion is the list window's watch on a first, cold sync racing the account switch (`use-message-list` re-registers on the acting account's engine — M4.4 stage 4), not the switch itself: the reverse order (own first, then shared) has never failed. `e2e/tests/shared.spec.ts` now loads the own window first and states why, so the round trip is still asserted without also asserting a cold sync — **it is deliberately not "fixed" by widening a timeout**, and this row exists so the observation is not lost. Reproducing it needs a cold volume plus load; the honest next step is a deterministic unit-level test of a watch re-registration across an engine switch. |
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
| 2026-07-17 | **Keyboard-triage flake fixed — and it was never the test's fault (found by M3.8's live E2E, root-caused in M3.9).** The `j o e u x #` E2E had been dismissed as flaking "under load, only in the full suite". Both halves of that were wrong: it reproduces **isolated** at ~7% (2/30), and it is test **#1** of the suite (Playwright sorts `keyboard.spec` before `read.spec`), so no accumulated state was ever involved. Tracing *raises* the rate to 8/30 — the fingerprint of a race, and the lever that made it findable. It was **two independent defects** wearing one failure. **(1) `e` silently dropped the archive AND advanced the pane anyway.** With a message open, `runMove` delegates to `MessageView`'s registered handler, which resolves its role mailboxes through its *own* `useMailboxByRole` instances; those are `undefined` for the first tick(s) after mount, so `moveWithUndo` returned quietly at `if (to === undefined) return`. `advanceAfterTriage` then ran **unconditionally** — the reader saw the next message and believed the mail was filed, while it sat untouched in the Inbox: no toast, no Undo, nothing in the outbox. The E2E's only barrier before `e` is the `<h2>`, rendered by a *different* liveQuery a couple of ms earlier. The mouse never had the hole (`MessageView`'s buttons carry `disabled={archiveBox === undefined}`), so a click and a keystroke had silently stopped being the same action — the one invariant `use-triage.ts` claims in its own header. Fix: the triage seams now **return whether they dispatched**; a refusal falls through to the shortcut layer's own long-resolved triage, and the pane advances only on a real move. **(2) The M3.9 `pendingOutbox` guard was CHECK-THEN-ACT.** It sampled an empty queue and then spent two round-trips re-querying; a `#` dispatched inside that window got its prune overwritten and its `queryState` restored, so the next pass skipped the window as "not voided" and the row stayed until the 60 s sweep. Fix: re-check the queue **after** the round-trips and re-void, so the window converges. Both mutation-verified (removing either brings the flake back: 4/30 and 2/30) and proven live: **30/30 green**, full suite 22/22, `pnpm verify` 1713 tests. Also fixed: `advanceAfterTriage` anchored the roving focus by **index** computed before the move and applied after it, so a winning prune left the focus one row too far (3/30) — `x` would tick a message the reader was not looking at; it now anchors by id, like `setWindow` already did, and the E2E asserts the link explicitly instead of assuming it. Two gaps found and filed rather than fixed: **B3** (a triage chord for a role mailbox the account lacks is inert and silent) and **B4** (D2's ratified "SSE-first" never reached the code). Stalwart was suspected and **exonerated by measurement**: `Email/query` right after `Email/set` is read-your-writes consistent, 12/12. |
| 2026-07-17 | **M3.9 step 4 (5a) done — the non-pointer move paths (FR-MBX-03, WCAG 2.2 SC 2.5.7).** Folder re-parenting now has a UI at all: `moveMailbox` shipped in **M1.5 with zero callers**, so a folder's place in the tree was fixed at creation for four milestones, and this WP contains **the first code that has ever executed it**. Delivered: pure `folder-tree` guards (`isSelfOrDescendant`, `subtreeDepth`, `legalParents` + `MoveLimits`), `Triage.moveTo`, a bulk-bar `Move to…`, the `v` chord widened to the list scope, and `FolderMoveDialog`. **The task's own text was wrong in four ways, and the code won each time** (all four corrected in §M3.9 rather than silently): a move dialog was said to be missing — `MoveDialog.tsx` has shipped since M1.8, so 5a was wiring, not construction; `MessageView.tsx:382` was a dead line number (M3.9 §1-2 shifted it) and the real call sat at :536; the Undo bypass was framed as the `v` chord's problem when the same `onMove` served the reading bar's Move **button**, so the mouse had the identical hole and a keyboard-only fix would have fixed **nothing**; and "moveMailbox is undoable" is true only of the engine's server-reject rollback, not of any user-facing Undo. **Owner decision (2026-07-17): no Undo toast for folder actions in 5a** — rename/delete have none, and a move-only toast would make those two look broken; all three land together later or not at all. Two real bugs fixed in passing: `MoveDialog`'s `mailboxLabel` translated **any** non-null role though only six are defined, so a mailbox with role `all` rendered the literal string `mailbox.role.all`; and the picker offered targets with `mayAddItems: false`, which the server would reject after the optimistic apply had already shown success. `v`'s gate is now `sourceMailboxId !== null` and the reading bar's Move button gained the matching `disabled` — both read the *same* value (`use-shortcut-context.ts:65-68` resolves it to the reading pane's own `mailboxId`), so click and keystroke cannot drift; a move with no `from` **keeps the other memberships**, i.e. it is a copy, not a move (`use-message-actions.ts:20`). The depth rule is the subject's **subtree HEIGHT**, not its own depth (moving a folder moves its deepest descendant into the ceiling first), and `maxMailboxDepth` is narrowed with `typeof === 'number'` because it is typed `UnsignedInt | null` but **not validated at the wire** (`session.ts:142-146`) — `undefined > n` silently allows everything and `?? 0` blocks every move on the commonest config, and TypeScript catches neither. All five guard rules are **mutation-verified**. **The adversarial review found a flake I had just written, of exactly the class I spent the morning hunting:** the new list-picker test queried the dialog's folders synchronously, but they arrive on a `useMailboxes()` liveQuery *independent* of the email window the test had awaited — two unresolved liveQueries racing, reproduced at **1/40 as a positive control** and 0/40 after `findByRole`. Also found: the picker conveyed hierarchy through CSS padding alone (WCAG **1.3.1**) in a feature whose stated purpose is WCAG conformance — JMAP requires names to be unique among *siblings* only, so `Archive › 2024` and `Projects › 2024` both announced as "2024" with no Undo to catch a wrong pick; the accessible name now carries the path while the visible row stays short. Three further findings were **refuted on verification** (a "pre-existing and unchanged" empty-state flash misattributed to the new entry points; an unreachable single-pane `v` scenario; a presentation nit). **E2E: the folder re-parent is proven against the live server including a reload**, since a unit test that stubs the dispatch says nothing about whether Stalwart accepts it — mutation-verified (removing the dispatch turns it red at `aria-level`). **+35 tests (1748 total, 163 files); 228.17 KB gz initial JS; read+keyboard E2E 24/24.** |
| 2026-07-17 | **The list never showed you which message you had open — since M1.6 (found while preparing 5b; → B5, §13).** Building a drop-highlight meant copying the row's hover style, and the hover style paints **nothing**: `message-list.module.css` has referenced `--waxwing-surface-hover` and `--waxwing-surface-selected` since `7bb3b1e` (M1.6) and neither was ever **defined** in `tokens.css`. An undefined custom property is invalid at computed-value time, so `.row:hover`, `.row[aria-current="page"]` and `.selected` all computed to `transparent`. Measured live against the fixture rather than inferred: selected `rgba(0,0,0,0)`, opened `rgba(0,0,0,0)`, plain `rgba(0,0,0,0)` — **identical**. Eight milestones in which the open message and every ticked row were visually indistinguishable from the rest of the list, with only the checkbox to go on. **Owner decision (2026-07-17): Apple parity** — hover is the transient grey (`surface-2`), the selected/current row gets an accent tint. The dark fill was **picked by measurement, not by eye**: the first candidate (`#2b3f5e`) failed `text-muted` at **4.35:1** and `tokens.contrast.test.ts` caught it, which is exactly what that test is for — `#28394f` clears AA at 4.8:1 and stays the most distinguishable of the passing candidates. Both fills are now pinned by four new contrast pairs. **Second defect, WCAG 2.4.7 (Level A):** the move picker had **no focus indicator** — `outline: none` paired with `box-shadow: var(--waxwing-focus-ring)`, where that token is a bare colour and `box-shadow` requires offsets, so the declaration was dropped and nothing replaced the outline. Proven in a browser (`boxShadow "none"`, `outlineStyle "none"`); the app's other ten focus styles all use `outline: 2px solid`, and these two were the only box-shadow ones. It shipped in M1.8 and **M3.9's own `FolderMoveDialog` inherited it**, so the keyboard path SC 2.5.7 makes the prerequisite for the drag was itself unfocusable. Both fixed and re-measured live: selected/opened rows now `rgb(219,231,250)`, dialog focus `outline: solid 2px`. **Nothing in the toolchain could have caught either** — CSS custom properties are not typechecked, and `expectNoA11yViolations` runs under jsdom, which computes no CSS. That blind spot, not these two instances, is what B5 records. **+8 tests (1756 total); E2E 24/24.** |
| 2026-07-17 | **M3.9 nested `message/rfc822` done (FR-RD-07) — a parsed attachment opens inline.** The parse value is a full JMAP Email with its body inline in `bodyValues`, NO stored id, never in Dexie — so it reuses only the pure, id-agnostic transforms (`pickHtmlBody`/`pickTextBody`, widened to a structural `RenderableBody = Pick<Email, …>`) and never the id-keyed `useMessageBody`; and it fetches NO blob, so the ADR-011 orphan trap cannot occur by construction. It renders through the SAME `sanitize` + `MailBodyFrame` path as the outer message — `MailBodyFrame` does NOT sanitize, so the view calls `sanitize` itself with `allowRemote:false` and NO `resolveCid`: the inner sender is untrusted independently of the outer, so inner remote content AND inner `cid:` images stay blocked (a shared allowlist would let an outer phish smuggle tracking via an attached inner message). Nesting is bounded to **one level, structurally** — the leaf renders header + body only, no inner `AttachmentList`, so an inner `message/rfc822` exposes no Open control. Owner decision: **inline reveal** under the attachment row, not a dialog (Apple Mail parity, no lazy chunk). **The SP.4 caveat is now proven live, not just cited:** `bodyValues` MUST be named in `properties` or `Email/parse` returns an empty body with NO error — the E2E asserts the inner body, and a mutation removing `bodyValues` turns it red. `fetchAllBodyValues`/`htmlBody` via `Email/parse` were UNVERIFIED against Stalwart (SP.4 proved only `fetchTextBodyValues`); the seeded corpus's inner message is text/plain, so the proven path is what ships, and `pickHtmlBody` returning null for a text-only mail keeps the HTML path safe until a live HTML spike. **A three-lens adversarial review found the security lens CLEAN and two real UX bugs, both fixed:** (1) the hook started idle (`loading:false`), so the passive fetch effect firing after first paint made the view flash "couldn't be opened" on EVERY successful open — fixed by starting the hook in `loading`, and the view now treats the pre-fetch `message===null && !error` frame as a spinner, not an error (mutation-verified); (2) `maxBodyValueBytes` capped the inner body but nothing read `isTruncated`, so an over-cap inner body rendered silently clipped — unlike the `.eml` source view it claimed to mirror; the view now shows a truncation notice. **+39 tests (1795 total, 167 files); 229.62 KB gz of 300; read E2E 26/26.** |
| 2026-07-19 | **M3.9 step 5 done — row swipe gestures on touch (FR-LST-06) → ADR-013.** Apple parity: right = mark read (a **toggle**, resolved against the row's state at the moment the axis locks), left = archive, each direction configurable in Settings (`archive`/`trash`/`read`/`none`) as two independent scalar `localPrefs` keys — no compound record, so no read-modify-write transaction. **Pointer events, forced not chosen:** React 19 registers `touchstart`/`touchmove` as PASSIVE listeners, so an `onTouchMove` handler can never `preventDefault`; `pointerType !== 'touch'` is also the only touch/mouse discriminator that needs no stub under this jsdom (`matchMedia` and `navigator.maxTouchPoints` are both `undefined`). No `setPointerCapture` — it does not exist here either (which is why `SplitPane`'s pointer drag is keyboard-tested), so `pointermove`/`pointerup`/`pointercancel` ride on `window` for the gesture's life. Commit-only, no iOS "peek": under the commit threshold the row rubber-bands and nothing happens; a parked state was rejected because each direction carries exactly one action, so there would be nothing to choose between, at the cost of 44 px targets inside a 54 px compact row. **Zero React state while the finger is down** (one `--swipe-x` custom property, two `data-` flags, one class, all written imperatively) — a `setState` per `pointermove` would re-render every virtual row at 60 Hz (NFR-PERF-02). **The archive → trash fallback did not exist before this WP**: the task text had promised it since M3.9 was written, and no code implemented it. It must NOT be driven off `triage.archive()`'s boolean — that is also `false` while the role liveQuery is merely unresolved (the ~7 % silent no-op fixed in step 1), so the obvious `if (!archive(…)) trash(…)` would **trash mail on the first render tick of an account that has an Archive folder**. Resolved from a single `useMailboxes()` read instead, with both move directions inert until it resolves. A direction whose target is the mailbox already on screen is **inert** — no layer, no follow, no commit — which generalises Trash-in-Trash and Archive-in-Archive rather than special-casing either. Permanent deletion is unreachable from a swipe **by construction**: `destroy` is not a member of `Triage` at all. **SC 2.5.7 needed work after all**, contrary to this WP's assumption that the existing paths covered it — see the separate entry below. **A new `chromium-touch` Playwright project** (`e2e/tests/swipe.spec.ts`: phone viewport, `hasTouch`, gestures driven through CDP `Input.dispatchTouchEvent` because Playwright has no swipe primitive and `page.touchscreen` only taps) exists for one reason: **jsdom computes no CSS**, so the unit suite is structurally unable to see whether `touch-action` reached the right element, whether the transform moves anything, or whether the reveal layer has a colour — the B5 blind spot, which has now produced three defects in this project. It found one immediately: on a 390 px phone the folder drawer covers 288 px at `z-index: 15` and swallowed every touch aimed at a row, while two "nothing happened" assertions went green with no gesture reaching the list at all. **A CSS defect of exactly the B5 class was caught by reading the spec grammar, not by any tool: `touch-action: pan-y` silently disabled PINCH-ZOOM across the whole message list.** The grammar is `[ pan-x \|\| pan-y \|\| pinch-zoom ]` and what is not named is DISABLED; `.rowWrap` tiles the entire virtual list, so the app's primary surface would have become a zoom-dead zone — a **WCAG 1.4.4** failure for low-vision users, from valid CSS that no linter, typechecker or jsdom a11y scan could object to, in an app whose `index.html` deliberately keeps zoom available everywhere. Now `pan-y pinch-zoom`, pinned by the touch E2E. Filed as B5 instance (3), §13. i18n en+de. **Measured on completion: `pnpm verify` green — 1839 tests / 168 files, 230.95 KB gz of the 300 KB budget; live E2E 31/31 (26 pre-existing read+keyboard as a regression net, plus 5 touch).** The pinch-zoom fix is mutation-proven in the real browser: reverting to a bare `pan-y` turns the touch E2E red. **Noted, not fixed — the bulk bar's FLAG button is still hard-wired to `setFlagged(ids, true)` while the `s` chord toggles**, i.e. the same read/unread drift this WP closed, one control over. No swipe direction maps to flag, so changing it here would have been an unrelated behaviour change; it is a two-line fix via `triage.setFlagged` whenever flag becomes a swipe option. |
| 2026-07-19 | **Data-loss path fixed at the triage seam — pre-existing, reachable from the bulk bar today, and nothing to do with swiping (found while specifying the swipe's Trash-in-Trash rule).** `moveWithUndo` had no `to === from` guard. With source and target equal, `moveUpdate` builds the patch as `{ "mailboxIds/<x>": true }` and then writes `"mailboxIds/<x>": null` **onto the same key** — the removal wins, and the server is asked to take the message out of the only mailbox it is in, which RFC 8621 forbids (≥ 1 required): an `invalidProperties` rejection at best, an Email in no mailbox at worst. Optimistically it is just as wrong: the apply receives one predicate as both `left` and `entered`, tests `left` first, and prunes the row out of the window it never left. **This was live**: the bulk bar renders a Trash button while the user is viewing Trash, so select-in-Trash → Trash reached it with two clicks. Fixed once at the seam (`use-triage.ts`), so the bulk bar, the `#`/`e`/`!` chords and the new swipe are all covered by the same guard; the swipe's own inert-direction rule is defence-in-depth rather than the only line. The plan's step-5 text had framed the Trash-in-Trash hazard as "must never mean destroy", which was already satisfied by construction — the real hazard was the self-move, and it sat one layer up. |
| 2026-07-19 | **Read/unread had three different behaviours across its three entry points; the bulk-bar button is now a toggle (WCAG 2.2 SC 2.5.7).** The button SET `$seen`, the `u` chord CLEARS it, and the new swipe TOGGLES it — so **mark-UNREAD had no single-pointer, non-dragging path at all**: it was reachable from the keyboard and from nothing else. `u` satisfies **SC 2.1.1 (Keyboard)**, which is a different criterion, and is no help to the pointer user on the touchscreen the swipe is for. ADR-013's Consequences section had claimed SC 2.5.7 was "satisfied by paths that already existed … nothing new was built for it, and nothing should be"; that was wrong for one of the three actions and is corrected in place. The bulk-bar read button now marks the selection read unless every selected message already is, then marks them unread — the shape the flag button and the `s` chord already shared. `u` stays one-way deliberately: it is a *named* action ("Mark as unread"), and a chord that silently flips is worse at the keyboard, where the user cannot see the state they are about to invert. **The mechanism is the point, not the instance:** this is precisely the drift `useTriage` exists to prevent, and both warnings were already in the tree before this WP (`registry.ts` at `triage.flag`, `MessageList.tsx` at the bulk bar). A shared seam makes the **write** one code path; it does not make the **intent** one. |
| 2026-07-19 | **ADR-012's platform claim was false and is corrected; the drag has been live on touch since `770182b`, untested.** The ADR asserted that HTML5 drag & drop "does not fire from a touch on iOS Safari (and is unreliable-to-absent from touch on Android browsers)", and shipped 5b as deliberately desktop-only on that basis. It was written from memory, never probed, and the probe the ADR itself scheduled for step 5 is what caught it. Established from engine source and vendor announcements: **Chrome on Android starts a drag from a long-press on `draggable="true"` by default since Chrome 100** (`kTouchDragAndDrop` and `kTouchDragAndContextMenu`, both `FEATURE_ENABLED_BY_DEFAULT` on Android; the old `--enable-touch-drag-drop` switch was *removed*, so there is no flag to turn it off), **iOS/iPadOS Safari does the same** via a `UIDragInteraction` lift routed through `EventHandler::tryToBeginDragAtPoint`, and **Firefox for Android is the sole engine with no touch-initiated drag** (Bugzilla 1764177, open). The decision is unchanged — still HTML5 DnD, still no polyfill — but its *reason* is now a mechanism rather than an absence: movement past the tap slop cancels the pending long-press, a drag taking over emits the `pointercancel` that Pointer Events L4 §5.1.3.3 mandates and the swipe treats as "abandon", and `onDragStart` additionally bails when `swipe.isSwipeActive()`. **The amendment as first written named that guard wrong** — it said `isTouchActive()` and described it as "a finger is down", which, implemented literally, would have returned `true` from the first `pointerdown` on every row and **cancelled every touch drag in the app**, the exact opposite of the coexistence the same document decides three paragraphs earlier. The real predicate is `isSwipeActive()` = `gestureRef.current?.direction != null` — a **locked axis**. A long press never moves, so it never locks, so it stays a drag source; the two gestures divide by what the finger does. Corrected in ADR-012 and in the plan's 5b text. **Still unverified, and honestly so:** nobody has run this on real Android or iOS hardware. A local probe under Playwright's touch emulation found no `dragstart` — not at an 800 ms hold, not on a tablet viewport, not with `--enable-features=TouchDragAndDrop,TouchDragAndContextMenu`, not via `Input.synthesizeTapGesture` — while a mouse-drag positive control fired reliably — recorded as a limitation of the emulation (the Android path is entered from a synthesized `kGestureLongPress` in a pipeline desktop Linux Chromium does not run), not as evidence about Android. Engine-source evidence plus a defensive guard is what we have; device behaviour remains a coverage gap. |
| 2026-07-20 | **The G2 gap package (§13 B1–B5) — and three of the five gap descriptions were wrong about their own subject.** Taken as one work package ahead of M3.10 on the owner's instruction. The headline is not that five rows flipped to fixed; it is that the plan's own prescriptions could not be trusted, and that the mapping pass which established that was worth more than any single fix. **B4's prescribed "one-line fix" (`prefer:'sse'`) would have turned self-healing push into permanently dead push — and shipped GREEN.** `prefer` **reorders and never restricts**: it yields `['sse','websocket','polling']`, which is strictly worse than doing nothing, because today SSE is the *last real* transport (`hasRealFailoverTarget()` false, so a transient failure retries forever until it heals) whereas with WebSocket behind it, two pre-open SSE errors spend the failover budget, `advance()` lands on the un-authable WebSocket — itself terminal — and push is dead for the session. Measured, not argued: substituting the prescribed line into the new regression test yields `expected 'websocket' to be 'sse'`. And `channel.test.ts` carries a test named *"reorders (does not restrict) for an explicit prefer"*, so the suite would have applauded. Real fix: a genuinely restrictive `CreatePushChannelOptions.transports` allowlist applied before the eligibility filter, plus `BROWSER_PUSH_TRANSPORTS = ['sse','polling']` in the app; `'polling'` is permitted regardless so an allowlist can never silently produce a dead channel; the MIT library's default is deliberately unchanged, since the browser's WS auth problem belongs to the browser, not the library. The app-side blindness that let a ratified G1 decision drift for a whole milestone — three engine test files discarding `createPush`'s `options` entirely — is closed for `engine.test.ts`. **B2's premise named a window shape the app does not use** (§13 said "the default `receivedAt desc, collapseThreads:false` window"; the default is `collapseThreads: **true**`), so the fix as scoped would have covered no real user while letting the row be marked done. **B5's proposed remedy was aimed at the class's rarer half** — see its own entry. **B1's scope was too narrow** and **B3's single specified predicate could not serve both surfaces it was specified for**. ADR-005 amended; ADRs **014** and **015** record two reversed/widened decisions; tech-stack §4.2 + §7, design-system §3.1, FR-LST-06 and FR-UI-04 updated. Four new rows filed rather than quietly absorbed: **B6** (browser focus sweep, deferred with reasons), **B7** (folder counts now visibly lag the list B1/B2 made instant), **B8** (a bulk move places none of its arrivals if the window already lists any one of them — pre-existing, made visible), **B9** (the bulk bar's flag button, carried from M3.9). **A process failure, recorded because it nearly shipped a hole:** a parallel implementation agent used `git checkout -- .` to undo a mutation; it reverted the entire tree, five times, and destroyed another agent's completed work package. Two agents reported it and neither could prove what survived. It was caught by diffing `git status` against each agent's reported file list — B4's five files were simply absent — and rebuilt from that agent's own report. Concurrent agents now carry an explicit prohibition, and work packages touching neighbouring files are run strictly sequentially rather than in parallel. |
| 2026-07-20 | **B1 + B2 — the sync layer stops lying about keyword-filtered and offline windows.** **B1:** `setKeywords`' optimistic apply now runs in one `emails`+`queryCache` transaction like `move`, driving `updateWindows`. The bidirectionality that made this look hard for two milestones dissolves into one polarity argument — `left` asks the predicate for `!value`, `entered` for `value` — so `filterPinsKeyword` is a *sibling* of `filterPinsMailbox`, not a generalisation: same AND-only recursion, and an **allow-list** that refuses the three thread-level conditions, because a single message's keyword can never disprove them. **The gap's scope was wrong, though: the defect is not only about *filtered* windows.** With the shipped "Unread first" toggle a just-read message stays pinned to the top of a window whose membership never changed — arrival and departure by **sort**. That needed a third `WindowEffects` member (`resorted`), not the fold-into-`entered` the mapping proposed; that proposal was proven *unable to fire* (the guard it reused excludes precisely the windows the sort case is about) and the failed design is now pinned as a mutation. `resorted` is deliberately **not** gated on membership, unlike `entered`: collation is not a property of the rows a window happens to have loaded, and gating it concealed a whole case — a message marked unread from a search result never arriving at the top of the unread-first window it belongs to. The cost is one `fullRequery` per mark-read with the toggle ON, bounded because `runReplay` reconciles only once the outbox drains so a triage burst collapses into one re-query, and **zero with the toggle off** — strictly opt-in. **B2:** a move now **splices** the arrival into the destination window in the same transaction as the envelope patch, behind four allow-listed gates — the filter provably accepts the envelope (`after` honoured, so a message older than the cache horizon is refused rather than appended past the tail), the sort is locally reproducible (`receivedAt`/`size`/`hasKeyword`; `from`/`subject` are server collation), every neighbour envelope is actually present in the replica, and under collapsing the thread is not already represented. **Owner scope: collapsed windows included, with the price stated in the code rather than around it — under thread collapsing the POSITION is a guess too, not only the preview line**, because the server orders collapsed results by a key it picks for the thread. It is a heuristic the next reconcile corrects, and it beats showing nothing, which read as a failed Undo. A **tail-drop rule** (an insert into an incomplete window pays for itself by dropping the last id, so `ids.length` is unchanged) closed two seams the mapping had listed as "no change required" — `delta.ts`'s window ratchet and `MessageList.tsx`'s load-more re-arm — leaving both files byte-identical. Rollback needed a genuinely new `retractWindows`, because `invalidateWindows` only voids and voiding leaves the phantom id in `ids`. **The sharpest find came from verification, not implementation: B1's allow-list test was passing for the wrong reason** — every window in it was routed to the prune branch, so widening the *arrival* branch to accept exactly the thread-level conditions the test's own comment claimed to guard stayed green. Fixed with an entered-half twin. 12 + 19 + 3 mutations across the two gaps, **every one independently re-run and reproduced RED by a second agent**, several at higher failure counts than claimed. **Offline scope, stated plainly rather than implied:** B1's REMOVE direction is immediate, its ADD direction still waits for reconnect. |
| 2026-07-20 | **B3 — a shortcut that cannot work now says so, and a swipe set to "Archive" no longer bins mail (→ ADR-014).** `e` on an account with no Archive role used to fall out of the dispatcher's loop and do nothing at all: no move, no toast, no live-region text — from the keyboard, indistinguishable from a key that was never bound. JMAP does not mandate an archive role, so this is a real account shape, not a hypothetical. **Owner decision: both surfaces** — a warning toast at the press *and* a dimmed, explained row in the `?` cheat sheet, with the chord still **listed**, because the key exists and the mailbox does not; an absent row would tell a different falsehood. The message names `v` (move-to-folder, which needs no role) as the way out, so it is a fix rather than an apology. **The specified predicate had to be split, which the mapping missed and the cross-check caught:** the account-shape reason is independent of whether it is worth saying *right now*, and one `unavailable()` gated on `targetIds.length > 0` would have shown the cheat sheet as available in exactly the state a user opens it — nothing selected, right after the key did nothing. Scope boundary by decision, not oversight: role mailboxes only; the self-move case and the transient roles-unresolved case stay silent. **The reversal (ADR-014):** a left-swipe configured "Archive" used to fall back to **Trash** on an Archive-less account — deliberate in M3.9, and carefully built — while `e` refused the identical account shape in silence. Once `e` says so out loud on the same list, the two surfaces would have visibly contradicted each other, and the gesture's answer was the destructive one. Three properties make the gesture the wrong place for a substitution: there is no confirmation under a thumb, the reveal strip had already said "Archive", and Trash is not a near-miss for Archive but its opposite pole. The direction is now inert — the row does not follow the finger — reusing the path that already existed for "the target is the folder you are looking at". The settings hint was updated in `en` + `de` in the same change; it promised the fallback, and shipping the reversal without it would have left the settings screen lying. **Noted, not fixed:** the repo still has three answers for a missing role — the bulk bar hides the button, the reading pane disables it, the keyboard now dims and explains. B3 converged the keyboard onto the most informative one; unifying the other two is not its job. |
| 2026-07-20 | **B5 — CSS gets two static checks, and the one the plan did NOT propose is the one that found bugs (→ ADR-015).** The plan proposed a token-reference lint: "cheap, and would have caught instance (1) on the day it landed". True — and aimed at the rarer half. The mapping pass produced the evidence: **the focus class has produced three of the four known instances, and the token lint finds nothing at all today.** So B5 ships both. (1) **Token references** — every `var(--waxwing-*)` resolves, all theme override blocks carry the same keys as `:root`, and the three token names `public/theme.css` shows hosters by example still exist. The symmetry assertion needed care: the dark block's selector is `:root:not([data-theme="light"])` inside a media query and there is a fifth `:root {` under `@media (pointer: coarse)`, so a naive `:root` regex matches the wrong block and the assertion passes **vacuously** — a mutation proves it does not. (2) **Focus indicator guard** — a rule may switch the focus outline off only if it scopes the suppression away from keyboard focus, supplies a replacement on a sibling `:focus-visible` rule for the same selector base, or carries a `/* waxwing-focus-exempt: <reason> */` comment whose reason is mandatory and machine-checked for length; stale exemptions are failed, so the licence cannot outlive its use. Exactly one exemption exists (a programmatic `tabindex=-1` target). **It immediately found two LIVE WCAG 2.4.7 (Level A) defects, both of which shipped AFTER the M3.9 fix of the same class:** the primary To/Cc/Bcc entry has had no focus indicator at all since M2.4, and the label menu signalled keyboard focus only by a fill identical to hover — measured 1.19:1 in light, 1.23:1 in dark, i.e. invisible. Both fixed, each in the shape its own specificity forced: the recipient ring goes on `.input:focus-visible`, **not** the wrapper as first proposed, because `.field:focus-within` is also (0,2,0) and would not have removed the input's own suppression — and suppressing it again is exactly the construct that created the defect. Dead tokens **warn, never fail** (two tokens, ~60 bytes, both scale-completers). **The class is not closed and the ADR says so:** neither check can see rendered output, so a ring that exists but is invisible against its background passes both. The generic browser-side computed-style sweep that would catch that is filed as **B6** with its open questions named — a false-positive budget, a "differs measurably" threshold — rather than half-built. |
| 2026-07-20 | **A flake in the G2 work, caught by repetition rather than by luck, and it was the same two-liveQuery race as M3.8's.** The full suite failed once in 13 runs on B3's new `e on an account with no Archive folder SAYS so, and moves nothing` — a 1087 ms duration, i.e. `findByText`'s timeout expiring, so the toast never appeared at all. It was found only because a subagent reported seeing a single unexplained failure it could not name, and that was treated as a finding rather than as noise: twelve further full-suite runs isolated it. **Root cause, proven directly rather than argued:** reordering the assertions so the dispatch check ran first turned the failure into `expected [{kind:'move', to:'archive'}] to deeply equal []` — at the instant the test's barrier released, `e` dispatched a **real move into the just-deleted mailbox**. The barrier waited for the string "Archive" to leave the DOM, but that string is rendered by `MessageList`'s swipe reveal layer off **its own** `useMailboxes()` subscription, while the chord is answered by `useShortcutContext`'s **separate** one. `waitFor` re-runs on DOM mutation, so it released in the commit between the two. The helper's own doc-comment names this exact hazard — "the email window and the mailbox list are independent liveQueries" — and then picks a proxy that is still the wrong instance. **Three of the first four observed failures were a SIBLING test sharing the barrier**, including one that asserts an ABSENCE and would therefore have gone on passing while proving nothing. Fixed by making the barrier observe the shortcut context's own instance — the `?` cheat sheet renders from the very `context` object the dispatcher reads — opened through the UI store rather than the chord so it also works where scope drops to `global`. **Measured, not asserted: 6 / 320 before, 0 / 320 after** (P ≈ 0.002 if unchanged), plus the old barrier restored under the identical harness to confirm the fix is what moved the rate. **The product-side finding is filed as B10, not fixed:** the stale-but-resolved window is real, but it is bounded to one liveQuery round-trip, needs a concurrent client mutating mailboxes at that instant, is not shortcut-specific, and fails *visibly* as an outbox dead letter rather than silently. Making it airtight means one shared mailbox subscription app-wide — an architectural change with its own ADR, not something to bolt onto a flake fix. |
| 2026-07-20 | **M3.10 wave 0 — the E2E gate had been RED for eight milestones, and two independent defects were stacked so neither showed.** Wave 0 is the foundations the rest of M3.10 stands on, and it started by discovering that the thing it was supposed to extend did not run. **(1)** `e2e/playwright.config.ts` carries `testIgnore: ['**/demo.spec.ts']` and **no `testMatch`**, so it collected **40 tests across 6 files** — every fixture-backed spec included — and `scripts/verify-e2e.mjs` runs it as the "placeholder suite" *before* the read and write suites, without a fixture, a proxy, or the right port. Confirmed by `--list` and then by running `read.spec.ts` under it. Fixed with an **allowlist** (`testMatch: ['**/shell.spec.ts']`), not a bigger denylist: an allowlist fails closed as files are added, which is the entire point, and it is the same distinction B4 had just drawn for push transports. **(2)** With that fixed the gate was *still* red: `shell.spec.ts` asserted its `<h1>` contains "Waxwing", which was true of the P0.3 placeholder shell and has been false since **M1.4** replaced it with real onboarding — the app now settles on the sign-in step, whose heading is "Sign in to {host}". So the suite was red rather than stale-but-passing, and it went unnoticed precisely because the collection defect made the gate fail one step earlier. The spec was rewritten to claim **less** than it did: the production bundle boots under the strict `<meta>` CSP and the sign-in card renders. Branding is asserted where it is real, because `LoginForm` takes a `productName` prop and never renders it — filed as **B12**. **`pnpm verify:e2e` now passes end to end for the first time: 42 tests, 1m27s.** **The `/mail/` mount harness** (`mount-server.mjs`, its own config and suite, wired into the gate before the Docker suites) covers the deployment shape Stalwart actually produces and that no suite had ever seen. Mutation-proven: deleting `<base href="/" />` and rebuilding turns the deep-link test **RED at the heading — the white screen itself** — while the mount-root control stays GREEN. That asymmetry is the whole reason the suite exists and it was observed, not assumed. **The first version of that spec was flaky by construction and I caught it only because it failed for me and not for its author:** it called `page.reload()` on a still-loading document, which cancels in-flight modulepreloads; they surface as `requestfailed`/`net::ERR_ABORTED` and the helper counted them as broken resources. `ERR_ABORTED` is never this defect's fingerprint — a **404** is. The collector now starts after the cold load settles, which also makes the reload a genuine reload; 5/5 stable, and the mutation still lands on the heading. |
| 2026-07-20 | **M3.10 wave 1 — offline, and the three G2 payoffs proven in a browser. One of them was applauding the wrong thing.** `context.setOffline(true)` was PROBED before anything was built on it, and it reaches every seam: `navigator.onLine` flips, one `offline` event fires, the app's chip appears, the engine queues, and a page-side `fetch()` genuinely throws — the network is down, not merely declared down. That is pinned as the suite's first test so a future Playwright or Chromium regression fails once, naming itself, instead of silently turning nine offline specs into assertions about nothing. **The sharpest finding is that B4 masked B1.** With push shipped and working, the server's echo lands in ~100 ms, so the "Unread first" re-sort happens either way — and the first draft of the B1 test **passed against a build with `resorted` mutated to `() => false`**. The echo was doing the work and the test was crediting B1 for it. B1 is only load-bearing when push is *not* delivering, which is a real state (a server without SSE, a channel that has failed over) and precisely the one it was written for. The test now aborts the eventsource stream so the channel drops to 30 s polling, which puts a 15 s budget below every path except the one under test — the budget IS the assertion. Its positive control earned its keep immediately: the obvious `**/jmap/eventsource*` glob matches **nothing**, because a Playwright glob `*` does not cross a `/` and the advertised URL is `/jmap/eventsource/?types=…`; without the control that would have been a green test measuring exactly what it meant to exclude. **B4 also retired dead weight:** SSE connects and delivers in ~500 ms, so `read.spec.ts`'s live-delivery test — 75 s of budget and a comment asserting push cannot authenticate in a browser, both written before B4 — is now 20 s and runs in 813 ms instead of burning a minute of every sweep. The mutation is the deletion of `transports`, **not** `prefer:'sse'`: substituting `prefer` is a false green, which is the same trap the gap itself was built around. **B2's payoff holds:** offline, archive and Undo, and the row returns to a collapsed-thread window without reconnecting; mutating `placeArrivals` to the pre-M3.10 void-only behaviour turns it red. **Ten specs, each mutation-proven RED, 5/5 stable, plus 12/12 on the `j o e u x #` sequence the plan flagged as the likeliest new flake.** One honest negative: the `left`-branch `queryState` void is **not** E2E-reachable — the brief predicted removing it would resurrect the row after reconnect, and it does not, because the server's delta truthfully reports the removal and applying it to already-pruned ids is idempotent. It is a defensive invariant and unit level is its right home; a real mutation was found for that test instead. Cache/eviction is smoke only by decision — a real eviction needs 32 MB against a kilobyte corpus, and no test-only production knob was added to fake it. **`pnpm verify:e2e`: 52 tests green, 3/3 repeat runs.** |
| 2026-07-20 | **M3.10 wave 2 — the PWA handovers, and a promise the app was not keeping.** **The app told you your open drafts were saved before an update reload, and saved nothing.** `en/common.json`'s update toast reads *"Reload to use the new version. Open drafts are saved first."*; `useUpdatePrompt()` is mounted in `AppBody` **above** `SyncEngineHost`, which is what renders `ReplicaProvider` — so `useReplicaOptional()` was always `null` there, `useDraftSync()` returned its **noop** branch, and `flushOpenDrafts()` awaited nothing at both call sites. Anything typed inside the autosave debounce was lost on the reload while the UI said otherwise. M3.5's changelog records hardening the **error path** of this flush ("a rejected draft flush stranded the user") — i.e. the failure handling of a call that did nothing was made robust. **Seven unit tests missed it because every one injected `deps.draftSync`**, so the production wiring was never exercised: the same passes-for-the-wrong-reason class this milestone has now hit four times. **Fixed by moving the SEAM, not the prompt** — the placement above the auth gate is deliberate and correct (a first-time visitor must precache the offline shell, FR-OFF-01, and Chromium's installability check needs a registered worker on the sign-in screen, FR-DEP-06). `ReplicaProvider` now publishes to a module-level `activeReplica` read by `getActiveReplica()`, the same shape `setActiveEngine` already establishes twice, with an unmount guard so a departing provider cannot blank its successor during a mount-before-unmount swap; `flushActiveDraft` resolves the replica at CALL time. Plus a **2 s deadline** raced against `allSettled`: that survives a *rejecting* flush but not a *never-settling* one, and an IndexedDB request blocked behind another tab's `versionchange` may never resolve — which would strand the user on a build whose lazy chunks are already gone. The new unit test reproduces the real causal ancestry (the prompt is a **sibling** of the provider, never a descendant) and injects nothing. Both mutations RED. **Two honest limits found and pinned rather than papered over.** (1) **Offline reopen with a session is not implementable as the plan specified**: `restore()` works offline, but `SessionProvider.boot()` feeds it to `connectSession()`, which fetches the JMAP session object from the network, and `jmapSession` is persisted nowhere — so offline you get "Could not reach the server" with a full replica sitting behind it. The fix cannot be "cache it": that is a JMAP path and the worker's central invariant forbids caching one byte of JMAP. The shipped test asserts the precache half and pins the limit as a **tripwire that goes red when someone fixes it**. (2) The update toast's trigger is Chromium's own ~1.8 s update check; the app's `visibilitychange` path proved **inert under mutation**, so that step was REMOVED from the test — an inert step that looks like the point of a test is worse than no step. **`scripts/check-dist-contract.mjs`** now runs in `pnpm verify` after `size`: the precache set must set-equal every emitted asset, and `index.html` must keep its `<base>` and relative URLs. Its justification is measured, not hypothetical — renaming `chunkFileNames` makes the build exit **0** while the precache silently drops from **23 entries to 7**, and all **79 PWA unit tests stay green**. (The brief's premise that "Workbox only warns" is wrong at `vite-plugin-pwa@1.3.0`, which fails the build; the silent-glob case is the real hazard.) The staged second build uses a **test-owned Vite config**, not a production `define` — a Rollup `output.banner` was tried first and rejected on evidence: under rolldown it applies after hashing and both builds came out byte-identical. |
| 2026-07-20 | **Every M3.10 wave found at least one test that passed for the wrong reason — recorded as a pattern, not as four anecdotes.** Wave 0: a mount spec that called `page.reload()` on a still-loading document, counting its own cancelled modulepreloads as broken resources (green for its author, red on the next machine). Wave 1: a B1 test that passed against its own mutation because push, shipped days earlier, was doing the work — and a route glob that matched nothing because a Playwright `*` does not cross a `/`. Wave 2: seven unit tests that injected the very dependency whose real wiring was broken, and a `visibilitychange` step that was inert under mutation. **The common shape is that all of them were GREEN and none of them were evidence.** What caught every single one was the same discipline: mutate the production code the test claims to cover and require the test to go red, and pair every absence assertion with a positive control proving the mechanism was live. Worth stating plainly in the plan because it is cheap to agree with and expensive to actually do — three of the four were written by someone who believed they had already done it. |
| 2026-07-20 | **M3.10 wave 3 — the notification suite, and the handed-over spike's own lever turned out to be wrong in the direction that fails OPEN.** Wave 0's spike established that `page.bringToFront()` cannot background a tab in headless and that CDP `Emulation.setFocusEmulationEnabled({enabled:false})` can. The second half is **only true before any input action**: after a single Playwright `click()` — and every spec must click through sign-in and a Settings switch — both pages report `hasFocus: true` again, and re-sending the override, detaching/reattaching the CDP session, `window.focus()` and `Page.setWebLifecycleState` all fail to recover it. A helper built on the spike's recipe would have made the tab count as **foreground**, silently vetoing every banner and turning **all three absence tests green for nothing** — the exact failure this milestone kept producing, one layer deeper, in the fix for it. Two corrections make it real: the CDP session must **never be detached** (detaching reverts the override), and the activation must be **bounced** (`bringToFront()` on the page, then on the holder), because after an input action the browser already considers the page active and activating the holder directly is a no-op. The helper asserts its own effect, so a silent regression fails the helper rather than the specs. **Six specs; the strongest evidence is structural — deleting the single `notify(created, …)` call reddens ALL SIX**, which proves no test in the file is vacuous. Each absence test additionally carries its own positive control: the no-storm test delivers a fifth message in the same tab and demands exactly one banner; the cross-tab veto backgrounds the second tab and demands the identical delivery path now banner, isolating the veto rather than merely showing that notifications work somewhere. **Two claims were retracted rather than shipped.** The deep-link test does **not** cover `notificationTargetPath` — mutating that function left the test green, because only `focusOrOpen` calls it and the click that would reach it is undispatchable, so the test composes the route itself; retitled and re-commented to say exactly that. And the **leader-only test is NOT mutation-proven**, which is the more interesting result: "exactly one banner" is over-determined by three independent mechanisms — the Web Lock, a follower having no sync *trigger* at all, and decisively the Email sync cursor being **one row in the shared replica**, so `Email/changes` reports an arrival as created to exactly one tab however many are open. Four mutations were tried and all stayed green. It is kept as a regression net for the change class that would break it, **labelled as not-proven** instead of being described as proof. **30/30 under `--repeat-each=5`, zero flake.** `pnpm verify:e2e`: **66 tests green.** Boundaries stated in the spec headers rather than faked: no background push (ADR-010 — there is no code to exercise), no dispatchable notification click, no proof that a banner is *painted*, and `visibilityState` never driven to `hidden`, so only the `hasFocus` half of the engine's AND is exercised. |
| 2026-07-21 | **G2 follow-ups (§13 B7–B9) + the fixture pin to Stalwart v0.16.14 — and upstream shipped all three of our reports in one release.** The version bump was expected to be routine bookkeeping. It was not: **Stalwart v0.16.14 (2026-07-20) fixes every defect Waxwing filed in `docs/upstream/` and implements RFC 9749 VAPID**, apparently the first JMAP server to do so — and two of the three fixes are, line for line, the code our reports suggested (`http.rs` now hands `reqwest` the raw `Vec<u8>`; `push/set.rs` uses exactly the `DecodePaddingMode::Indifferent` engine we wrote out). Verified at source and then LIVE against the bumped fixture: alice's session carries `urn:ietf:params:jmap:webpush-vapid` with an 87-char unpadded base64url key, the precise shape `PushManager.subscribe()` wants. **That turned a patch bump into a product-defect discovery.** Stalwart auto-generates the VAPID key on a virgin registry, so the capability appears, `serverSupportsBackgroundPush` goes true — and the settings panel began telling users *"This server also supports notifications while Waxwing is closed"* while the app contains no `push` listener, no `PushSubscription/set`, nothing. The app has been making that promise to anyone on a real v0.16.14 since the day it shipped; our bump only revealed it. The string now states the truth, and reversing ADR-010 is filed as owner decision **D6** (sized honestly as an `L`: the cost is not the handshake but that a `StateChange` carries no sender or subject, so a closed-app banner needs the service worker to make an authenticated JMAP call — dragging the token, the `SecretStore` and the refresh path into a DOM-free worker). The E2E assertion that broke was written in M3.10 with the comment *"the day one ships the capability, the app must switch to the other string and this test must fail rather than pin the pessimistic wording forever"* — it did exactly its job, ten days later. **On the three gap rows: all three were wrong about themselves again, continuing the pattern from B1–B5.** B9's "two-line fix" would have RELOCATED the drift it existed to close (the bulk bar's predicate is hydrated from the virtual window, the chord's from the full selection) — and the read/unread button had the identical off-screen defect, unfiled, which is now fixed too. B8's one-line inversion was correct forwards and silently widened a rollback bug backwards. B7's prescription would have double-counted, **and so did both of my own corrections to it** — the shipped predicate took three rounds and a checker's fourth-path find. **The process lesson, which outranks any individual fix:** across six waves, *every* round had an independent checker find a real defect in work that was already green, mutation-proven and reported as done. The single most productive technique was not reading the diff — it was **deleting each guard clause and requiring the suite to object**; roughly a dozen survived deletion, two of them protecting measured wrong numbers. Eight comments asserted properties their code did not have, including three written *while fixing* comments that asserted properties their code did not have. Five new rows filed rather than absorbed (**B14**–**B18**), D3 deferred with evidence (no v1.0 exists), and the Phase-4 dogfooding criterion moved to G3 on the owner's reasoning: *"Wir können nur Sachen testen die wir auch schon implementiert haben."* **One process failure to record:** a checking agent used `/dev/null` as a backup path and truncated `repo.ts`, uncommitted, to zero bytes. It repaired the file itself and proved the repair by blob hash — but it survived on luck (it had captured the diff first), and every later agent was given an explicit prohibition. |
| 2026-07-22 | **G2 review — an independent cross-cutting pass over the whole M3 phase found a live phishing bypass in shipped code, and four fix waves could not make the gate sound.** The review deliberately targeted what no work package owned: eight dimensions (requirement coverage, i18n, a11y, security/privacy invariants, "is the plan telling the truth about the code", "are the ADRs still true", cross-surface consistency, dead wiring), each finding then attacked by two refuters with different lenses. 46 raised, 38 survived, 2 HIGH. **The HIGH that stops the gate:** `classifyLink` cleared a link if ANY host-shaped word in the anchor text covered the target, and the anchor text was `textContent`, which is CSS-blind — while `sanitize` deliberately keeps `display:none` for preheaders. So `<span style="display:none">evil.tld </span>bank.test` read as `bank.test`, went to `evil.tld`, and raised no warning: a one-span opt-out of the only anti-phishing control (FR-RD-08), on fully attacker-controlled input, defeating an interstitial the code went out of its way to make non-disableable. **The instructive part is why M3.9's own adversarial review missed it:** the module header DOES reason about hidden markup — but only where hidden text DESTROYS a claim (a hidden `!` making `bank.test` read as prose). Tokenising fixed that direction and opened its mirror image, where hidden text ADDS an already-satisfied claim; and the tests match the blind spot exactly, hiding punctuation and hiding padding and never once hiding a host word. A reviewer inside M3.9 inherits that frame; the agent who found it read the file twelve days later with instructions to break it. **Four waves followed and every one was broken by its checker** — ten for ten across this gate and the last. Each round the checker found a hiding family the round before had not imagined: the same span WITHOUT a space (`evil.tld/bank.test` fuses to one token, so the visible claim is REPLACED rather than added to — my own PoC in the brief had a space, and all 106 wave-1 tests inherited it); `display:none!important` (the anchored regex — and `!important` is the spelling real mail overwhelmingly uses); twelve geometric vectors; `<img alt>`, where **our own remote-image blocking is what guarantees the alt renders**, so a privacy default makes the attack reliable; `<input type=image alt>`; U+2800 BRAILLE PATTERN BLANK, which renders as a gap and is neither `\s` nor `\p{Cf}`, i.e. no markup at all; and U+202E RIGHT-TO-LEFT OVERRIDE, where stripping the character made the gate read a string nobody ever saw. **What did work was changing the SHAPE of the rule, not extending it:** the quantifier was inverted (every claim must be honoured, so hidden text can only make the verdict stricter), claims are unioned over a raw and a boundary-separated rendering, and the sanitizer's anchor rule became an **allowlist of CSS properties** instead of a denylist of techniques — after which wave 4's checker could not break the property filter in 64 attempts, and the remaining defects were all in the *value* constraints beside it. The honest conclusion is recorded as **B19**: this gate is a best-effort heuristic against an attacker who writes both the markup and the CSS, twelve named ways past it remain open, and the absence of a warning means "nothing found", not "checked and safe" — which makes the interstitial's copy an owner decision, not a code one. **Second HIGH:** "Mark as unread" undid itself 1.5 s later, because the auto-mark-read effect carried `$seen` in its dependencies — reachable from the action bar and from another client. Fixed, then re-broken by the fix (the transition-cancel effect killed a legitimate arm when navigating from a read message to an unread one) and fixed again by owner identity rather than by declaration order, because order cannot separate navigation from mark-unread when both are one commit. **Also fixed:** an offline "Empty folder" that failed silently and told nobody; list toolbar controls that were enabled, wrote their preference and did nothing on the search and label seams (untested for the dominant case, a folder-scoped search, which is the one the gate exists for); two identical Trash icons side by side, one permanent; every comfortable-density row carrying a literal `undefined` class; the vacation preview opening links with no host check at all; and six document claims gone false — including the spec's own FR-NOTIF-02, which still asserted that no JMAP server can do Web Push, in the requirement an owner decision is about to be taken on. **A correction to the review's own method, recorded because it is the same failure it was hunting:** five findings were first filed as refuted by a single dissenting lens while the other lens said, verbatim, "CONFIRMED — could not refute". `survives = no dissent` is wrong for two voters with different jobs; caught by reading the refutation prose instead of trusting the boolean. **Two of the wrong prescriptions were mine again** — the whitespace in the PoC, and a demanded mutation that does not go red alone (the agent measured it, contradicted the brief and was right). Nine rows filed rather than absorbed (**B19**–**B27**); Web Push renumbered **D5 → D6**, since D5 was taken by the design-system sign-off of 2026-07-10 that `design-system.md:4` points at. **`pnpm verify`: 171 files / 2373 tests** (from 1965), **234.52 KB gz** of 300, `check:dist` OK. **`pnpm verify:e2e`: 66 green.** |
| 2026-07-23 | **Gate G2 passed — and probing the fixture before deciding turned the Web Push `L` into an `M`.** Three owner decisions close the gate. **D6: build Web Push, contentless (D6a)** — [ADR-017](adr/017-web-push-contentless.md), work package **M4.0**. The `L` this decision carried since 2026-07-21 rested on one assumption: that a closed-app banner must fetch its own content, because a `StateChange` (RFC 8620 §7.1) carries a state string per data type and no sender, subject or id — which drags the access token, the AES-GCM `SecretStore` and the OAuth refresh path into a DOM-free service worker. **Measuring instead of reasoning cut the assumption away.** Probed live against the pinned v0.16.14 fixture on the day of the decision: (1) Stalwart's `StateChange` carries **`EmailDelivery`** as a type distinct from `Email` — captured on the SSE channel while bob submitted to alice, `{"changed":{"b":{"Thread":"sae","Mailbox":"sae","EmailDelivery":"sae","Email":"sae"}}}` — so "new mail arrived" is separable from "another client read something"; (2) **`PushSubscription` carries a server-side `types` filter and Stalwart honours it** (created with a real P-256 key; `PushSubscription/get` returns `"types":["EmailDelivery"]`), so the **server** does the filtering and the worker needs no JMAP call, no token and no `SecretStore` access at all. The security property is the point, not the estimate: NFR-SEC-02's boundary stays untouched by background push, which is precisely what **B28** (sender + subject, D6b) would trade away — so B28 carries its own owner decision and a fresh NFR-SEC-02/NFR-SEC-04 review rather than arriving as an enhancement. **A fourth fact, found while probing and owned rather than buried:** the subscription **expires after 7 days and the ceiling is the server's** — requesting 90 days returns the same instant as requesting nothing (RFC 8620 §7.2 permits shortening) — and a client can only renew while running, so background notifications stop, silently, for anyone who does not open Waxwing within a week. M4.0 renews on start and states the limit in the settings; two further gaps are stated rather than implied, since `EmailDelivery` names no mailbox: **no per-folder filtering while closed** (FR-NOTIF-03's control applies to the live channel only and must not be left looking effective) and **no FR-NOTIF-05 actions** on the closed-app banner. **B19 (copy half): the phishing interstitial is not touched.** Its text is accurate whenever it appears — it claims a mismatch was found, and one was. The honest gap is the dialog's *absence*, and a hedge inside it would land on the one reader being warned correctly, weakening the warning that fired in order to qualify the ones that did not. The limitation goes where ADR-010's amendment already put the same kind of admission — **NFR-PRIV-02** — as a threat-model requirement on **M4.9**: the link check compares claimed host against target host, both attacker-written, so it is friction and not a boundary, and no warning means "nothing found". The document states the *shape* of the limit, not the list of twelve, which would age into a false floor the day one is closed. **The code half of B19 stays open and nothing about it is claimed fixed.** **D3 stays deferred** (2026-07-21: there is no v1.0 to raise the baseline to). Documents touched: ADR-017 new, ADR-010 marked reversed-in-part, FR-NOTIF-02/03/05 and FR-RD-08 amended, M4.0 filed ahead of M4.1 so the existing M4.x numbers other documents point at are undisturbed. |
| 2026-07-23 | **M4.0 — Web Push ships, contentless, and the security property became a build gate.** FR-NOTIF-02's headline is met for the first time: notifications while the app is fully closed. `@waxwing/jmap` gains `PushSubscription/get|set` — RFC 8620 §7.2, the one `get`/`set` pair in JMAP that neither takes nor returns an `accountId`, because a subscription belongs to the CREDENTIALS rather than to an account. The page subscribes with **`types: ['EmailDelivery']`**, so the SERVER filters and a push arriving already means mail arrived; the worker therefore needs no token, no JMAP call and no `SecretStore` access to raise its banner. **That property is now enforced rather than promised:** `check:dist` fails the build if `dist/sw.js` ever contains `SecretStore`, `oauth.refreshToken`, `waxwing-auth`, `Authorization`, `Email/get`, `Email/query` or `Dexie` (0 hits today), so **B28** — sender and subject on the closed-app banner — cannot arrive as a side effect of someone adding an import. It has to be a decision that deletes those lines and explains itself, which is exactly what ADR-017 said it should be. **Five things the build forced that the plan had not foreseen.** (1) The worker cannot run i18next, so the PAGE writes already-translated strings into a tiny raw-IDB store (`waxwing-push`, deliberately not the Dexie replica, which would break the worker's own program and ship Dexie to every visitor); a language switch has to rewrite them, carried by react-i18next handing back a new `t`, and a test pins that. (2) `quiet-hours.ts` was split out of `notify-model.ts` so the closed-app path and the live channel share ONE copy of the midnight-crossing rule — a second copy would drift and the symptom would be quiet hours that work with the app open and fail with it closed, at 3 a.m., where nobody is watching. (3) **Sign-out has to destroy the subscription while the client is still usable.** A subscription outlives a sign-out on the SERVER, which knows nothing about it, so a browser left subscribed keeps waking up and announcing new mail for a mailbox nobody is signed into — possibly to the next person at the machine. It says nothing about the message, which is not a defence: it still says this account receives mail, and the click opens the app. (4) The whole `waxwing-push` database goes with it, `deviceClientId` included, so a shared machine cannot re-register under the last user's identity. (5) A push endpoint is bound to the VAPID key it was minted against (RFC 8292 §4.2), so a server key rotation must replace the BROWSER subscription too — the old endpoint still answers `getSubscription()` while every push to it is rejected, i.e. it fails in the silent direction. **28 mutations were run and 2 survived, both real test defects, both the shape the G2 review kept finding — a test that passes for the wrong reason.** The sign-out test asserted the worker state was gone without ever having written one, so it was green against a teardown that wiped nothing. The device-id test compared two calls to `ensureDeviceClientId`, whose own first call is what persists the id — so it stayed green against a pass that minted a fresh `deviceClientId` on every start, which would leave the server accumulating one dead subscription per launch. Both are now asserted on **what reaches the server**, and both mutations were re-run red. **Two E2E assertions were rewritten by their own instructions, for the second time each.** `settings.spec.ts` first demanded the VAPID capability be ABSENT and said it must fail the day a server shipped RFC 9749 (Stalwart did, 2026-07-20); it then demanded the app admit "we do not deliver it yet" and said it must fail again if the client half shipped. It did, today. Both times the fix was to follow the code into honesty rather than pin a wording that had stopped being true — the new form guards that the good news is never stated ALONE, beside its three limits. **`pnpm verify`: 178 files / 2479 tests** (from 2459), **236.9 KB gz** of 300, `check:dist` OK. **`pnpm verify:e2e`: 66 green.** **What is NOT done, filed as B29 and not dressed up:** the closed-app delivery itself has never been observed working. Playwright cannot observe a closed app and the harness Chromium has no push service, so `subscribe()` fails and the app degrades to `unsupported` — correct behaviour, and it means the one thing this work package is named after is unproven by anything in this repo. It needs a real browser against a real push service, per platform, and so do two assumptions the settings copy rests on: whether iOS still requires a Home-Screen install, and whether the seven-day renewal actually holds across a week. |
| 2026-07-23 | **M4.1 — `@waxwing/jscontact`, built against RFC 9555 rather than against a mapping of our own.** The plan asked for JSContact ⇄ vCard 4.0 in both directions with a documented property matrix and lossless-where-possible round trips. Looking for the specification first turned out to answer two of those outright: **RFC 9555** *is* the normative mapping, and its `vCardProps` mechanism (§2.15.2) *is* the lossless answer — unmapped vCard properties ride as jCard values and are **written back on export**, so an Outlook card keeps its `X-MS-*` through an edit-and-export cycle and an Apple card keeps `item1.X-ABLabel` bound to the right phone number. An importer that preserves unknown properties and an exporter that ignores them lose exactly as much as one that never preserved anything. **Three layers, because every failure worth guarding is in the bottom one and all of them are silent.** (1) `\;` is a LITERAL backslash followed by a separator, so structured values are split BEFORE unescaping — unescape first and a Windows path in an address field swallows the town name. (2) Folding is counted in **octets** (§3.2), computed per code point rather than measured, which is why the package needs no Web API at all and cannot split a surrogate pair; the test measures the same strings with a `TextEncoder` as an independent oracle, so a bug in the arithmetic cannot hide behind a round trip that agrees with itself. (3) Unfolding removes the break and **exactly one** whitespace character, or a continuation that legitimately begins with a space loses it. **20 mutations run, 2 survived, and both were test defects of the shape this project keeps finding — an assertion that cannot distinguish the property it names.** The `PROP-ID` test used conventional ids (`e1`, `tel1`), which an implementation that ignores `PROP-ID` and re-derives them reproduces exactly; the photo-URI test used a bare base64 blob, which contains neither a comma nor a semicolon, so it stayed green against a writer that text-escaped every URI. A real `data:image/png;base64,…` contains both, and is now in the corpus. **A third defect was found by the DOCUMENTATION rather than by the code, which is the more interesting one.** `NICKNAME` and `URL` sat in the converter's `MAPPED` set — hence excluded from `vCardProps` as already handled — while no code converted them. They were dropped entirely: silent data loss in the one package whose whole promise is that nothing is lost silently, and invisible to every other test because nothing looks for a property that is simply *absent*. It surfaced because `matrix.test.ts` reads the README's own table and checks each row against behaviour: the matrix said "preserved", the code said "mapped", and neither said "dropped". Both are converted now. **The corpus is transcribed export shapes, not inventions** — the RFC 6350 example, Apple (vCard 3.0 with `item1.` group prefixes), Google (valueless `TYPE` shorthand, aggressive folding), Outlook (`CHARSET` parameters, `X-MS-` extensions, an all-empty `ADR` that must not become a blank address), a `data:` URI card, a group card and an escaping torture case. Each is asserted as a **fixed point** of import → export → import, which is what catches an asymmetry between the two halves without anyone having to guess in advance which property it would be — and it caught one immediately: the `VALUE` parameter was captured into the jCard type slot on import and never written back, so `KEY;VALUE=uri` lost its type on every cycle. **111 package tests; `pnpm verify`: 181 files / 2590 tests** (from 2479), **236.9 KB gz** — unchanged, because nothing in the app imports it yet. Builds standalone (`tsup`: 25.8 KB ESM + 13.5 KB `d.ts`) with the corpus tree-shaken out, verified by running the built bundle from Node. Wiring it into the app is M4.2/M4.3. |
| 2026-07-23 | **The Web Push hand-check found three defects on its first run, and none of them was findable by anything in this repo.** B29 existed because Playwright cannot observe a closed app; the harness (`pnpm webpush`) made the check cheap, the owner ran it in Safari over an SSH tunnel, and it failed immediately — with the server reporting **zero subscriptions**, then a subscription that was **never verified**. **(1) The Notification permission was per-component state.** `useNotificationPermission` kept it in a `useState`, so the settings screen granted it into its own copy while `PushSubscriptionHost` — the component that actually subscribes — held a stale `default` and never subscribed. Permission granted, switch on, nothing happening, and nothing on screen able to explain it, because from the app's point of view nothing had gone wrong. The two fallbacks both missed by construction: `visibilitychange` cannot fire while the tab stays visible, and Safari does not deliver the Permissions API `change` event for `notifications` — **which this repo's own comment stated, three lines above the bug**. Fixed by making it a shared store: the permission belongs to the BROWSER, not to a component, so every reader sees one value in one commit. **(2) The verification code was posted and not parked.** `sw.ts` parked it only when no window was open, treating `postMessage` as the primary route and the store as a fallback — exactly backwards. A window was open, the page's listener was not attached yet, and the code was gone for good; the subscription then sits unverified forever while the server pushes nothing but the verification it is still waiting for. It is now parked unconditionally, and the message is only what saves a reload. **(3) `startMessages()` was missing** — a `ServiceWorkerContainer` that uses `addEventListener` rather than assigning `onmessage` never drains its queued messages at all, so even a correctly timed listener would have received nothing. **A fourth was found while fixing:** the parked code was consumed on READ, on the reasoning that a code which fails to write back is worthless. True when the server rejects it; false in the case that actually happens, which is being offline — and there it turned a self-healing situation into a permanently unverified subscription. It is now consumed only once the server has accepted it, with a test that goes offline and then comes back. **What this says about the test suite is the useful part.** `push-reconcile.test.ts` drives the reconciliation with `wanted: true` and covers every branch; nothing exercised the React wiring that COMPUTES `wanted`, so a hook returning a stale value was invisible to 186 passing tests. The mutation runs did not help either: they mutate the code under test, and this defect lived in the seam between two correct components. Three of the four are now mutation-proven regressions; the third (`startMessages`) is a one-line browser requirement with no sensible unit test, and is recorded here instead. **`pnpm verify`: 182 files / 2597 tests, 237.01 KB gz.** B29 stays open — the delivery itself is still unobserved, which is precisely why it was worth keeping open rather than closing on "everything around it is tested". |
| 2026-07-23 | **The Web Push hand-check found the Safari verification failure's root cause — and it was neither our code nor Stalwart's core, but a fixture VAPID contact Apple rejects.** After the three M4.0 wiring bugs were fixed, Safari created a subscription but it never verified (`verified: NO`). Rather than keep asking the owner to spelunk Safari's console, the whole handshake was proven server-side, one leg at a time, with a capture-and-decrypt probe: register a `PushSubscription` at a local HTTPS endpoint whose self-signed CA the container was made to trust (`update-ca-certificates`), bypass Stalwart's per-account verify throttle with the `skip_checks` test hook, let Stalwart POST the verification, and RFC 8291-decrypt it. Three things fell out, each independent: **(a)** Stalwart's `PushVerification` decrypts cleanly — `Content-Encoding: aes128gcm`, raw octets (not base64-wrapped), VAPID-signed, and the exact JSON shape `{"@type":"PushVerification","pushSubscriptionId","verificationCode"}` our parser expects. This closes ADR-010's central worry not "at source" but **on the wire against v0.16.14**. **(b)** Writing the decrypted code back exactly as `submitPushVerification` does (`PushSubscription/set update {verificationCode}`) flipped the server to verified — our writeback format is correct. **(c)** Our SW parser matches the payload. So both halves of the client and the whole server are proven correct. **The break was the VAPID `sub` claim.** Stalwart falls back to `mailto:postmaster@{hostname}` when no contact is configured, and the fixture container's hostname was the random Docker id `132e0ba72d04` — no dot, not a valid mailto domain. Decoding the JWT Stalwart actually sent confirmed `sub: mailto:postmaster@132e0ba72d04`. **Apple's push service rejects a VAPID token with an invalid `sub`; FCM tolerates it** — the precise reason it fails on Safari and would have quietly passed on Chrome, and a landmine for anyone deploying Waxwing behind a server without a real hostname. Fixed by giving the fixture a DNS-shaped hostname (`hostname: mail.waxwing.test`); the probe then shows `sub: mailto:postmaster@mail.waxwing.test`. **Method note worth keeping:** the probe is the tool B29 always needed — it exercises the exact bytes a browser would, so the parts of Web Push that no Playwright run can reach became testable after all, everywhere except the final APNs→Safari hop. Recorded under **B29**, which stays open until an owner re-test sees a contentless banner with every tab closed. |
| 2026-07-23 | **The Web Push hand-check ran to its end, and the last link turned out to be neither Waxwing nor Stalwart.** After the fixture VAPID-`sub` fix failed to make Safari verify, a Chrome counter-test failed identically — which killed every Apple-specific theory at once (strict `sub` validation, `userVisibleOnly` and silent pushes, the whole APNs story). What finally answered it was making the fixture **observable**: Stalwart's default tracer targets `/var/log/stalwart` and it runs as uid 2000, so it could not create that directory and had been emitting **zero diagnostics** — `docker logs` empty, no log file, every downstream failure invisible. A tmpfs at that path (now in docker-compose.yml) plus raising the tracer to `trace` through the management JMAP API (`x:Tracer/query` + `x:Tracer/set`, a surface the REST settings API no longer provides) produced the decisive line: **`push-subscription.success` with the `fcm.googleapis.com` endpoint — Google ACCEPTED the push.** That settles the chain end to end: Waxwing's SW parser and its writeback are correct (both proven independently — the writeback by completing a real handshake server-side), Stalwart's `aes128gcm` encryption, VAPID claims and payload format are correct (proven by decrypting its push on the wire with a CA-trusted capture endpoint), and Stalwart's POST to the push service succeeds. **The failure is the final hop, push service → browser**, for BOTH services: FCM accepts and does not deliver to Chrome, APNs behaves the same toward Safari. Two independent push services failing identically while both return success points at the client machine's connectivity to them — Chrome holds a persistent FCM connection (5228, falling back to 443) and Safari an APNs one (5223/443), and corporate networks routinely block exactly those. `chrome://gcm-internals` confirms it in a minute. **No upstream report this time:** unlike the three filed in `docs/upstream/`, Stalwart is doing everything correctly here, and saying otherwise would be wrong. **What the session leaves behind:** four real defects fixed (three M4.0 wiring bugs, plus **B30** — a lost server delta state stranding the whole app on a permanent sync error a reload could not clear), a fixture that can no longer run blind, a decrypt probe that exercises the exact bytes a browser would see, and — the point of B29 — the knowledge that M4.0's implementation is *correct*, which no amount of green unit tests had established. B29 stays open, but its question has narrowed to finding a network where the push services can reach the browser. |
| 2026-07-23 | **The Web Push failure was ours all along, and Chrome's `gcm-internals` said so in three lines.** After the fixture VAPID fix, the Chrome counter-test and the trace-level Stalwart log had each eliminated a suspect — and each of my explanations (Apple's strict `sub`, `userVisibleOnly` and silent pushes, the client machine's reachability) turned out to be wrong — the browser's own diagnostics settled it: the verification push **arrived and decrypted cleanly** (`Data msg received`, 557 bytes, Decryption Failure Log empty), the subscription was **unregistered in the same second**, and a **new one registered 44 seconds later**. That is a loop: push arrives → subscription destroyed → app re-subscribes → server sends a verification for the new one → repeat. The code the service worker parked always belonged to a subscription that had just ceased to exist, so the handshake could never close, and every round hid the evidence of the last. **The destroyer was our own reconciler.** It collapsed four independent inputs into a single `wanted` boolean — master switch AND browser permission AND server capability AND live client — and treated `false` as "the user does not want this", tearing down both halves of the subscription. But three of those four are TRANSIENT: `client` is null while the session reconnects, `serverSupports` is false until the session document has loaded, and the permission reads `default` before it has been read at all. So an ordinary reconnect — or the re-render that follows a push — destroyed a perfectly healthy subscription. **Fixed by separating "no" from "not yet":** only the master switch being off, or a `denied` permission, may tear anything down; every other falsy state now returns a `cannotAct` outcome and leaves the subscription untouched. A real sign-out still tears down explicitly, in the session provider, where the intent is actually known. Four regression tests; three mutations (including restoring the shipped bug verbatim) proven red. **Why nothing here could have caught it:** `push-reconcile.test.ts` drove the reconciler with `wanted: true` and covered every branch below it, but the bug lived in the *collapse* — in how the React layer computed that boolean from four states that are individually correct. Both this and the earlier permission-store defect were invisible for the same reason: they sat in the seam between components, which is where unit tests and mutation runs both stop looking. **`pnpm verify`: 182 files / 2602 tests, 237.13 KB gz.** B29 stays open until a banner is actually seen, but for the first time there is no known defect standing between here and that. |
| 2026-08-16 | **M4.4 stage 4 — the sidebar that shipped shared mailboxes had made every write to them land on the wrong account.** Stage 3 re-scoped the panes to the acting account but left one `activeEngine` singleton, which the fleet only ever set to the PRIMARY. Because JMAP ids are per-account and SHORT (`a`, `b`, …), an archive/move/rename from a shared tree reached the primary's engine and named a real, DIFFERENT mailbox: nothing fails, the wrong thing succeeds — and `emptyMailbox` destroys that folder's contents. The rule that replaced it (ADR-018): the engine a call uses is the one whose account matches the `useReplica().accountId` of the subtree it is made in — not "the active account", because the sidebar renders every account's tree at once, so a single pointer cannot be right. `OutboxIntent` was deliberately left alone: dispatch already stamps the engine's account, the outbox row is keyed by it, and the payload is persisted verbatim, so a field added now would be absent forever on existing offline rows. Engine routing alone would have moved the corruption rather than fixed it, so three provider-scope changes were non-negotiable: the keyboard layer and `useSearch` resolved role/`in:` mailbox ids against the primary while acting on the active account, and the drag subject carried no account at all (the grouped sidebar makes a cross-account drop physically possible, and the old predicate accepts it). Four defects closed: B33, B35, B36, and a sign-out that stopped only the primary while shared engines held IndexedDB handles the wipe blocks on. Two unmasked, and they are the honest cost: a write to a read-only shared mailbox now really reaches the server and is rejected (**B34** — nothing checks `myRights` for message writes), into a dead letter nothing surfaces (**B32**). Both anti-corruption fixes are pinned by mutation-checked tests: reverting `getEngineFor`'s miss branch to `?? activeEngine`, or the nested-provider guard, turns them red. E2E coverage remains impossible until the fixture can delegate. |
| 2026-08-16 | **The shared-mailbox story became provable, and the fixture answered three questions the docs could not.** M4.4's "Done when" had been unassertable since it was written: the fixture provisions standalone users, so `secondaryMailAccounts()` returned `[]` and every delegated-account path was dead code in every suite. Settled by probing a live Stalwart v0.16.14 rather than by reading: sharing is `Mailbox/set` + `shareWith` keyed by the grantee's **principal** id and performed by the **grantor** (the recovery admin cannot do it for them); the grantee's session then carries the account with `isPersonal:false` and its own `urn:ietf:params:jmap:mail`, and shows only the shared mailbox. Two findings changed other work: **`Account.isReadOnly` stays `false` even for a read-only share**, so the account flag is not a permission signal and B34 must gate on per-mailbox `myRights`; and writes beyond a grant are refused **per id** as `notUpdated[id] = {type:'forbidden'}`, which `classifySetError` already handles — the refusal is not lost, only invisible (B32). Delegation is **opt-in**, decided on evidence: enabling it in `provision()` failed the entire read suite, because a share turns the sidebar into account-grouped sections and makes the `treeitem name=/Inbox/` locator that 19 call sites use ambiguous — and it would have left the single-account path, the documented byte-for-byte invariant, with no E2E coverage at all. `e2e:shared` grants in setup and revokes in teardown; `smoke()` asserts the single-account default so a leaked share fails at its source rather than in an unrelated suite. Five specs, in the gate. Started B34 with the part that needs no UI: `mail/rights.ts`, the single rule for which right governs which write and over which mailboxes — joined from `mailboxIds`, never from the folder on screen, ALL rather than Stalwart's ANY (it may grey out what the server would accept; it can never offer what the server rejects), with an account-floor clause that provably leaves the single-account path untouched. Wired into the triage seam as defence in depth; the surfaces that must EXPLAIN a refusal are not done. One E2E failure is recorded rather than smoothed over (**B39**). |
| 2026-08-16 | **A gate that runs itself, and refuses to run when it could not be trusted (ADR-019).** ADR-003 accepted in writing that "correctness relies on contributors running `pnpm verify`", and that reliance had just cost a debugging detour: `.nvmrc` pins node 24, `engines` says `>=22`, the machine defaults to 26 — where a global `localStorage` shadows jsdom's and fails 22 tests with nothing wrong in the code. `pnpm gate` (`scripts/ci.mjs`) now refuses to start on the wrong major and says why. It also closes half of **B22**: the `@waxwing/jmap` integration suites ran in neither verify script and `describe.skipIf` themselves away when the fixture is down, so a skip was indistinguishable from a pass and nothing had ever failed because they did not run — the pipeline runs them against a live fixture and **asserts nothing was skipped** (8 tests, first real run). `.githooks/pre-push` runs the hermetic half automatically. `.github/workflows/ci.yml` is written and dormant, calling the same scripts so local and hosted cannot drift. Running that workflow locally with **`act` was evaluated and rejected on a verified failure**: act mounts the host docker socket rather than nesting a daemon, so the fixture's compose bind mounts resolve to non-existent host paths — and Docker silently substitutes empty directories, booting Stalwart with no config and no diagnostic, the same silent class as B29. Two self-inflicted bugs found on the way: `pnpm ci` is a BUILT-IN pnpm command (clean-install) and would have shadowed the script (hence `gate`), and the integration stage left its fixture up, which the E2E stage inherited and which failed two offline specs — it now tears down first. On cost, since it was the stated reason to defer: GitHub-hosted runners are free with no minute cap on public repositories, so the eventual CI is expected to cost nothing; the reason to wait is that no repository exists. |

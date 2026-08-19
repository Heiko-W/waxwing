# Architecture Decision Records (ADRs)

Waxwing records notable architecture and scope decisions here — one file per decision,
named `NNN-kebab-title.md`, numbered sequentially from `001`. See
[implementation-plan.md §2.3](../implementation-plan.md) for when to write one.

Format: lightweight [MADR](https://adr.github.io/madr/), one page maximum.

## Template

    # NNN — Title

    - **Status:** proposed | accepted | superseded by ADR-XXX
    - **Date:** YYYY-MM-DD
    - **Deciders:** …

    ## Context
    Why a decision is needed; the forces at play.

    ## Decision
    What we decided.

    ## Consequences
    Trade-offs, follow-ups, what becomes easier or harder.

## The decisions

| | Decision | Status |
| --- | --- | --- |
| [001](001-vite-8-instead-of-vite-7.md) | Vite 8 instead of Vite 7 | accepted |
| [002](002-stalwart-dev-fixture-design.md) | Stalwart dev/E2E fixture design | accepted |
| [003](003-local-verify-first-ci-later.md) | Local verify scripts first, GitHub Actions CI later | accepted |
| [004](004-account-scoped-auth-storage.md) | Account-scoped auth storage from day one | accepted |
| [005](005-sse-fetch-reader-not-eventsource.md) | SSE via a fetch-based reader, not the native EventSource | accepted |
| [006](006-oauth-token-posture-no-revocation.md) | OAuth token posture: no server-side revocation; local-wipe logout | accepted |
| [007](007-own-router-and-context-state.md) | Own hash-free router; React context for app state (no react-router, no Zustand yet) | accepted |
| [008](008-replica-account-scoping-shared-db.md) | Replica account-scoping: one shared database with `[accountId+id]` keys | accepted |
| [009](009-runaway-m27-m31-independent-review.md) | M2.7–M3.1 delivered by a runaway agent: keep, independently review, remediate | accepted |
| [010](010-web-push-deferred-no-vapid.md) | Web Push (app closed) deferred: no JMAP server can sign a browser push | accepted — **reversed on 2026 |
| [011](011-eml-download-needs-no-blob-capability.md) | `.eml` download / view source needs no Blob capability; there is no fallback path | accepted |
| [012](012-drag-and-drop-is-desktop-only.md) | Drag & drop (FR-MBX-03) uses HTML5 DnD, not pointer events; touch is served by swipe + the non-pointer paths | accepted — **amended 2026 |
| [013](013-swipe-gestures-use-pointer-events.md) | Row swipe uses pointer events, commits only on a full swipe, and never destroys | accepted |
| [014](014-swipe-archive-has-no-trash-fallback.md) | A swipe configured "Archive" never falls back to Trash | accepted |
| [015](015-css-is-verified-by-two-static-checks.md) | CSS gets two static checks, and the focus one is the load-bearing half | accepted |
| [016](016-anchors-lose-their-structural-hiding.md) | Inside an anchor, an inline style is filtered against a property allowlist | accepted |
| [017](017-web-push-contentless.md) | Web Push ships contentless: the server filters, the worker asks nothing | accepted |
| [018](018-engine-selection-is-keyed-by-account.md) | Engine selection is keyed by account, not by a single "active" pointer | accepted |
| [019](019-local-pipeline-before-hosted-ci.md) | A local pipeline now, the hosted workflow written but dormant; `act` rejected | accepted |
| [020](020-no-send-as-from-a-delegated-account.md) | Send-as from a delegated account is not offered (the server does not allow it) | accepted |
| [021](021-undo-is-a-chord-and-a-toast-that-waits.md) | Undo is a chord (`z`) plus a toast that does not expire | accepted |
| [022](022-identities-are-editable-in-the-client.md) | Identities and signatures are editable in the client, online-only | accepted |

Regenerate this table after adding an ADR — it is written by hand, and a missing row is the
kind of omission nobody notices.

// Waxwing bundle-size budgets — enforced by `pnpm size` / `pnpm verify` (P0.5,
// NFR-PERF-01 / NFR-PERF-03; GitHub Actions CI deferred per ADR-003).
//
// Run with `pnpm size`, which builds apps/web FIRST (size-limit only measures files,
// it does not build) and then runs size-limit against the emitted bundle. A budget
// overrun exits non-zero, failing `pnpm verify`.
//
// Only the apps/web critical-path budget is ENFORCED today. The per-package library
// budgets are DEFERRED: @waxwing/jmap and @waxwing/mail-html are scaffolds with no lib
// build yet (they land in SP.1 and M1.7). Adding them now would fail on missing files,
// so they are kept below as documented, commented targets. Activate each — uncomment and
// add it to the exported array — when that package gains a build that emits dist/*.js:
//
//   { name: '@waxwing/jmap (gzip)',      path: 'packages/jmap/dist/**/*.js',      limit: '15 KB', gzip: true },
//   { name: '@waxwing/mail-html (gzip)', path: 'packages/mail-html/dist/**/*.js', limit: '40 KB', gzip: true },
//
// (@waxwing/jmap targets <= 15 KB gz per the plan; @waxwing/mail-html bundles a
// DOMPurify-class sanitizer, so its real budget is set in M1.7 — the number above is a
// placeholder, not a decision.)
//
// NOTE on the apps/web path: `assets/*.js` currently equals the critical path — the only
// emitted chunks are the entry (`index-*.js`) plus two tiny lazy i18n locale chunks. When
// route-level code splitting lands (NFR-PERF-03), narrow this to the entry chunk (e.g.
// `apps/web/dist/assets/index-*.js`) so on-demand route chunks are not counted against the
// initial-load budget.

export default [
  {
    name: 'apps/web initial JS (critical path, gzip)',
    path: 'apps/web/dist/assets/*.js',
    limit: '300 KB',
    gzip: true,
  },
]

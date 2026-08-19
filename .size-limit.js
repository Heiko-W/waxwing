// Waxwing bundle-size budgets — enforced by `pnpm size` / `pnpm verify` (P0.5,
// NFR-PERF-01 / NFR-PERF-03), locally and in the hosted `verify` job since 2026-08-17.
//
// Run with `pnpm size`, which builds apps/web FIRST (size-limit only measures files,
// it does not build) and then runs size-limit against the emitted bundle. A budget
// overrun exits non-zero, failing `pnpm verify`.
//
// Only the apps/web critical-path budget is ENFORCED today. The per-package library
// budgets are DEFERRED: `pnpm size` builds only apps/web, so pointing at
// packages/*/dist would measure a stale (or missing) artifact. Documented targets:
//
//   { name: '@waxwing/jmap (gzip)',      path: 'packages/jmap/dist/**/*.js',      limit: '15 KB', gzip: true },
//   { name: '@waxwing/mail-html (gzip)', path: 'packages/mail-html/dist/**/*.js', limit: '25 KB', gzip: true },
//
// ── WHAT IS MEASURED, AND WHY IT IS NOT JUST `index-*.js` (fixed in M3.7) ──────────────────
//
// The budget is "initial JS" — everything the browser must fetch and execute before first
// paint. Until M3.7 this was measured as `index-*.js` alone, on the assumption of a single
// eager entry chunk. That assumption expired: the emitted `index.html` now `modulepreload`s
// FOUR further chunks that the entry chunk *statically* imports (React/jsx-runtime, the UI
// primitives, i18next, initReactI18next). They are part of the initial load in every sense
// that matters, and measuring the entry alone under-reported it by ~21 KB gz — a budget that
// SHRANK by 17 KB while the code merely moved sideways. The old config predicted exactly this
// ("If a vendor chunk is introduced later, index-*.js would UNDERCOUNT the initial load —
// re-widen to enumerate all eager chunks then"), so: re-widened.
//
// The rule is now inverted, deliberately, so it fails SAFE. Everything under `assets/` counts
// as initial JS *unless it is explicitly excluded as a lazy chunk*. A new eager chunk is
// therefore counted automatically; a new LAZY chunk has to be named here, which is a change a
// reviewer can see. The alternative — listing the eager chunks — silently under-counts the day
// the bundler splits out one more.
//
// The exclusions below are the route/dialog chunks loaded via `import()` (NFR-PERF-03) and the
// lazy i18n locale bundles. Keep them in step with the `lazy(() => import(...))` call sites.

export default [
  {
    name: 'apps/web initial JS (all eager chunks, gzip)',
    path: [
      'apps/web/dist/assets/*.js',
      // Lazy route screens (app/shell/AppShell.tsx).
      '!apps/web/dist/assets/SettingsPage-*.js',
      '!apps/web/dist/assets/ContactsPage-*.js',
      // Lazy composer + its editor engine (compose/, loaded only once a draft is open).
      '!apps/web/dist/assets/ComposerHost-*.js',
      '!apps/web/dist/assets/squire-adapter-*.js',
      // Lazy dialogs.
      '!apps/web/dist/assets/OutboxProblemsDialog-*.js',
      '!apps/web/dist/assets/InstallDialog-*.js',
      // The contacts import/export dialog (contacts/, M4.3, FR-CON-06) and the jscontact conversion
      // RUNTIME it drives — the latter split into a chunk of its OWN via contact-io's
      // `import('./jscontact-runtime')`, so the ~26 KB vCard⇄JSContact converter is fetched only when
      // a user imports/exports and never touches the entry OR the ContactsPage read chunk.
      '!apps/web/dist/assets/ContactImportExportDialog-*.js',
      '!apps/web/dist/assets/jscontact-runtime-*.js',
      // The contacts CSS-module class map, split into a shared chunk the day a SECOND lazy chunk (the
      // import/export dialog) started importing `contacts.module.css` alongside `ContactsPage`. It is a
      // dependency of those two lazy chunks only — never modulepreloaded by index.html — so it loads
      // with the contacts area, not at first paint.
      '!apps/web/dist/assets/contacts.module-*.js',
      // The raw .eml source view (mail/, M3.9) — opened from the reading pane's overflow menu.
      '!apps/web/dist/assets/MessageSourceDialog-*.js',
      // The phishing-friction interstitial (mail/, M3.9, FR-RD-08) — raised only by a link whose
      // text names a host the link does not go to.
      '!apps/web/dist/assets/LinkWarningDialog-*.js',
      // Lazy keyboard overlays (shortcuts/, M3.8): the ⌘K palette (with its fuzzy matcher) and the
      // `?` cheat-sheet. The registry + dispatcher stay eager; these two surfaces do not.
      '!apps/web/dist/assets/CommandPalette-*.js',
      '!apps/web/dist/assets/ShortcutHelp-*.js',
      // The attachment archiver (mail/, M5.3): `client-zip` plus the naming rules, fetched only when
      // a reader asks to save a message's attachments as one file.
      '!apps/web/dist/assets/attachment-zip-*.js',
      // Lazy i18n locale bundles (one per language, fetched on demand).
      '!apps/web/dist/assets/common-*.js',
    ],
    limit: '300 KB',
    gzip: true,
  },
]

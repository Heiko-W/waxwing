# Waxwing — Agent Instructions

Waxwing is a serverless (static-only) webmail client for JMAP. App code AGPL-3.0;
`packages/jmap` and `packages/jscontact` MIT.

## Read first, in this order

1. `docs/functional-specification.md` — WHAT to build (FR-/NFR-IDs)
2. `docs/tech-stack.md` — HOW: stack and architecture decisions
3. `docs/implementation-plan.md` — WHEN: the work-package roadmap. Unless the user
   directs otherwise, pick the next `todo` work package whose dependencies are `done`
   (status board, plan §3).

## Rules

- Follow the plan's session protocol (implementation-plan.md §2): one WP at a time,
  update the status board and task checkboxes at session end, leave the repo green.
- On conflict, spec and tech-stack win over the plan. Deviations from any document are
  recorded as ADRs in `docs/adr/` and the affected docs are updated — never silently.
- Global Definition of Done (plan §2.4) applies to every change: TypeScript strict,
  Biome clean, tests, no hardcoded user-visible strings (i18next, `en` + `de`),
  keyboard/a11y basics, `size-limit` budget (≤ 300 KB gz initial JS).
- Conventional Commits (scopes: `web`, `jmap`, `mail-html`, `jscontact`, `sync`, `e2e`,
  `docs`, `ci`).

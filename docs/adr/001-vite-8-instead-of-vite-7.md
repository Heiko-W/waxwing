# 001 — Vite 8 instead of Vite 7

- **Status:** accepted
- **Date:** 2026-07-05
- **Deciders:** project owner, P0.2 implementer

## Context

`tech-stack.md` §3/§4.1 named **Vite 7** as the build tool for `apps/web`. When
scaffolding P0.2 (App scaffold) the current major on npm is **Vite 8.1.3**, and the React
integration plugin **`@vitejs/plugin-react` 6** declares a peer dependency of `vite@^8`.
Pinning Vite 7 would force an older, soon-unsupported plugin line and diverge from the
ecosystem default a community project should track. Vite 8 ships the **Rolldown** bundler
(Rust-based) as its production bundler. The optional React-Compiler integration
(`babel-plugin-react-compiler`) is a separate, non-required peer and is deliberately left
off for now (React 19's runtime performance is sufficient for our hot path, which is
handled by virtualization — tech-stack §4.1).

## Decision

Adopt **Vite 8** (range `^8.1.3`) with **`@vitejs/plugin-react` `^6.0.3`** for `apps/web`.
Do **not** add `babel-plugin-react-compiler`. Rolldown is the bundler.

## Consequences

- `tech-stack.md` is updated: every "Vite 7" mention becomes "Vite 8", and the §3 stack
  table's UI-framework row references this ADR.
- The production bundler is Rolldown; bundle-size behaviour (NFR-PERF-01, the ≤ 300 KB gz
  initial-JS budget enforced by `size-limit` in P0.5) is measured against Rolldown output.
- If the Rolldown output ever breaks the size budget or produces incompatible artifacts,
  revisit this decision (fall back to the Rollup-based Vite line or pin an older major).
- The React Compiler remains an easy future opt-in should render cost ever matter.

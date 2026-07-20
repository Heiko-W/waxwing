// The STAGED SECOND BUILD used by tests/deploy.spec.ts (M3.10 wave 2).
//
// The update-toast flow can only be tested against two builds that are genuinely different, and
// "genuinely" is the load-bearing word. The browser fires `updatefound` on ANY byte difference in
// `sw.js`, so it is easy to produce a second build that raises the toast while proving nothing about
// a deploy: copy dist, append a comment to sw.js, done — but the precache manifest is then
// IDENTICAL, no chunk hash moved, and "the reload landed on the new build" is not assertable at all
// because there is nothing to tell the two apart.
//
// ── WHY A TEST-OWNED VITE CONFIG, AND NOT THE THREE OBVIOUS ALTERNATIVES ──────────────────────
//
// This config extends the app's own and adds ONE plugin, which appends a global assignment to
// `src/main.tsx` at transform time — i.e. BEFORE bundling and hashing. Measured result: the entry
// chunk hash moves (`index-BdaYMFSZ.js` → `index-0SZTg-4y.js`), `index.html` changes, its precache
// revision changes, and `sw.js` differs. That is a real deploy, and `__WAXWING_STAGED_BUILD__` is a
// direct, honest answer to "which build is running right now?" rather than an inference.
//
//   * NOT a `__WAXWING_BUILD_ID__` define in apps/web/vite.config.ts. That is a change to PRODUCTION
//     build configuration whose only justification is a test, which is the wrong way round. The
//     cost belongs in the package that benefits, and this is it.
//   * NOT copy-dist-and-append-a-comment. Zero production change, but the precache manifest is
//     unchanged, so the test could only ever prove "a new worker raises a toast" — not that the
//     thing being deployed was new. A narrow test under a broad name.
//   * NOT patching a tracked source file in globalSetup and reverting it. It mutates the working
//     tree mid-run, so an interrupted run leaves the repo dirty and a dirty tree corrupts the build.
//
// A Rollup `output.banner` was tried first and REJECTED on evidence: under rolldown it is applied
// after hashing, so both builds came out byte-identical (same entry filename, same `sw.js`). The
// injection has to happen in `transform` to reach the hash.
//
// Invoked by pwa-build.mjs, never by hand.

import base from '../apps/web/vite.config.ts'

/** Where this build writes. Absolute; pwa-build.mjs owns the layout. */
const OUT_DIR = process.env.WAXWING_STAGE_OUT_DIR
if (!OUT_DIR) throw new Error('pwa-stage.vite.config.mjs: WAXWING_STAGE_OUT_DIR is required')

/** The value the staged build publishes as `globalThis.__WAXWING_STAGED_BUILD__`. */
const MARKER = process.env.WAXWING_STAGE_MARKER ?? 'b'

/**
 * A GLOBAL ASSIGNMENT, not a comment and not an exported constant — both of those would be removed
 * before they could reach a content hash. A comment is stripped by minification; an unused export is
 * tree-shaken. An assignment to `globalThis` is a side effect the bundler must keep, so it survives
 * into the entry chunk, moves its hash, and is readable from the page.
 */
const stampBuild = {
  name: 'waxwing-e2e-stage-build',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/src/main.tsx')) return null
    return `${code}\n;globalThis.__WAXWING_STAGED_BUILD__ = ${JSON.stringify(MARKER)};\n`
  },
}

export default {
  ...base,
  plugins: [...(base.plugins ?? []), stampBuild],
  build: { ...base.build, outDir: OUT_DIR, emptyOutDir: true },
}

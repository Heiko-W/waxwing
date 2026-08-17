// Waxwing BUILD-ARTEFACT contract for the PWA shell (M3.10; handed over from M3.5).
//
// Asserts things about `apps/web/dist` that no other gate can see, because every other gate looks
// at SOURCE:
//
//   1. the precached set in `dist/sw.js` is EXACTLY `index.html` + every emitted `assets/**` chunk
//      — nothing missing, nothing extra;
//   2. the BUILT `index.html` still carries its single `<base href="/" />` token, still references
//      its assets RELATIVELY, and still ships the CSP with its security-critical values intact.
//
// ── WHY THIS IS NOT A UNIT TEST AND NOT AN E2E ────────────────────────────────────────────────
//
// It is an assertion about a file on disk, so it needs neither a browser nor a DOM. Running it
// under Playwright would pay a build, a server and a browser launch for two file reads. Running it
// under `pnpm test` would be worse: that gate is deliberately hermetic and build-free (it is the
// inner loop), and `pwa-options.ts` goes as far as disabling the PWA plugin outright when
// `VITEST=true` — so a vitest test reading `dist/` would read whatever stale tree happened to be
// lying around, or none at all. `.size-limit.js` already established the shape this belongs in:
// assert over `dist`, after the build, inside `pnpm verify`. This is its neighbour, and it runs
// immediately after `pnpm size` for the same reason — `size` is what guarantees the tree is fresh.
//
// ── WHAT EACH HALF CATCHES THAT `pwa-options.test.ts` CANNOT ──────────────────────────────────
//
// `pwa-options.test.ts` asserts the CONFIGURATION: the globs, the ignores, the size ceiling. It is
// structurally blind to whether the configuration produced the intended artefact, and the gap is
// not hypothetical:
//
//   * **A precache glob that stops matching.** This is the live silent failure, and nothing else in
//     the repo can see it. The globs name a DIRECTORY (`assets/**/*.{js,css}`); the bundler decides
//     what goes there. Point `build.rollupOptions.output.chunkFileNames` at another directory, or
//     emit a new asset kind, and the chunks are simply not swept up: the config test still passes
//     (the globs are unchanged and correct), the build exits 0, and the shipped worker precaches an
//     app shell with no app in it. Only a comparison against what is actually ON DISK notices, and
//     only in the disk→manifest direction — a check written the other way round (manifest ⊆
//     allowlist) sails straight past it. Mutation-proven with exactly that mutation (M3.10 wave 2).
//   * **An oversized chunk — but read the caveat.** M3.5's hand-over described this as Workbox
//     warning and silently omitting the file. That is true of `workbox-build` itself and NOT true
//     of what we ship: `vite-plugin-pwa@1.3.0` resolves `throwMaximumFileSizeToCacheInBytes` to
//     `!showMaximumFileSizeToCacheInBytesWarning`, which defaults to `false`, so the plugin
//     ESCALATES the warning to a build error (verified empirically: lowering the ceiling to 500 000
//     fails `vite build` outright). Two things nevertheless remain for this check. The plugin
//     throws in `closeBundle`, i.e. AFTER `dist/sw.js` has already been written — so a failed build
//     leaves a broken artefact on disk that a later `--no-build` step would happily serve. And the
//     silent behaviour is one option away: `showMaximumFileSizeToCacheInBytesWarning: true` restores
//     it. Neither is the reason this file exists; the glob case above is.
//   * **Base and asset relativity.** `apps/web/src/pwa/index-html.test.ts` asserts the `<base>` tag
//     in the SOURCE `index.html`. It says nothing about what Vite's html transform emitted, and
//     nothing at all about the asset URLs — those do not exist in the source. Flipping
//     `base: './'` to `'/'` in vite.config.ts leaves every source test green while shipping a
//     bundle that cannot be mounted under a path prefix (FR-DEP-02) at all.
//   * **The CSP, on the SHIPPED document.** `index-html.test.ts` does read the source policy and
//     assert `default-src 'self'` and `base-uri 'self'` — deleting the meta element turns
//     `pnpm verify` red, which is more than the security review credited it with. What it does not
//     do is cover the rest of the policy: `script-src 'self'`, `object-src 'none'` and
//     `form-action 'self'` are unasserted there, so adding `'unsafe-inline'` to `script-src` — the
//     single change that would undo NFR-SEC-01 and the whole "a sanitizer miss cannot run
//     JavaScript" claim in SECURITY.md §1 — leaves every gate green. And no test at all looks at
//     the BUILT document, which is the one an operator receives: Vite rewrites `index.html`, and a
//     plugin that mangles or drops the meta tag would be invisible to a source-only assertion.
//
// Dependency-free: node: builtins only, matching scripts/verify-e2e.mjs.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'apps/web/dist')

/**
 * Kept in step with `apps/web/src/pwa/sw-routes.ts` by hand rather than imported: this is a
 * dependency-free `.mjs` in the repo root and that is TypeScript inside the web package. The
 * duplication is deliberate and small — and if it ever drifts, the precache assertion below is
 * what notices, because a file that moved between the two lists changes which side it lands on.
 */
const NEVER_PRECACHE = ['config.json', 'theme.css', 'manifest.json']

/**
 * Emitted JS/CSS that must NOT be precached, and why each one is here. This list is the ONLY
 * escape hatch in the disk→manifest comparison, and that is deliberate — the rule is inverted so it
 * fails SAFE. Every `.js`/`.css` file the build emits is required to be in the offline shell unless
 * it is named here, so a new chunk is covered automatically and an exclusion is a diff a reviewer
 * can see. (`.size-limit.js` inverts its rule for exactly the same reason, and says so.)
 */
const NOT_PRECACHABLE = [
  // The worker cannot precache itself; the browser fetches it by registration, not from a cache.
  /^sw\.js$/,
  // If the worker bundle is ever code-split, its chunks arrive under this name.
  /^workbox-[^/]*\.js$/,
  // Hoster-editable deployment files — runtime-cached instead, so an edit lands without a rebuild.
  /^theme\.css$/,
  // The branding tree is hoster-editable wholesale (NEVER_PRECACHE in sw-routes.ts).
  /^branding\//,
]

/** Every `.js`/`.css` file under `dist`, as paths relative to the dist root. */
function emittedCodeFiles(dir = DIST, prefix = '') {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory())
      found.push(...emittedCodeFiles(resolve(dir, entry.name), `${relative}/`))
    else if (/\.(js|css)$/.test(entry.name)) found.push(relative)
  }
  return found
}

const failures = []
const fail = (message) => failures.push(message)

/**
 * The injected precache manifest, read back out of the bundled worker.
 *
 * `injectManifest` writes it as a plain JSON array literal — `precacheAndRoute([{"revision":…}])`
 * survives minification as data — so it can be recovered with a regex and `JSON.parse`. The global
 * match plus the single-match assertion is the guard against reading the wrong array: if the
 * bundler ever emits a second `{"revision":…}` literal, this fails loudly instead of asserting
 * confidently about the wrong one.
 */
function precachedUrls() {
  const sw = readFileSync(resolve(DIST, 'sw.js'), 'utf8')
  const matches = sw.match(/\[\{"revision":.*?\}\]/gs) ?? []
  if (matches.length !== 1) {
    fail(
      `dist/sw.js: expected exactly ONE injected precache manifest literal, found ${matches.length}. ` +
        'Either injectManifest did not run, or the bundle now contains a lookalike array and this ' +
        'extractor needs to be made more specific.',
    )
    return null
  }
  const entries = JSON.parse(matches[0])
  return entries.map((entry) => entry.url)
}

function checkPrecacheContents() {
  const precached = precachedUrls()
  if (precached === null) return

  // Scanned across the WHOLE dist tree, not just `assets/`. Scoping the disk side to the directory
  // the globs happen to name today would make the check agree with the globs by construction: move
  // the chunks elsewhere and both sides go quiet together, which is precisely the failure this
  // exists to catch.
  const onDisk = new Set([
    'index.html',
    ...emittedCodeFiles().filter((file) => !NOT_PRECACHABLE.some((pattern) => pattern.test(file))),
  ])
  const inManifest = new Set(precached)

  // THE LOAD-BEARING DIRECTION. Something the build emitted is not in the offline shell: either a
  // glob stopped matching where the bundler now writes, or a file was dropped for exceeding
  // `maximumFileSizeToCacheInBytes` (see the header for what that does and does not do today).
  const missing = [...onDisk].filter((url) => !inManifest.has(url))
  if (missing.length > 0) {
    fail(
      `emitted but NOT precached: ${missing.join(', ')}. The app shell is incomplete — it will ` +
        'white-screen offline. Either PRECACHE_GLOBS no longer covers where the bundler writes, ' +
        'or the file was dropped for exceeding maximumFileSizeToCacheInBytes ' +
        '(both in apps/web/src/pwa/pwa-options.ts). If it genuinely does not belong in the offline ' +
        'shell, add it to NOT_PRECACHABLE in this file, with the reason.',
    )
  }

  // THE OVER-PRECACHE DIRECTION. A hoster-editable file that lands in the precache is pinned to the
  // release that built it, and FR-DEP-04's rebrand-without-rebuild promise is quietly dead.
  const extra = [...inManifest].filter((url) => !onDisk.has(url))
  if (extra.length > 0) {
    fail(
      `precached but not an emitted asset: ${extra.join(', ')}. Only index.html and the ` +
        'content-addressed assets/** chunks may be precached (see NEVER_PRECACHE in sw-routes.ts).',
    )
  }

  // Redundant with the set difference above while NEVER_PRECACHE files sit at the dist root — and
  // kept anyway, because it is the FR-DEP-04 guarantee stated in its own terms. If a future layout
  // ever moves one of these under assets/, the set difference would go quiet and this would not.
  const hosterEditable = precached.filter(
    (url) => NEVER_PRECACHE.includes(url) || url.startsWith('branding/'),
  )
  if (hosterEditable.length > 0) {
    fail(
      `hoster-editable files are precached: ${hosterEditable.join(', ')}. They must be ` +
        'runtime-cached only (FR-DEP-04), or an edit to the deployed directory never lands.',
    )
  }
}

function checkBuiltIndexHtml() {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')

  // The mount contract. Stalwart rewrites this exact literal to the deployment's prefix; without it
  // a deep-link reload under `/mail/` resolves `./assets/*.js` against the ROUTE and 404s
  // (e2e/tests/mount.spec.ts drives that end to end).
  const baseTags = html.match(/<base\b/g) ?? []
  if (baseTags.length !== 1) {
    fail(`dist/index.html: expected exactly ONE <base> element, found ${baseTags.length}.`)
  }
  if (!html.includes('<base href="/" />')) {
    fail(
      'dist/index.html: the literal `<base href="/" />` did not survive the build. Stalwart ' +
        'rewrites that exact token to the mount prefix (FR-DEP-02); anything else is not rewritable.',
    )
  }

  // Asset relativity — what `base: './'` (vite.config.ts) buys, and the half no source test can
  // see, because these URLs are generated. A leading slash pins the bundle to the origin root.
  const absolute = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1])
  if (absolute.length > 0) {
    fail(
      `dist/index.html references assets ABSOLUTELY: ${absolute.join(', ')}. ` +
        "vite.config.ts must keep `base: './'` or the bundle cannot be served under a path prefix.",
    )
  }

  // The manifest link is written by hand (the plugin is configured `manifest: false`), and it is
  // relative for the same reason.
  if (!/<link[^>]+rel="manifest"[^>]+href="manifest\.json"/.test(html)) {
    fail(
      'dist/index.html: no <link rel="manifest" href="manifest.json">. The manifest ships as a ' +
        'hoster-editable deployment file and index.html links it relatively (pwa-options.ts).',
    )
  }
}

/**
 * The CSP contract for the SHIPPED document (NFR-SEC-01).
 *
 * Two kinds of entry, and the difference is the whole design:
 *
 *   * a directive with an EXACT value — the five whose weakening is the attack. `script-src` is
 *     the one that matters most: `'self' 'unsafe-inline'` still *contains* `'self'`, so a
 *     containment test would wave through precisely the change that reopens inline script. Exact
 *     match, whitespace-normalised, is what makes the assertion mean anything.
 *   * a directive that must merely be PRESENT (`value: null`) — those whose value is a deployment
 *     trade-off that legitimately moves. `img-src` gains schemes as remote content handling
 *     changes, `connect-src` cannot be pinned at build time at all (the JMAP origin comes from
 *     runtime config.json), `frame-src` follows what the mail renderer needs. Pinning their text
 *     here would make this file a second copy of the policy that has to be edited in lockstep —
 *     and the thing worth catching is a directive silently DISAPPEARING, which is what
 *     `default-src` fallback quietly does to `frame-src`.
 *
 * Deliberately not asserted: the order of directives, and the presence of anything not listed.
 * Adding a directive tightens the policy, and a gate that fires on tightening gets deleted.
 */
const REQUIRED_CSP = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'self'"],
  ['form-action', "'self'"],
  ['img-src', null],
  ['style-src', null],
  ['font-src', null],
  ['connect-src', null],
  ['frame-src', null],
]

/**
 * Why this lives here and not in `apps/web/src/pwa/index-html.test.ts`.
 *
 * That test reads the SOURCE `index.html?raw` and does assert `default-src 'self'` and
 * `base-uri 'self'` — the gap it leaves is the rest of the policy and the build. Vite rewrites
 * `index.html` on every build (script tags, asset URLs, whatever html-transform plugins are in the
 * chain); nothing in the repo has ever asserted that the meta element survived that intact. This is
 * the only place that reads the document an operator actually receives.
 *
 * It matters more than a normal build assertion because of what depends on it. SECURITY.md §1
 * claims a sanitizer miss cannot run JavaScript, and the reader's iframe is only the inner of the
 * three walls; `script-src 'self'` is the outer one. And on the Stalwart Application path —
 * the recommended deployment — this `<meta>` is the ENTIRE policy: Stalwart serves the zip's
 * contents with no hook for response headers, so there is no server-side CSP to fall back on, and
 * a header could not loosen it anyway (CSP3 enforces multiple policies independently).
 */
function checkBuiltCsp() {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')

  // `Content-Security-Policy-Report-Only` does not match: the closing quote sits immediately after
  // `Policy`. That is intended — a report-only policy enforces nothing and must not satisfy this.
  const metas = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? []
  if (metas.length !== 1) {
    fail(
      `dist/index.html: expected exactly ONE <meta http-equiv="Content-Security-Policy">, found ` +
        `${metas.length}. Zero means the policy did not survive the build (NFR-SEC-01, and on the ` +
        'Stalwart Application path there is no response header to fall back on). More than one ' +
        'means two policies are enforced as an intersection, which nobody reading either can predict.',
    )
    return
  }

  const content = /content=(?:"([^"]*)"|'([^']*)')/i.exec(metas[0])
  if (content === null) {
    fail('dist/index.html: the Content-Security-Policy meta element has no content attribute.')
    return
  }

  // Whitespace-normalised, so a reformatted policy is not a failure and `script-src  'self'` is
  // not a pass for something else.
  const directives = new Map(
    (content[1] ?? content[2])
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name !== '')
      .map(([name, ...values]) => [name.toLowerCase(), values.join(' ')]),
  )

  for (const [name, expected] of REQUIRED_CSP) {
    if (!directives.has(name)) {
      fail(
        `dist/index.html CSP: no \`${name}\` directive. Missing fetch directives fall back to ` +
          '`default-src`, so this can look harmless while a whole resource class silently changes ' +
          'policy — and for the non-fetch directives it means no policy at all.',
      )
      continue
    }
    if (expected !== null && directives.get(name) !== expected) {
      fail(
        `dist/index.html CSP: \`${name}\` is \`${directives.get(name)}\`, must be exactly ` +
          `\`${expected}\`. These five are not tuning knobs — see REQUIRED_CSP in this file. If ` +
          'this is a deliberate change it needs an owner decision and an NFR-SEC-01 review, and ' +
          'SECURITY.md §1 has to be corrected in the same commit.',
      )
    }
  }
}

/**
 * The service worker carries NO credentials and NO JMAP client (M4.0, ADR-017, decision D6a).
 *
 * This is the security property the whole contentless design was chosen for, and it is exactly the
 * kind of property that erodes by accident. Nothing in the source gates can see it: the worker's own
 * `tsconfig.sw.json` would happily compile an import of the auth layer, `pnpm test` never builds a
 * bundle, and a reviewer reading a diff sees one new import, not what it drags in. Only the shipped
 * file answers "is the token in there".
 *
 * Why it will be attacked: **B28** wants sender and subject on the closed-app banner, and the only
 * way to get them is an authenticated `Email/get` from the worker — the access token, the AES-GCM
 * `SecretStore` and the OAuth refresh path all cross the line. That is a legitimate thing to want and
 * a separate owner decision with its own NFR-SEC-02/NFR-SEC-04 review. This check is what makes it a
 * DECISION rather than a side effect: whoever adds the import has to delete these lines and say why.
 *
 * The needles are symbols that survive minification — string literals and stable identifiers — not
 * local names a bundler renames. A miss is possible; a false alarm is not, which is the right way
 * round for a gate that blocks the build.
 */
const SW_MUST_NOT_CONTAIN = [
  ['SecretStore', 'the AES-GCM secret store (NFR-SEC-02)'],
  ['oauth.refreshToken', 'the persisted refresh-token key'],
  ['waxwing-auth', 'the auth IndexedDB database'],
  ['Authorization', 'an authenticated request header'],
  ['Email/get', 'a JMAP mail call'],
  ['Email/query', 'a JMAP mail call'],
  ['Dexie', 'the replica ORM — the worker reads its own raw-IDB store instead'],
]

/** And the things that MUST be there, so a silently gutted push path fails too. */
const SW_MUST_CONTAIN = [
  ['EmailDelivery', 'the frame filter that makes a contentless banner meaningful'],
  ['waxwing-push', 'the page → worker handover store'],
  ['showNotification', 'the banner itself'],
]

function checkServiceWorkerHasNoCredentials() {
  let sw
  try {
    sw = readFileSync(resolve(DIST, 'sw.js'), 'utf8')
  } catch {
    fail('dist/sw.js is missing — the PWA build did not run.')
    return
  }

  for (const [needle, what] of SW_MUST_NOT_CONTAIN) {
    if (sw.includes(needle)) {
      fail(
        `dist/sw.js contains "${needle}" (${what}). The service worker must carry no credentials ` +
          'and make no JMAP call — see ADR-017. If this is deliberate (B28: sender and subject on ' +
          'the closed-app banner), it needs an owner decision and an NFR-SEC-02/NFR-SEC-04 review, ' +
          'and this check has to be amended in the same change.',
      )
    }
  }

  for (const [needle, what] of SW_MUST_CONTAIN) {
    if (!sw.includes(needle)) {
      fail(`dist/sw.js no longer contains "${needle}" (${what}). Web Push is silently disabled.`)
    }
  }
}

checkPrecacheContents()
checkBuiltIndexHtml()
checkBuiltCsp()
checkServiceWorkerHasNoCredentials()

if (failures.length > 0) {
  console.error('\n[check:dist] FAILED — the built app-shell contract is broken:\n')
  for (const failure of failures) console.error(`  • ${failure}\n`)
  process.exit(1)
}

console.log(
  '[check:dist] OK — precache set, built index.html and its CSP all match the shipping contract',
)

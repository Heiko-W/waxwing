#!/usr/bin/env node
// Waxwing release artefacts (M4.9, FR-DEP-01/02).
//
// Builds `apps/web` and packs the result two ways, because the two supported deployments want
// different shapes:
//
//   waxwing-web-vX.Y.Z.tar.gz       every static file, for a web server / CDN / reverse proxy
//   waxwing-stalwart-vX.Y.Z.zip     the same files with `index.html` AT THE ZIP ROOT, which is
//                                   what Stalwart's Applications registry requires (SP.5)
//
// …plus `SHA256SUMS`, so a deployer can check what they downloaded is what was published
// (NFR-SEC-03 documents the stronger, per-file SRI story for hosts where files could diverge).
//
// ── WHY THIS IS A SCRIPT AND NOT A GITHUB WORKFLOW ────────────────────────────────────────────
//
// Same reasoning as ADR-003 and `scripts/ci.mjs`: the artefacts have to be buildable and checkable
// locally BEFORE a hosted runner is involved, or the first time anyone finds out the zip is shaped
// wrong is when a tag has already been pushed. A tag-triggered workflow calls this script; it does
// not reimplement it.
//
// ── WHY `archiver` AND NOT `tar`/`zip` ────────────────────────────────────────────────────────
//
// `zip` is not installed on this machine, and that is the useful version of the problem: a release
// script that shells out to system binaries produces artefacts whose shape depends on which build
// of `zip`/`tar` the machine happens to carry, and fails outright where one is missing (a minimal
// CI image, Windows). `archiver` writes both formats from Node, so the same bytes come out
// everywhere. It is a devDependency and reaches no shipped bundle.
//
// Usage:
//   node scripts/release.mjs            build into dist-release/
//   node scripts/release.mjs --check    …and verify the artefacts (extension, layout, size cap)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// archiver 8 replaced the `archiver(format, opts)` factory with one class PER FORMAT, each of which
// extends the base `Archiver` — so `ZipArchive` IS the archiver, not something you hand to one.
// Written out because three plausible readings of this package's API are wrong and each fails
// differently: no default export, `archiver is not a function`, and then
// `self._module.on is not a function` from wrapping one class in the other.
const { TarArchive, ZipArchive } = createRequire(import.meta.url)('archiver')

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'apps/web/dist')
const OUT = join(ROOT, 'dist-release')

/** Stalwart refuses an Application bundle larger than this (SP.5, measured against v0.16.x). */
const STALWART_MAX_BYTES = 100 * 1024 * 1024

const bold = (text) => `[1m${text}[0m`
const log = (message) => console.log(bold(`[release] ${message}`))

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
}

/** The version every artefact is named after — `package.json`, the one file a tag should match. */
function version() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no version to name the artefacts after')
  }
  return pkg.version
}

/** Every file under `dir`, relative to it, sorted — so an archive is byte-stable across machines. */
function filesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Write `files` (paths relative to `DIST`) into `target`, in the given order.
 *
 * Entries are added one at a time rather than with `archive.directory()`: the caller's list is
 * sorted, and a deterministic order is what makes two builds of the same tree produce comparable
 * archives. `zlib.level: 9` because these ship once and are downloaded many times.
 */
function pack(format, target, files) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(target)
    const archive =
      format === 'tar'
        ? new TarArchive({ gzip: true, gzipOptions: { level: 9 } })
        : new ZipArchive({ zlib: { level: 9 } })
    output.on('close', resolvePromise)
    archive.on('warning', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const file of files) archive.file(join(DIST, file), { name: file })
    archive.finalize()
  })
}

/**
 * The checks that would otherwise be discovered by a deployer.
 *
 * Every one of these is a failure mode SP.5 or M3.5 actually hit, which is why they are assertions
 * rather than a README paragraph:
 */
function check(paths) {
  const problems = []

  // 1. Stalwart fetches `resourceUrl` and keys off the `.zip` extension — a `.tgz` is refused.
  if (!paths.stalwart.endsWith('.zip')) problems.push('the Stalwart bundle must end in .zip')

  // 2. `index.html` must sit at the ZIP ROOT. Stalwart serves the archive as-is; one nested
  //    directory and every path is off by a segment. Read back from the WRITTEN file rather than
  //    from the list that produced it — the point is what a deployer will actually receive.
  const listing = execFileSync('unzip', ['-Z1', paths.stalwart], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  if (!listing.includes('index.html')) {
    problems.push(`index.html is not at the zip root (found: ${listing.slice(0, 5).join(', ')}…)`)
  }

  // 3. The size cap, measured against v0.16.x.
  const bytes = statSync(paths.stalwart).size
  if (bytes > STALWART_MAX_BYTES) {
    problems.push(`the bundle is ${bytes} bytes, over Stalwart's ${STALWART_MAX_BYTES} cap`)
  }

  // 4. The `<base href="/">` token Stalwart rewrites to `<base href="/{prefix}/">`. Without that
  //    EXACT token (double quotes, root path) a deep-link reload under /mail/… resolves its
  //    relative `./assets/*` against the route path and the app fails to load. `check-dist-contract`
  //    asserts this on `dist/`; it is re-asserted here because the archive is what ships.
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  if (!html.includes('<base href="/"')) {
    problems.push('the built index.html has lost its <base href="/"> token (SP.5)')
  }

  // 5. The PWA manifest ships as `.json`, not `.webmanifest`: Stalwart serves the latter as
  //    application/octet-stream, which browsers refuse (FR-DEP-06).
  if (!listing.includes('manifest.json')) {
    problems.push('manifest.json is missing from the bundle (FR-DEP-06)')
  }
  if (listing.some((name) => name.endsWith('.webmanifest'))) {
    problems.push('a .webmanifest is present — Stalwart serves it as octet-stream (FR-DEP-06)')
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✖ ${problem}`)
    throw new Error(`${problems.length} artefact problem(s)`)
  }
  log(`checked: ${listing.length} files, ${(bytes / 1024).toFixed(0)} KB zip`)
}

async function main() {
  const wantsCheck = process.argv.includes('--check')
  const v = version()

  log(`building apps/web for v${v}`)
  run('pnpm', ['--filter', '@waxwing/web', 'exec', 'vite', 'build'])

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const files = filesUnder(DIST)
  if (files.length === 0) throw new Error('apps/web/dist is empty — the build produced nothing')

  const paths = {
    web: join(OUT, `waxwing-web-v${v}.tar.gz`),
    stalwart: join(OUT, `waxwing-stalwart-v${v}.zip`),
  }

  // No leading directory in EITHER archive: a deployer untars into a docroot, and Stalwart needs
  // `index.html` at the zip root.
  log(`packing ${files.length} files → ${relative(ROOT, paths.web)}`)
  await pack('tar', paths.web, files)

  log(`packing → ${relative(ROOT, paths.stalwart)}`)
  await pack('zip', paths.stalwart, files)

  const sums = Object.values(paths)
    .map((path) => `${sha256(path)}  ${relative(OUT, path)}`)
    .join('\n')
  writeFileSync(join(OUT, 'SHA256SUMS'), `${sums}\n`)
  log('wrote SHA256SUMS')

  if (wantsCheck) check(paths)
  log(`done — artefacts in ${relative(ROOT, OUT)}/`)
}

await main()

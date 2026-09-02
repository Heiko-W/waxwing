#!/usr/bin/env node
// Waxwing release artefacts (M4.9, FR-DEP-01/02).
//
// Builds `apps/web` and packs the result two ways, because the two supported deployments want
// different shapes:
//
//   waxwing-web-vX.Y.Z.tar.gz       every static file, for a web server / CDN / reverse proxy
//   waxwing-stalwart-vX.Y.Z.zip     the same files with `index.html` AT THE ZIP ROOT, which is
//                                   what Stalwart's Applications registry requires (SP.5)
//   waxwing-stalwart.zip            THE SAME BYTES under a name that never changes — this is
//                                   what makes auto-update work (see below)
//
// ── WHY AN UNVERSIONED COPY ───────────────────────────────────────────────────────────────────
//
// Stalwart re-fetches an Application's `resourceUrl` on `autoUpdateFrequency`. Point that URL at
// GitHub's `releases/latest/download/<asset>` and a deployment updates itself: publish a release,
// and every Stalwart running Waxwing picks it up on its next cycle with nobody touching anything.
//
// That only works if the asset NAME is stable. `…/latest/download/waxwing-stalwart-v0.9.0.zip`
// resolves today and 404s the moment v0.9.1 ships — the deployment then silently stops updating,
// which is worse than never having offered it. So the release carries both: the versioned name for
// people who pin, and `waxwing-stalwart.zip` for people who want it to keep itself current. It is
// exactly what Stalwart does for its own WebUI
// (`https://github.com/stalwartlabs/webui/releases/latest/download/webui.zip`).
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
// That argument was true of the WRITING and false of the CHECKING for six releases: `--check`
// listed the zip with a system `unzip`, so `pnpm release` — the command `deployment.md` tells a
// deployer to run — died with `ENOENT` on exactly the machines this paragraph is about. It reads
// the zip's central directory in Node now (`zipEntries`), and nothing here shells out to anything
// but pnpm.
//
// Usage:
//   node scripts/release.mjs            build into dist-release/
//   node scripts/release.mjs --check    …and verify the artefacts (extension, layout, size cap)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
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

/** The timestamp every archive entry carries — see {@link pack}. */
const EPOCH = new Date(0)

/** Stalwart refuses an Application bundle larger than this (SP.5, measured against v0.16.x). */
const STALWART_MAX_BYTES = 100 * 1024 * 1024

const bold = (text) => `[1m${text}[0m`
const log = (message) => console.log(bold(`[release] ${message}`))

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
}

/** Every workspace manifest, in the order a bump should visit them. */
const MANIFESTS = [
  'package.json',
  'apps/web/package.json',
  'e2e/package.json',
  'packages/jmap/package.json',
  'packages/jscontact/package.json',
  'packages/mail-html/package.json',
]

/**
 * The version every artefact is named after — `package.json`, the one file a tag should match.
 *
 * It also checks that the WHOLE workspace agrees, because the bump is manual and had already lost
 * one: `@waxwing/mail-html` sat on 0.16.0 through six releases. Lockstep is the intent (every
 * package is `private: true` and none is published), and one of these manifests is not decoration —
 * `apps/web/package.json` is where `__WAXWING_VERSION__` comes from, so a release that forgets it
 * ships `waxwing-web-v0.23.0.tar.gz` whose About screen says 0.22.0, and the first question of
 * every support exchange gets a wrong answer.
 */
function version() {
  const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
  const pkg = read('package.json')
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no version to name the artefacts after')
  }
  const behind = MANIFESTS.slice(1)
    .map((file) => [file, read(file).version])
    .filter(([, found]) => found !== pkg.version)
  if (behind.length > 0) {
    for (const [file, found] of behind)
      console.error(`  ✖ ${file} is ${found}, root is ${pkg.version}`)
    throw new Error(
      `${behind.length} workspace manifest(s) out of step with the root version — ` +
        'every package is private and released in lockstep; bump them together.',
    )
  }
  return pkg.version
}

/**
 * Every file under `dir`, relative to it, sorted — the first half of a byte-stable archive.
 *
 * Sorted by CODE UNIT, not `localeCompare`. Collation depends on the machine's locale and on which
 * ICU the Node build carries, so `localeCompare` would have put the entries in one order here and
 * possibly another on a deployer's machine — which is the one thing this function exists to rule
 * out. It is also not what a reader of `SHA256SUMS` would guess the order is.
 */
function filesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
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
 * sorted, and a deterministic ORDER is the first half of what makes two builds of the same content
 * produce identical archives. `zlib.level: 9` because these ship once and are downloaded many times.
 *
 * `date: new Date(0)` is the second half, and it is not cosmetic. `archive.file()` otherwise copies
 * each file's mtime into the entry header — in BOTH formats, not just zip — so two builds of the
 * same bytes on the same machine differ, and a deployer who follows `deployment.md` ("build them
 * yourself") can never match the published checksum. Measured with archiver 8.0.0: same mtime →
 * identical; mtime + 120 s → zip AND tar differ; with this option → identical either way. A fixed
 * epoch is the usual answer (SOURCE_DATE_EPOCH); what the archives lose is a timestamp that says
 * when this particular build ran, which nothing here or in the deployment reads.
 *
 * `statConcurrency: 1` is the third half, and it is the one nobody would guess. `archive.file()`
 * does not append in call order: archiver stats each path on a queue whose default concurrency is
 * FOUR (`lib/core.js`), and appends whichever stat returns first. Two builds of the same 81 files
 * therefore came out with the first few entries permuted — measured here, byte 27 of the zip, i.e.
 * the first entry's name length. Sorting the input list is necessary and was never sufficient.
 *
 * `gzipOptions.mtime: 0` on the tar: a gzip member header carries a timestamp of its own, quite
 * apart from the tar entries inside it.
 *
 * The claim is "identical for identical CONTENT", not "identical everywhere": a different Node or
 * zlib build can still compress differently. That is why `SHA256SUMS` ships with the release rather
 * than being something a deployer is expected to reproduce blind.
 */
function pack(format, target, files) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(target)
    const archive =
      format === 'tar'
        ? new TarArchive({
            gzip: true,
            gzipOptions: { level: 9, mtime: 0 },
            statConcurrency: 1,
          })
        : new ZipArchive({ zlib: { level: 9 }, statConcurrency: 1 })
    output.on('close', resolvePromise)
    archive.on('warning', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const file of files) archive.file(join(DIST, file), { name: file, date: EPOCH })
    archive.finalize()
  })
}

/**
 * The names in a ZIP's central directory, read back from the WRITTEN file with no system `unzip`.
 *
 * This used to be `execFileSync('unzip', ['-Z1', …])`, which contradicted the header of this file
 * forty lines up: the whole reason for `archiver` is that a release script must not depend on which
 * binaries a machine happens to carry. On Windows or a minimal CI image `pnpm release` died with
 * `ENOENT` at the check step, after building everything.
 *
 * Reading it here rather than reusing the list that produced the archive is deliberate and is the
 * original reason for the shell-out: the point of the check is what a deployer actually receives.
 * The format is fixed (APPNOTE 6.3.x §4.3.12/16) and these archives are small and few, so no zip64
 * end-of-central-directory locator can appear; if one ever does, the count reads 0xffff and this
 * throws rather than reporting a short listing.
 */
function zipEntries(path) {
  const buffer = readFileSync(path)
  const EOCD_SIGNATURE = 0x06054b50
  const ENTRY_SIGNATURE = 0x02014b50
  let eocd = -1
  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at
      break
    }
  }
  if (eocd === -1) throw new Error(`${path}: no ZIP end-of-central-directory record`)
  const count = buffer.readUInt16LE(eocd + 10)
  if (count === 0xffff) throw new Error(`${path}: zip64 central directory, which this cannot read`)
  let at = buffer.readUInt32LE(eocd + 16)
  const names = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== ENTRY_SIGNATURE) {
      throw new Error(`${path}: central-directory entry ${index} has a bad signature`)
    }
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
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
  const listing = zipEntries(paths.stalwart)
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
  //    relative `./assets/*` against the route path and the app fails to load. Read from `dist/`,
  //    which is what the two archives were packed from moments ago — the entry NAMES above come
  //    from the written zip, this one does not, and this comment used to imply otherwise.
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
  // `build`, not `exec vite build`: that script builds the workspace libraries first. The app
  // imports `@waxwing/jmap` and its siblings through their `exports` → `dist/index.js`, which do
  // not exist in a clean checkout — so a bare `vite build` fails to resolve them. This bit twice
  // (once in `verify-e2e.mjs`, once here) before the dependency moved into the script that owns it.
  run('pnpm', ['--filter', '@waxwing/web', 'build'])

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const files = filesUnder(DIST)
  if (files.length === 0) throw new Error('apps/web/dist is empty — the build produced nothing')

  const paths = {
    web: join(OUT, `waxwing-web-v${v}.tar.gz`),
    stalwart: join(OUT, `waxwing-stalwart-v${v}.zip`),
    /** The stable name `releases/latest/download/…` can point at — see the header. */
    stalwartLatest: join(OUT, 'waxwing-stalwart.zip'),
  }

  // No leading directory in EITHER archive: a deployer untars into a docroot, and Stalwart needs
  // `index.html` at the zip root.
  log(`packing ${files.length} files → ${relative(ROOT, paths.web)}`)
  await pack('tar', paths.web, files)

  log(`packing → ${relative(ROOT, paths.stalwart)}`)
  await pack('zip', paths.stalwart, files)

  // A byte-for-byte copy, not a second pack: the two must have the same checksum, or a deployer
  // who verifies the versioned asset has verified nothing about the one their server actually
  // fetches.
  copyFileSync(paths.stalwart, paths.stalwartLatest)
  log(`copied → ${relative(ROOT, paths.stalwartLatest)} (the auto-update name)`)

  const sums = Object.values(paths)
    .map((path) => `${sha256(path)}  ${relative(OUT, path)}`)
    .join('\n')
  // Both zips must hash identically — see the copy above.
  if (sha256(paths.stalwart) !== sha256(paths.stalwartLatest)) {
    throw new Error('the versioned and unversioned zips differ — the copy did not happen')
  }
  writeFileSync(join(OUT, 'SHA256SUMS'), `${sums}\n`)
  log('wrote SHA256SUMS')

  if (wantsCheck) check(paths)
  log(`done — artefacts in ${relative(ROOT, OUT)}/`)
}

await main()

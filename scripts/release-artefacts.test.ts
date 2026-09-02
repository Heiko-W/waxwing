/**
 * `scripts/release.mjs` and the version strings a release has to move (R-103, R-105).
 *
 * ## R-103 — the bump is manual and had already lost a manifest
 * Every package here is `private: true` and none is published, so lockstep is the intent and the
 * version is one number. The bump is a checklist, though, and `@waxwing/mail-html` sat on 0.16.0
 * through six releases while eight documentation strings still named v0.15.0. One of those
 * manifests is not decoration: `apps/web/package.json` is where `__WAXWING_VERSION__` comes from,
 * so forgetting it ships an artefact whose About screen names the previous release — and "which
 * version?" is the first question of every support exchange.
 *
 * ## R-105 — a release script that depended on a system binary, and archives nobody could compare
 * `--check` listed the zip with `unzip`, which contradicted the file's own reasoning for using
 * `archiver` at all and made `pnpm release` — the command `deployment.md` hands a deployer — die
 * with `ENOENT` on Windows or a minimal image. And both archives carried each file's mtime, so two
 * builds of identical bytes never had identical checksums.
 *
 * The determinism half is checked twice: once as the three settings in the source, and once as a
 * live pack of a temporary directory, so a dependency bump that stops honouring one of them fails
 * here rather than in a release.
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string) => readFileSync(join(ROOT, relativePath), 'utf8')

const RELEASE = read('scripts/release.mjs')

/**
 * `release.mjs` without its comment LINES. The prose in that file names the binary it used to
 * spawn, in the paragraph explaining why it no longer does, so a check over the raw text would
 * fail on its own documentation. Dropping whole comment lines rather than matching `/* … *\/`
 * pairs, because the prose also contains both delimiters inside code spans (`./assets/*`).
 */
const RELEASE_CODE = RELEASE.split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
  .join('\n')
const VERSION = (JSON.parse(read('package.json')) as { version: string }).version

/** Every workspace manifest — the same list `release.mjs` refuses to release without. */
const MANIFESTS = [
  'apps/web/package.json',
  'e2e/package.json',
  'packages/jmap/package.json',
  'packages/jscontact/package.json',
  'packages/mail-html/package.json',
] as const

/**
 * Documentation strings that name the CURRENT release, by the shape that makes them
 * release-coupled: a tag to verify against, a versioned asset to download, the site's status line.
 * Prose about earlier releases (the README changelog, "It starts with v0.10.0") does not match any
 * of these and is left alone, which is what the old CONTRIBUTING note asked for by hand.
 */
const VERSIONED_DOCS = ['README.md', 'SECURITY.md', 'docs/deployment.md', 'docs/site/index.html']
const VERSION_PATTERNS = [
  /refs\/tags\/v(\d+\.\d+\.\d+)/g,
  /waxwing-stalwart-v(\d+\.\d+\.\d+)\.zip/g,
  /waxwing-web-v(\d+\.\d+\.\d+)\.tar\.gz/g,
  /Status: v(\d+\.\d+\.\d+)/g,
]

describe('the release version', () => {
  it.each(MANIFESTS)('%s is in lockstep with the root', (manifest) => {
    expect((JSON.parse(read(manifest)) as { version: string }).version).toBe(VERSION)
  })

  it.each(VERSIONED_DOCS)('%s names no other release', (doc) => {
    const text = read(doc)
    const found = VERSION_PATTERNS.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => match[0] as string),
    )
    // The check goes vacuous the day a doc stops naming the version at all, so require some.
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((one) => !one.includes(`v${VERSION}`))).toEqual([])
  })

  it('makes `pnpm release` refuse a workspace that has drifted', () => {
    expect(RELEASE).toContain('out of step with the root version')
  })
})

describe('the release script', () => {
  /**
   * `archiver` exists here so that the artefacts do not depend on which `zip`/`tar` a machine
   * carries. Anything spawned other than the package manager takes that back.
   */
  it('spawns nothing but pnpm', () => {
    const spawned = [...RELEASE_CODE.matchAll(/\b(?:execFileSync|run)\(\s*'([\w.-]+)'/g)].map(
      (match) => match[1] as string,
    )
    expect([...new Set(spawned)].sort()).toEqual(['pnpm'])
  })

  it('reads the shipped zip back rather than trusting the list that produced it', () => {
    expect(RELEASE).toMatch(/function zipEntries\(/)
    expect(RELEASE).toContain('zipEntries(paths.stalwart)')
  })

  it.each([
    ['a fixed entry date', 'date: EPOCH'],
    ['a serial stat queue', 'statConcurrency: 1'],
    ['a fixed gzip timestamp', 'mtime: 0'],
  ])('packs with %s', (_what, setting) => {
    expect(RELEASE).toContain(setting)
  })

  /**
   * The fourth setting, and the only one that is about a machine OTHER than this one:
   * `localeCompare` collates by the host's locale and ICU build, so it can order the entries
   * differently on a deployer's machine than on the release runner's.
   */
  it('orders the entries by code unit, not by locale', () => {
    expect(RELEASE_CODE).not.toContain('localeCompare')
  })
})

/**
 * The same three settings, exercised. Sorting the file list was believed to be enough for six
 * releases and never was: archiver stats on a queue four wide and appends in completion order, so
 * the first entries came out permuted between runs of the same build.
 */
describe('those settings actually make archiver deterministic', () => {
  const { TarArchive, ZipArchive } = createRequire(join(ROOT, 'scripts/release.mjs'))(
    'archiver',
  ) as {
    TarArchive: new (options: unknown) => Archive
    ZipArchive: new (options: unknown) => Archive
  }
  interface Archive {
    pipe(destination: unknown): void
    on(event: string, listener: (error: unknown) => void): void
    file(path: string, data: { name: string; date: Date }): void
    finalize(): void
  }

  const work = mkdtempSync(join(tmpdir(), 'waxwing-pack-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  // Enough files to cross archiver's default stat concurrency of four, with names whose sorted
  // order is not their `readdir` order.
  const NAMES = ['zebra.js', 'alpha.js', 'Mike.js', 'bravo.js', 'India.js', 'charlie.js']
  for (const name of NAMES) writeFileSync(join(work, name), `// ${name}\n`.repeat(200))
  const FILES = [...NAMES].sort()

  function pack(format: 'tar' | 'zip', target: string): Promise<void> {
    return new Promise((done, fail) => {
      const output = createWriteStream(target)
      const archive =
        format === 'tar'
          ? new TarArchive({ gzip: true, gzipOptions: { level: 9, mtime: 0 }, statConcurrency: 1 })
          : new ZipArchive({ zlib: { level: 9 }, statConcurrency: 1 })
      output.on('close', () => done())
      archive.on('warning', fail)
      archive.on('error', fail)
      archive.pipe(output)
      for (const name of FILES) archive.file(join(work, name), { name, date: new Date(0) })
      archive.finalize()
    })
  }

  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

  it.each([
    'zip',
    'tar',
  ] as const)('produces the same %s bytes from the same content at a different mtime', async (format) => {
    await pack(format, join(work, `first.${format}`))
    const later = new Date(Date.now() + 120_000)
    for (const name of FILES) utimesSync(join(work, name), later, later)
    await pack(format, join(work, `second.${format}`))
    expect(digest(join(work, `first.${format}`))).toBe(digest(join(work, `second.${format}`)))
  })
})

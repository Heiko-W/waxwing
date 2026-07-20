import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Test-only file collector for the static CSS checks (`*.css.test.ts`, B5).
 *
 * CSS is the one layer nothing else in this repo verifies: custom properties are not
 * typechecked, Biome has no cross-file `var()` resolution, and jsdom computes no styles —
 * so a token that is referenced but never defined, or a focus outline suppressed with no
 * replacement, ships silently. Both checks are plain Node file walks over the shipped
 * sources, which is why they run in the root "unit" project (see ../../../vitest.config.ts).
 *
 * Not a shipped module: nothing under src/ imports it, so it never reaches the bundle. It
 * sits next to `contrast.ts`, which is test-only for the same reason.
 */

/** `apps/web/` — the walk root, so `public/theme.css` and `index.html` are reachable too. */
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Directories a source walk must never descend into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.vite'])

/** One source file, with its path already relative to `apps/web/` for readable failures. */
export interface SourceFile {
  /** e.g. `src/mail/labels/labels.module.css` — what a failure message should print. */
  readonly path: string
  readonly text: string
}

function walk(dir: string, prefix: string, extensions: readonly string[], out: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), rel, extensions, out)
      continue
    }
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
    out.push({ path: rel, text: readFileSync(join(dir, entry.name), 'utf8') })
  }
}

/**
 * Every file under `apps/web/<subdir>` whose name ends in one of `extensions`, sorted so
 * failure output is stable across machines (readdir order is not).
 */
export function collectSources(subdir: string, extensions: readonly string[]): SourceFile[] {
  const out: SourceFile[] = []
  walk(join(APP_ROOT, subdir), subdir, extensions, out)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** A single file under `apps/web/`, e.g. `index.html`. */
export function readAppFile(relativePath: string): SourceFile {
  return { path: relativePath, text: readFileSync(join(APP_ROOT, relativePath), 'utf8') }
}

/** 1-based line number of a character offset — failure messages must be clickable. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

#!/usr/bin/env node
// Waxwing — every local reference in the project site resolves inside the published directory.
//
// `.github/workflows/pages.yml` uploads `docs/site/` and NOTHING else. So a reference that points
// above it — `../screenshots/reading.png`, `../../assets/logo/…` — works in a local preview, works
// in the GitHub file viewer, and 404s on the deployed site. docs/site/README.md has warned about
// this in prose since the site was written; this is the same rule, checked.
//
// It is hermetic (reads files, no network), so it belongs in `pnpm verify` rather than beside the
// network-bound action-tree check.
//
// Deliberately NOT a regex for "valid HTML" — it extracts src/href/srcset values and asks one
// question of each: if this is a local path, is the file there?

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SITE = fileURLToPath(new URL('../docs/site/', import.meta.url))
const PAGE = `${SITE}index.html`

const html = readFileSync(PAGE, 'utf8')

/** src="…", href="…" and every candidate inside a srcset="…". */
function references(source) {
  const out = new Set()
  for (const [, value] of source.matchAll(/(?:src|href)="([^"]+)"/g)) out.add(value)
  for (const [, value] of source.matchAll(/srcset="([^"]+)"/g)) {
    // A srcset is a comma-separated list of "url descriptor" pairs.
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s+/)[0]
      if (url) out.add(url)
    }
  }
  return [...out]
}

const problems = []
for (const reference of references(html)) {
  // Off-site, in-page and data: references are not this check's business.
  if (/^(https?:)?\/\//.test(reference)) continue
  if (reference.startsWith('#') || reference.startsWith('data:') || reference.startsWith('mailto:')) continue

  if (reference.startsWith('/') || reference.startsWith('../')) {
    problems.push(
      `${reference} — escapes docs/site/, so it 404s once deployed (Pages publishes that directory only)`,
    )
    continue
  }
  const path = `${SITE}${reference.split(/[?#]/)[0]}`
  if (!existsSync(path)) problems.push(`${reference} — no such file in docs/site/`)
}

if (problems.length > 0) {
  console.error(
    '\n[ci] THE PROJECT SITE REFERENCES SOMETHING IT DOES NOT SHIP:\n\n' +
      `${problems.map((problem) => `    ${problem}`).join('\n')}\n\n` +
      '  GitHub Pages uploads docs/site/ and nothing else. A path outside it renders correctly in a\n' +
      '  local preview and in the GitHub file viewer, and is a broken image on the live site.\n',
  )
  process.exit(1)
}

const count = references(html).filter((r) => !/^(https?:)?\/\/|^#|^data:|^mailto:/.test(r)).length
console.log(`  ${count} local references in the project site all resolve`)

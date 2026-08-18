#!/usr/bin/env node
// Waxwing — turn the captured PNGs into the WebP files the project site ships.
//
// `pnpm shots` runs the Playwright capture (e2e/playwright.shots.config.ts) and then this. The
// split is deliberate: capture needs a mail server, a browser and three minutes; this needs
// neither and can be re-run alone after a quality tweak.
//
// ── WHY WEBP, AND WHY IT IS THE ONLY THING COMMITTED ─────────────────────────────────────────
//
// The PNGs are 2.4 MB for nine images. The site is a single hand-written page with no build step
// and no image pipeline (see .github/workflows/pages.yml), so whatever lands in docs/site/ is
// exactly what a visitor downloads. WebP at q=80 is ~10% of that with no visible difference on
// UI screenshots, which are flat colour and text — the case WebP handles best.
//
// The PNGs stay in e2e/shots/out/ (gitignored). Committing both would mean two copies of the same
// picture, drifting the moment someone re-runs half of this.
//
// ── WHY docs/site/shots/ AND NOT docs/screenshots/ ───────────────────────────────────────────
//
// The Pages workflow publishes `docs/site` and nothing else. A screenshot anywhere above it is a
// 404 on the live site while looking perfectly fine on GitHub — which is exactly the kind of
// difference nobody checks. One directory, under the published root, referenced by both the site
// and the README.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const IN = fileURLToPath(new URL('../e2e/shots/out/', import.meta.url))
const OUT = fileURLToPath(new URL('../docs/site/shots/', import.meta.url))

/**
 * Target widths, in real pixels, for images the page renders at roughly half these.
 * Desktop shots are captured at 2880 (1440 @2×) and phones at 1170 (390 @3×).
 */
const WIDTH = { desktop: 1472, phone: 585 }
const QUALITY = 80

function cwebpAvailable() {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!cwebpAvailable()) {
  // Fails loudly rather than skipping: a silent skip here leaves the site showing the PREVIOUS
  // screenshots while the run reports success, which is the defect class this repo calls B22.
  console.error(
    '\n[shots] cwebp not found — cannot convert.\n\n' +
      '  Install it:  sudo apt install webp   (Debian/Ubuntu)\n' +
      '               brew install webp       (macOS)\n\n' +
      '  The PNGs are in e2e/shots/out/ and are still valid; only the conversion is missing.\n',
  )
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const pngs = readdirSync(IN).filter((name) => name.endsWith('.png'))
if (pngs.length === 0) {
  console.error('\n[shots] no PNGs in e2e/shots/out/ — run the capture first (`pnpm shots`).\n')
  process.exit(1)
}

let before = 0
let after = 0
for (const png of pngs.sort()) {
  const width = png.startsWith('phone-') ? WIDTH.phone : WIDTH.desktop
  const webp = png.replace(/\.png$/, '.webp')
  execFileSync('cwebp', [
    '-quiet',
    '-q',
    String(QUALITY),
    // Sharper text at a given quality: chroma is computed in linear light rather than from
    // gamma-encoded samples. Screenshots are mostly type, so this is the setting that matters.
    '-sharp_yuv',
    '-resize',
    String(width),
    '0',
    `${IN}${png}`,
    '-o',
    `${OUT}${webp}`,
  ])
  const from = statSync(`${IN}${png}`).size
  const to = statSync(`${OUT}${webp}`).size
  before += from
  after += to
  console.log(
    `  ${webp.padEnd(24)} ${String(width).padStart(5)}px  ${(to / 1024).toFixed(0).padStart(4)} kB` +
      `  (from ${(from / 1024).toFixed(0)} kB)`,
  )
}

console.log(
  `\n  ${pngs.length} images — ${(before / 1024 / 1024).toFixed(1)} MB PNG ` +
    `→ ${(after / 1024).toFixed(0)} kB WebP\n`,
)

#!/usr/bin/env node
/**
 * Render the PWA raster icons from the SVG sources (M3.5, FR-DEP-06).
 *
 * The manifest needs PNGs: Android/Chromium ignore SVG icons for the home screen and the
 * splash, and iOS ignores the manifest entirely and reads `<link rel="apple-touch-icon">`.
 * The rendered files are COMMITTED (they are release assets, and a hoster may replace them
 * to rebrand without a rebuild — see apps/web/public/branding/), so this script is a
 * maintenance tool, not a build step: run it only when a source SVG changes.
 *
 *     node scripts/icons.mjs
 *
 * It rasterises with the Playwright Chromium that the E2E suite already installs, so it
 * adds no dependency (no `sharp`, no native bindings) and touches no fixture or network.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'apps/web/public/branding')

// Resolved from the e2e workspace, the only package that depends on Playwright.
const { chromium } = createRequire(join(root, 'e2e/package.json'))('@playwright/test')

/** Each output PNG and the SVG it comes from. `maskable` also backs the apple-touch icon:
 *  iOS rounds the corners itself, so a full-bleed square with the artwork inside the safe
 *  zone is exactly what it wants — a pre-rounded icon would show its corners. */
const TARGETS = [
  { src: 'assets/logo/waxwing-icon.svg', name: 'icon-192.png', size: 192 },
  { src: 'assets/logo/waxwing-icon.svg', name: 'icon-512.png', size: 512 },
  { src: 'assets/logo/waxwing-icon-maskable.svg', name: 'icon-maskable-512.png', size: 512 },
  { src: 'assets/logo/waxwing-icon-maskable.svg', name: 'apple-touch-icon-180.png', size: 180 },
]

const browser = await chromium.launch()
try {
  for (const target of TARGETS) {
    const svg = readFileSync(join(root, target.src), 'utf8')
    const page = await browser.newPage({
      viewport: { width: target.size, height: target.size },
      deviceScaleFactor: 1,
    })
    // No transparency anywhere: every source is a full-bleed opaque square, and an
    // apple-touch icon with an alpha channel is composited on black by iOS.
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}` +
        `svg{display:block;width:100%;height:100%}</style>${svg}`,
    )
    const png = await page.screenshot({ type: 'png', omitBackground: false })
    writeFileSync(join(out, target.name), png)
    await page.close()
    console.log(`${target.name}  ${target.size}×${target.size}  ${png.byteLength} B`)
  }
} finally {
  await browser.close()
}

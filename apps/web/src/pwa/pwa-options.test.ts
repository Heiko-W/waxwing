import { describe, expect, it } from 'vitest'
// The deployment manifest, read from the file that actually SHIPS (public/) rather than from a
// build-time object — a hoster edits this one in place.
import manifest from '../../public/manifest.json'
import { pwaOptions } from './pwa-options'
import { MANIFEST_FILENAME, NEVER_PRECACHE } from './sw-routes'

const injectManifest = pwaOptions.injectManifest ?? {}
const icons: readonly { src: string; sizes: string; purpose: string }[] = manifest.icons

describe('pwaOptions — the precache contract', () => {
  it('is INERT during `pnpm test` — vitest.config.ts merges this very Vite config', () => {
    expect(pwaOptions.disable).toBe(true)
  })

  it('emits no service worker in the dev server', () => {
    expect(pwaOptions.devOptions?.enabled).toBe(false)
  })

  it('precaches ONLY the content-addressed app shell', () => {
    expect(injectManifest.globPatterns).toEqual(['index.html', 'assets/**/*.{js,css}'])
  })

  it('never precaches a file a hoster may edit in the deployment directory (FR-DEP-04)', () => {
    const ignored = injectManifest.globIgnores ?? []
    for (const entry of NEVER_PRECACHE) {
      expect(ignored, entry).toContain(entry)
      // …and no glob pattern may sweep it back in.
      expect(injectManifest.globPatterns ?? []).not.toContain(entry)
    }
    expect(pwaOptions.includeAssets).toEqual([])
    expect(pwaOptions.includeManifestIcons).toBe(false)
  })

  it('lets the plugin generate NO manifest — a generated one is precached unconditionally', () => {
    // vite-plugin-pwa appends its generated manifest to `additionalManifestEntries`, and
    // workbox-build applies those AFTER `manifestTransforms`, so no option can keep it out of the
    // precache. A precached manifest would shadow the SW's NetworkFirst route and freeze a hoster's
    // rebrand until the next release — so the manifest ships as public/manifest.json instead.
    expect(pwaOptions.manifest).toBe(false)
    expect(NEVER_PRECACHE).toContain(MANIFEST_FILENAME)
  })

  it('raises the file-size ceiling above the entry chunk — Workbox SKIPS oversized files silently', () => {
    expect(injectManifest.maximumFileSizeToCacheInBytes ?? 0).toBeGreaterThan(2 * 1024 * 1024)
  })

  it('uses our own bundled worker and our own registration', () => {
    expect(pwaOptions.strategies).toBe('injectManifest')
    expect(pwaOptions.srcDir).toBe('src/sw')
    expect(pwaOptions.filename).toBe('sw.ts')
    expect(pwaOptions.registerType).toBe('prompt')
    expect(pwaOptions.injectRegister).toBe(false)
    // With injectManifest the plugin's workbox block is ignored — a `workbox:` key here would be a lie.
    expect(pwaOptions.workbox).toBeUndefined()
  })
})

describe('public/manifest.json — the installed app', () => {
  it('is a .json file (Stalwart serves .webmanifest as application/octet-stream — SP.5)', () => {
    expect(MANIFEST_FILENAME).toBe('manifest.json')
  })

  it('is path-prefix safe: id, start_url and scope are all relative (FR-DEP-02)', () => {
    expect(manifest.id).toBe('./')
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
    expect(manifest.display).toBe('standalone')
  })

  it('ships the installable icon set, all relative and all under branding/', () => {
    expect(icons.some((icon) => icon.sizes === '192x192')).toBe(true)
    expect(icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any')).toBe(true)
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    for (const icon of icons) {
      expect(icon.src, icon.src).toMatch(/^branding\//)
    }
  })
})

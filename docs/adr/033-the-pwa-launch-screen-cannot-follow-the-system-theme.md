# 033 — The PWA launch screen cannot follow the system theme, so it stays light and says so

- **Status:** accepted
- **Date:** 2026-08-24
- **Work package:** HIG review 2026-08-24 (finding **P-12**)
- **Relates to:** FR-THEME-02 (light/dark), FR-DEP-04 (`manifest.json` is a deployment file),
  `docs/theming.md`, `apps/web/index.html` (the two `theme-color` metas that DO follow the system)

## Context

`public/manifest.json` carries `"background_color": "#f5f5f7"` — the **light** value of
`--waxwing-bg`. iOS builds the launch screen of a home-screen app from that colour plus the icon,
so a reader in dark mode gets a light-grey full-screen flash on every cold start before the dark app
paints over it. HIG `launching`: *"make sure that your launch screen matches the device's current
orientation and appearance mode."*

The web app manifest has **one** `background_color` and no media-query mechanism. That is the whole
of the problem: this is not something the app has failed to do, it is something the format cannot
express. The neighbouring case proves the point — `theme-color` has the identical limitation in the
manifest, and `index.html` therefore ships *two* `<meta name="theme-color">` with `media`
attributes, which the manifest cannot mirror.

Three ways out were considered.

1. **A neutral `background_color`.** Wrong in both modes instead of wrong in one. It trades a
   correct light launch for a mismatched launch everywhere — a worse outcome dressed as a compromise.
2. **`apple-touch-startup-image` per `prefers-color-scheme`.** This does work, and it is
   iOS-specific and device-specific: a separate PNG for every screen size and pixel ratio, each one
   re-cut whenever the brand changes. `manifest.json` is a *deployment* file a white-label hoster
   edits in place without a rebuild (FR-DEP-04); a matrix of pre-rendered splash images is exactly
   the kind of thing that would not survive that promise.
3. **Accept it and write it down.**

## Decision

**Option 3.** `background_color` stays at the light value, and the limitation is recorded — here, in
`docs/theming.md` beside the other rebranding knobs, and in the HIG audit as a closed finding rather
than an open one.

A hoster who ships to one audience with a known preference may set `background_color` to their dark
value; it is a plain deployment file and nothing in the app reads it.

## Consequences

- A dark-mode reader who installs Waxwing to their home screen sees a light flash at cold start.
  It is brief (the app boots to first paint well inside a second) and it is honest — it is the
  documented shape of a platform limit, not an oversight that keeps getting re-found.
- The next HIG or UI review finds this written down instead of filing it again. That is most of the
  value: P-12 was found by a review that had no way to tell "deliberate" from "never noticed".
- If the manifest specification gains a media-query mechanism for `background_color`, or if Waxwing
  ever ships pre-rendered brand assets for other reasons, this decision is worth reopening — option
  2 becomes cheap the moment an image pipeline exists for something else.
- Nothing changes for Android/Chromium, where the splash uses the same single colour and no
  alternative exists either.

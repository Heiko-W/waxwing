# Project site

One hand-written `index.html`, published to GitHub Pages by `.github/workflows/pages.yml`.

**Everything the page references must live in this directory.** The Pages workflow uploads
`docs/site/` and nothing else, so a path like `../../assets/logo/…` resolves during local
preview and 404s once deployed — which is why `waxwing-icon.svg` is a copy rather than a
reference. Keep it in step with `assets/logo/waxwing-icon.svg` if that changes.

`shots/` holds the screenshots, for that same reason — see its README for how they are taken and
why they are WebP.

No generator, no theme, no build step: for four sections, a toolchain costs more to keep alive
than it saves. Preview it with any static server, e.g. `python3 -m http.server -d docs/site`.

# Screenshots

Taken against the local Stalwart fixture with its seeded corpus — a real client talking to a real
mail server, not a mockup. The message list, the sender names and the remote-content banner are
what that server actually returned.

## Re-taking them

```sh
pnpm shots          # capture (Playwright) + convert to WebP
pnpm shots:convert  # conversion only, after a quality tweak
```

`pnpm shots` brings the Stalwart fixture up, seeds alice's inbox, builds the shipping bundle,
serves it behind the same-origin proxy, drives two browser contexts over it and tears the fixture
down again. It needs Docker and `cwebp` (`apt install webp` / `brew install webp`).

There used to be a note here saying a script for this would be "one more thing to keep working",
and that was right at two images. At nine — two viewports, a dark variant, and one that has to be
photographed with the right message open — hand-taking them means they are subtly inconsistent
and nobody can reproduce them. The capture is `e2e/shots/`, driven by
`e2e/playwright.shots.config.ts`, which reuses the fixture setup the read suite already owns
rather than reimplementing it (ADR-003).

## Why they live here

`.github/workflows/pages.yml` publishes `docs/site/` and nothing else. A screenshot one directory
up renders fine on GitHub and 404s on the live site — a difference nobody looks for. So the site
and the README both point here.

Only the WebP files are committed. The PNGs stay in `e2e/shots/out/` (gitignored): committing both
would be two copies of the same picture, drifting apart the moment someone re-runs half of this.

## What each one is for

| File | Shows |
| --- | --- |
| `desktop-reading` / `-dark` | The three-pane layout, and the remote-content banner — blocking remote images by default is a claim the README makes, so it is in frame on purpose. |
| `desktop-phishing` | The FR-RD-06 warning that the display name is not the sender's real address. The site names both this feature and its limits. |
| `desktop-compose` | The composer docked over the list, rich-text toolbar visible. |
| `phone-list` | Bottom navigation and the list at 390 px. |
| `phone-reading` | Single-pane reading with "Back to messages", and the banner wrapping properly. |
| `phone-folders` | The folder rail as an off-canvas drawer. |
| `phone-compose` | Full-screen composing, with the editor filling the window. |

There is no settings screenshot: at 1440 px that screen is a narrow column of controls with
most of the frame empty, which photographs as an unfinished page rather than a simple one.

The phone shots are 390 × 844 at 3× with touch emulation — below both shell breakpoints, so they
photograph the real narrow layout rather than a squeezed desktop. That layout had never been
looked at by any suite before `e2e/tests/narrow.spec.ts`, and taking these is how that was found.

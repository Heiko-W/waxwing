# Screenshots

Taken against the local Stalwart fixture with its seeded corpus — real data from a real server,
not a mockup. The light one is in the project README.

To retake them after a visual change: bring up `pnpm e2e:server`, seed with `pnpm seed:read`,
serve the built app with `WAXWING_E2E=1 vite preview --port 4183`, and drive Playwright at it.
There is no committed script: this is a once-in-a-while job, and a script for it would be one
more thing to keep working.

`reading-dark.png` keeps the remote-content banner in frame on purpose — blocking remote images
by default is a claim the README makes, and this is what it looks like.

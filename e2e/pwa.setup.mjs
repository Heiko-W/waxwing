// M3.10 deploy-suite global setup: bring the Stalwart fixture up advertising THIS suite's origin
// and seed alice's inbox. Same shape as read.setup.mjs — deliberately, so there is one fixture
// lifecycle to understand rather than three.
//
// The two deployments are NOT built here. They are built by the webServer command (pwa-build.mjs),
// because Playwright does not guarantee that globalSetup runs before the webServer starts, and the
// server's document root is one of the build's outputs.

import { up } from './stalwart/fixture.mjs'
import { seedReadMail } from './stalwart/seed-read.mjs'

/** Must equal the deploy config's PORT / baseURL — the origin the fixture advertises. */
export const APP_ORIGIN = 'http://localhost:4186'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const summary = await seedReadMail()
  console.log(
    `[pwa.setup] seeded inbox ${summary.inboxId}: +${summary.created} (removed ${summary.removed})`,
  )
}

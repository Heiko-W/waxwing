// M5.15 WebKit smoke suite global setup. Identical in shape to `read.setup.mjs` — the fixture must
// advertise THIS suite's origin, because the JMAP client follows the advertised absolute apiUrl and
// the preview proxy only forwards its own origin — but on its own port, so the two suites can run
// side by side without one re-provisioning the fixture out from under the other.

import { up } from './stalwart/fixture.mjs'
import { seedReadMail } from './stalwart/seed-read.mjs'

/** Must equal the webkit config's PORT / baseURL. */
export const APP_ORIGIN = 'http://localhost:4187'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const summary = await seedReadMail()
  console.log(
    `[webkit.setup] seeded inbox ${summary.inboxId}: +${summary.created} (removed ${summary.removed})`,
  )
}

// M1.9 read-suite global setup: bring the Stalwart fixture up advertising the browser origin
// (so the same-origin Vite proxy is enough — no CORS), then seed alice's inbox with the read
// corpus. Idempotent: `up()` is a fast no-op when the container is already running with this
// STALWART_PUBLIC_URL, and the seeder resets its own `wread` batch first.

import { up } from './stalwart/fixture.mjs'
import { seedReadMail } from './stalwart/seed-read.mjs'

/** Must equal the read config's PORT / baseURL — the origin the fixture advertises. */
export const APP_ORIGIN = 'http://localhost:4183'

export default async function globalSetup() {
  // Session/OIDC docs must advertise the app origin, since the JMAP client uses the advertised
  // absolute apiUrl/eventSourceUrl for every request and the proxy only forwards this origin.
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const summary = await seedReadMail()
  console.log(
    `[read.setup] seeded inbox ${summary.inboxId}: +${summary.created} (removed ${summary.removed})`,
  )
}

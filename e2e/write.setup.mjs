// M2.9 write-suite global setup: bring the Stalwart fixture up advertising the browser origin
// (same-origin Vite proxy → no CORS), then clear any prior `[wwrite]` mail so the run is clean.
// Idempotent: `up()` is a fast no-op when the container is already running with this origin.

import { up } from './stalwart/fixture.mjs'
import { resetWriteMail } from './stalwart/seed-write.mjs'

/** Must equal the write config's PORT / baseURL — the origin the fixture advertises. */
export const APP_ORIGIN = 'http://localhost:4184'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const removed = await resetWriteMail()
  console.log(
    `[write.setup] fixture up @ ${APP_ORIGIN}; cleared ${removed} prior [wwrite] message(s)`,
  )
}

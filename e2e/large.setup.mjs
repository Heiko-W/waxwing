// M4.8 large-mailbox global setup.
//
// Brings the fixture up advertising the BROWSER origin — the same requirement `read.setup.mjs`
// documents, and the one this suite learned the hard way: started with a bare `pnpm e2e:server`,
// the session advertises `localhost:18080`, every JMAP call from the app is cross-origin, and the
// symptom is an empty folder sidebar that looks like an app hanging on a big mailbox rather than
// like a misconfigured fixture.
//
// It deliberately does NOT seed. Seeding 100 000 messages takes about eight minutes, so it is a
// separate, idempotent step the operator runs once:
//
//     pnpm e2e:server && pnpm seed:large 100000 && pnpm e2e:large
//
// `up()` is a fast no-op when the container is already running with this STALWART_PUBLIC_URL, so a
// re-run after seeding keeps the seeded corpus. There is no teardown for the same reason: it would
// destroy the volume and with it the eight minutes.

import { up } from './stalwart/fixture.mjs'

/** Must equal the large config's PORT / baseURL — the origin the fixture advertises. */
export const APP_ORIGIN = 'http://localhost:4183'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
}

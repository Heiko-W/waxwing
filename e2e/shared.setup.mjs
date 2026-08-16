// M4.4 shared-account suite global setup: bring the Stalwart fixture up advertising the browser
// origin, seed alice's own inbox, then GRANT the delegations this suite is about.
//
// Delegation is opt-in (see `ensureDelegations` in stalwart/fixture.mjs): it changes alice's sidebar
// from one folder tree into account-grouped sections, which makes the plain `treeitem name=/Inbox/`
// locator every other suite uses ambiguous — and it would leave the single-account path, Waxwing's
// documented byte-for-byte invariant, with no end-to-end coverage at all. So only this suite turns it
// on, and `shared.teardown.mjs` turns it back off.

import { ensureDelegations, up } from './stalwart/fixture.mjs'
import { seedReadMail } from './stalwart/seed-read.mjs'

/** Must equal the shared config's PORT / baseURL — the origin the fixture advertises. */
export const APP_ORIGIN = 'http://localhost:4186'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const summary = await seedReadMail()
  console.log(
    `[shared.setup] seeded alice's inbox ${summary.inboxId}: +${summary.created} (removed ${summary.removed})`,
  )
  const granted = await ensureDelegations()
  console.log(`[shared.setup] granted ${granted.length} share(s)`)
}

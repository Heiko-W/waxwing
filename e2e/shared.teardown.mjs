// M4.4 shared-account suite global teardown.
//
// Revoking comes FIRST and runs even when the fixture is kept up: `up` does not wipe the volume, so a
// share left behind would silently reshape every later suite's sidebar into account-grouped sections
// and make their `treeitem name=/Inbox/` locators ambiguous. The failure would then surface in a
// completely unrelated suite, looking like anything but its cause. `smoke()` asserts the
// single-account default for exactly this reason, but only on the next `up` — this is the cheap fix
// at the source.

import { clearShareNotifications, down, revokeAllShares } from './stalwart/fixture.mjs'

export default async function globalTeardown() {
  // `revokeAllShares` rather than `revokeDelegations`: the S-3 tests grant a share through the UI,
  // from alice's account and on a folder of their choosing, and the fixed DELEGATIONS list knows
  // nothing about it. One left behind reshapes a later suite's sidebar into account-grouped
  // sections and makes its `treeitem name=/Inbox/` locators ambiguous.
  await revokeAllShares().catch((error) => {
    console.warn(`[shared.teardown] revoke failed: ${error?.message ?? error}`)
  })
  // And the notifications those shares produced, so the S-1 suite starts from none next time.
  for (const who of ['alice', 'bob', 'carol']) {
    await clearShareNotifications(who).catch(() => {})
  }
  if (process.env.WAXWING_KEEP_FIXTURE === '1') {
    console.log('[shared.teardown] WAXWING_KEEP_FIXTURE=1 — shares revoked, leaving the fixture up')
    return
  }
  down()
}

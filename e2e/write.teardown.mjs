// M2.9 write-suite global teardown: drop the fixture (containers + ephemeral volume). Set
// WAXWING_KEEP_FIXTURE=1 to leave it up between local runs (globalSetup no-ops on the next run).

import { down } from './stalwart/fixture.mjs'

export default function globalTeardown() {
  if (process.env.WAXWING_KEEP_FIXTURE === '1') {
    console.log('[write.teardown] WAXWING_KEEP_FIXTURE=1 — leaving the fixture up')
    return
  }
  down()
}

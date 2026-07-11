// M1.9 read-suite global teardown: drop the fixture (containers + ephemeral volume). Set
// WAXWING_KEEP_FIXTURE=1 to leave it up between local runs (fast iteration — globalSetup then
// no-ops on the next run).

import { down } from './stalwart/fixture.mjs'

export default function globalTeardown() {
  if (process.env.WAXWING_KEEP_FIXTURE === '1') {
    console.log('[read.teardown] WAXWING_KEEP_FIXTURE=1 — leaving the fixture up')
    return
  }
  down()
}

// M3.10 deploy-suite global teardown: drop the fixture (containers + ephemeral volume). Set
// WAXWING_KEEP_FIXTURE=1 to leave it up between local runs. The `.pwa` build directory is left in
// place on purpose — it is gitignored, and keeping it makes a repeat run's diagnosis possible
// (which build was staged when the suite failed?).

import { down } from './stalwart/fixture.mjs'

export default function globalTeardown() {
  if (process.env.WAXWING_KEEP_FIXTURE === '1') {
    console.log('[pwa.teardown] WAXWING_KEEP_FIXTURE=1 — leaving the fixture up')
    return
  }
  down()
}

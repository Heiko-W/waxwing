// What the server thinks it is pushing to — against a running `pnpm webpush` fixture.
//
//   pnpm webpush:status
//
// A subscription can be silently useless in exactly two ways, and this prints both:
//
//  · **`verificationCode: null`** — the RFC 8620 §7.2.2 handshake never completed, so the server
//    pushes NOTHING but the verification itself. Indistinguishable, from the outside, from "no mail
//    has arrived".
//  · **a missing or wrong `types` filter** — the app would be woken on every `Email` change,
//    including one caused by reading a message on another device.
//
// It also prints `expires`, which is the seven-day ceiling the settings copy warns about: Stalwart
// grants seven days whether or not more is requested, and only a running client can renew.

import { ACCOUNTS, BASE_URL, PASSWORD } from '../e2e/stalwart/fixture.mjs'

const [alice] = ACCOUNTS
const auth = `Basic ${Buffer.from(`${alice.login}:${PASSWORD}`).toString('base64')}`

const doc = await (
  await fetch(`${BASE_URL}/.well-known/jmap`, { headers: { Authorization: auth } })
).json()

const vapid = doc.capabilities['urn:ietf:params:jmap:webpush-vapid']
console.log('\nServer (RFC 9749):')
console.log(
  vapid?.applicationServerKey
    ? `  applicationServerKey  ${String(vapid.applicationServerKey).slice(0, 24)}… (${String(vapid.applicationServerKey).length} chars)`
    : '  NOT ADVERTISED — this server cannot sign a Web Push at all.',
)

const response = await fetch(doc.apiUrl, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    using: ['urn:ietf:params:jmap:core'],
    methodCalls: [['PushSubscription/get', { ids: null }, 'p0']],
  }),
})
const { methodResponses } = await response.json()
const list = methodResponses[0][1].list ?? []

console.log(`\nSubscriptions for ${alice.login}: ${String(list.length)}`)
if (list.length === 0) {
  console.log('  none — the app has not subscribed yet, or notifications are switched off.')
  console.log('  (Switching them off DESTROYS the subscription; that is deliberate.)')
}
for (const row of list) {
  console.log(`\n  id              ${row.id}`)
  console.log(`  deviceClientId  ${row.deviceClientId ?? '(none)'}`)
  console.log(`  types           ${JSON.stringify(row.types ?? null)}`)
  console.log(`  expires         ${row.expires ?? '(never)'}`)

  if (JSON.stringify(row.types) !== JSON.stringify(['EmailDelivery'])) {
    console.log('  ! expected types ["EmailDelivery"] — without it the app is woken on every')
    console.log('    Email change, including a message read on another device.')
  }
}

// ── Why there is no "verified" line here, and why that mattered ────────────────────────────────
//
// This script used to print one, derived from `verificationCode`. **It was always wrong.** Stalwart
// requests that property (crates/jmap/src/push/get.rs:42) but never fills it: the match has no arm
// for it, so it falls to `property => insert(Value::Null)` and comes back `null` whether the
// subscription is verified or not. The line therefore read "NO" forever, and during the B29
// hand-check (2026-07-23) it was taken as evidence that verification was stuck — which sent the
// investigation down several wrong paths before Chrome's own `gcm-internals` produced the real
// defect (a transient state tearing the subscription down; see the plan's B29 row).
//
// There is no JMAP-visible way to ask "is this verified": the server keeps that to itself. The only
// honest test is the behaviour — a delivery with every tab closed either raises a banner or does
// not. `pnpm webpush:deliver` and look at the screen.
console.log('\n  (Stalwart never discloses whether a subscription is verified — it returns')
console.log('   verificationCode: null either way. The only honest check is the banner itself:')
console.log('   close every tab, run `pnpm webpush:deliver`, and see whether one appears.)')
console.log('')

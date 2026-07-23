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
  const verified = row.verificationCode !== null && row.verificationCode !== undefined
  console.log(`\n  id              ${row.id}`)
  console.log(`  deviceClientId  ${row.deviceClientId ?? '(none)'}`)
  console.log(`  types           ${JSON.stringify(row.types ?? null)}`)
  console.log(`  expires         ${row.expires ?? '(never)'}`)
  console.log(
    `  verified        ${verified ? 'yes' : 'NO — the server is pushing nothing but the verification'}`,
  )

  if (JSON.stringify(row.types) !== JSON.stringify(['EmailDelivery'])) {
    console.log('  ! expected types ["EmailDelivery"] — without it the app is woken on every')
    console.log('    Email change, including a message read on another device.')
  }
}
console.log('')

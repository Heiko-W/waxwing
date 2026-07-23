// Deliver one mail to alice — or mark one read — against a running `pnpm webpush` fixture.
//
//   pnpm webpush:deliver          bob sends alice a message  → EmailDelivery → banner expected
//   pnpm webpush:deliver --read   marks one of alice's unread messages read → Email only → NO banner
//
// **The `--read` case is the interesting one, and it is not padding.** A JMAP `StateChange` carries
// no sender, no subject and no id, so a contentless banner is only meaningful because the
// subscription filters on `EmailDelivery` — a type that moves on ARRIVAL and not when another
// client merely reads something. If that filter were wrong, the app would buzz every time you read
// a message on your phone, and no amount of client-side cleverness could tell the difference from a
// bare state string. This is the one command that demonstrates the difference.
//
// A real SUBMISSION is used rather than an `Email/set` create into the Inbox: only an actual
// delivery moves `EmailDelivery`. Creating a message in a mailbox is a plain `Email` change, and
// would (correctly) raise nothing — which would look like a broken feature.

import { ACCOUNTS, BASE_URL, PASSWORD } from '../e2e/stalwart/fixture.mjs'

const READ_ONLY = process.argv.includes('--read')
const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const SUBMISSION = 'urn:ietf:params:jmap:submission'

const [alice, bob] = ACCOUNTS
const auth = (login) => `Basic ${Buffer.from(`${login}:${PASSWORD}`).toString('base64')}`

async function session(login) {
  const response = await fetch(`${BASE_URL}/.well-known/jmap`, {
    headers: { Authorization: auth(login) },
  })
  if (!response.ok) throw new Error(`session ${login}: HTTP ${String(response.status)}`)
  return response.json()
}

async function call(login, doc, using, methodCalls) {
  const response = await fetch(doc.apiUrl, {
    method: 'POST',
    headers: { Authorization: auth(login), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using, methodCalls }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${login}: HTTP ${String(response.status)} ${text}`)
  return JSON.parse(text)
}

if (READ_ONLY) {
  const doc = await session(alice.login)
  const accountId = doc.primaryAccounts[MAIL]
  const found = await call(
    alice.login,
    doc,
    [CORE, MAIL],
    [
      [
        'Email/query',
        {
          accountId,
          filter: { notKeyword: '$seen' },
          limit: 1,
          sort: [{ property: 'receivedAt', isAscending: false }],
        },
        '0',
      ],
    ],
  )
  const [id] = found.methodResponses[0][1].ids
  if (id === undefined) {
    console.log('[webpush] no unread message left to mark read — deliver one first.')
    process.exit(0)
  }
  await call(
    alice.login,
    doc,
    [CORE, MAIL],
    [['Email/set', { accountId, update: { [id]: { 'keywords/$seen': true } } }, '0']],
  )
  console.log(`[webpush] marked ${id} as read. This moves Email, NOT EmailDelivery —`)
  console.log('          so NO banner may appear. A banner here would be a real defect.')
  process.exit(0)
}

const bobSession = await session(bob.login)
const bobAccount = bobSession.primaryAccounts[MAIL]

const setup = await call(
  bob.login,
  bobSession,
  [CORE, MAIL, SUBMISSION],
  [
    ['Identity/get', { accountId: bobAccount }, '0'],
    ['Mailbox/query', { accountId: bobAccount, filter: { role: 'drafts' } }, '1'],
  ],
)
const identityId = setup.methodResponses[0][1].list[0].id
const draftsId = setup.methodResponses[1][1].ids[0]

const stamp = new Date().toISOString().slice(11, 19)
const sent = await call(
  bob.login,
  bobSession,
  [CORE, MAIL, SUBMISSION],
  [
    [
      'Email/set',
      {
        accountId: bobAccount,
        create: {
          m: {
            mailboxIds: { [draftsId]: true },
            keywords: { $draft: true },
            from: [{ email: bob.login, name: 'Bob' }],
            to: [{ email: alice.login, name: 'Alice' }],
            subject: `Push-Test ${stamp}`,
            bodyValues: { b: { value: `Zugestellt um ${stamp}.` } },
            textBody: [{ partId: 'b', type: 'text/plain' }],
          },
        },
      },
      '0',
    ],
    [
      'EmailSubmission/set',
      {
        accountId: bobAccount,
        create: { s: { emailId: '#m', identityId } },
        onSuccessUpdateEmail: { '#s': { 'keywords/$draft': null } },
      },
      '1',
    ],
  ],
)

const created = sent.methodResponses[1][1].created
if (created === null || created === undefined) {
  console.error('[webpush] submission refused:', JSON.stringify(sent.methodResponses[1][1]))
  process.exit(1)
}
console.log(`[webpush] delivered "Push-Test ${stamp}" to ${alice.login}.`)
console.log('          Expect ONE banner: new mail, no sender, no subject.')

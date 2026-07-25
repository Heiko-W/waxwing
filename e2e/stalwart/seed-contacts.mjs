// Waxwing M4.2 contacts-suite helpers (dependency-free, Node >= 22 builtins only).
//
// The contacts suite drives the REAL app to CREATE a contact / a group, then verifies the outcome by
// talking to the Stalwart container DIRECTLY over JMAP (never the app's sync): a `ContactCard/query`
// + `ContactCard/get` as alice proves the card actually reached the server with the fields the form
// wrote. Built on `jmapAs()` / `ACCOUNTS` from seed-write.mjs — same Basic-auth client, same origin.
//
// Verified live 2026-07-24 against the pinned fixture:
//  - `urn:ietf:params:jmap:contacts` is advertised (session + account level); alice's contacts
//    accountId is her mail accountId, and her default book has `isDefault:true`, `myRights.mayWrite`.
//  - a `ContactCard/set` create → `ContactCard/query {filter:{text}}` → `/get` → `destroy` round-trips.
//  - the SERVER assigns its OWN `uid` and ignores the client-sent one, and derives `name.full` from the
//    `name.components`. So a group test must read the member's SERVER uid back (never guess it) before
//    asserting the group's `members` set — see `seedMemberContact`, which returns the fetched uid.
//
// Determinism: every card this suite creates (through the UI or via `seedMemberContact`) carries the
// stable `wwcon` marker in a searchable field, so `resetContacts()` can destroy any leftover across
// reruns without touching real fixture data. Talks to the container at BASE_URL, like seed-write.mjs.

import { DOMAIN } from './fixture.mjs'

const CORE = 'urn:ietf:params:jmap:core'
const CONTACTS = 'urn:ietf:params:jmap:contacts'
const MAIL = 'urn:ietf:params:jmap:mail'

export { DOMAIN } from './fixture.mjs'
/** Re-exported so the spec has a single import surface. */
export { ACCOUNTS, jmapAs } from './seed-write.mjs'

/**
 * The stable marker every test card carries (in its surname + email local-part, or a group's name).
 * `resetContacts()` keys off it, so anything tagged is disposable and nothing else is ever touched.
 * A clean single run of `[a-z0-9]` so the server's free-text tokenizer indexes it as one term.
 */
export const CONTACTS_TOKEN_PREFIX = 'wwcon'

/** A fresh, collision-free, tokenizer-friendly marker token for one test object. */
export function contactsToken(kind = '') {
  return `${CONTACTS_TOKEN_PREFIX}${kind}${Date.now().toString(36)}`
}

/**
 * The contacts primary account for `client`, resolved ONCE from the session document.
 *
 * The app selects the contacts account the same way (`session.primaryAccounts['…:contacts']`); on this
 * fixture it happens to equal the mail account, but we never assume that. Resolve this in a `beforeAll`
 * and thread the id through every helper: `client.call()` itself does NOT re-fetch the session, so a
 * hoisted id keeps a polling loop to two requests per tick and well clear of Stalwart's 429 limiter.
 */
export async function contactsAccountId(client) {
  const session = await client.session()
  const accountId = session.primaryAccounts?.[CONTACTS]
  if (typeof accountId !== 'string' || accountId === '') {
    throw new Error(
      `no contacts account for ${client.login} — is \`${CONTACTS}\` advertised on the fixture?`,
    )
  }
  return accountId
}

/** Every address book visible to `client`, with the properties the suite reasons about. */
export async function listAddressBooks(client, accountId) {
  const res = await client.call(
    [CORE, CONTACTS],
    [
      [
        'AddressBook/get',
        { accountId, ids: null, properties: ['id', 'name', 'isDefault', 'myRights'] },
        '0',
      ],
    ],
  )
  return res.methodResponses[0][1].list
}

/** The book a new card lands in: the default writable one, else any writable one, else `null`. */
export async function defaultWritableBook(client, accountId) {
  const books = await listAddressBooks(client, accountId)
  return (
    books.find((book) => book.isDefault && book.myRights?.mayWrite) ??
    books.find((book) => book.myRights?.mayWrite) ??
    null
  )
}

/** A book `client` can SEE but NOT write to (`myRights.mayWrite === false`), or `null` if none. */
export async function readOnlyBook(client, accountId) {
  const books = await listAddressBooks(client, accountId)
  return books.find((book) => book.myRights?.mayWrite === false) ?? null
}

const CARD_PROPERTIES = ['uid', 'kind', 'name', 'emails', 'members', 'addressBookIds']

/** `ContactCard/get` for the given ids (returns `[]` for an empty id list — no needless call). */
async function getCards(client, accountId, ids, properties = CARD_PROPERTIES) {
  if (ids.length === 0) return []
  const res = await client.call(
    [CORE, CONTACTS],
    [['ContactCard/get', { accountId, ids, properties }, '0']],
  )
  return res.methodResponses[0][1].list
}

async function queryCardIds(client, accountId, filter) {
  const res = await client.call(
    [CORE, CONTACTS],
    [['ContactCard/query', { accountId, ...(filter ? { filter } : {}), limit: 1000 }, '0']],
  )
  return res.methodResponses[0][1].ids
}

/**
 * Cards matching `token`, verified in JS.
 *
 * The server free-text filter is the primary path; but because a free-text index can tokenize
 * unpredictably, when it returns nothing we FALL BACK to scanning the (tiny) account and keep only the
 * cards that truly carry the token in a fetched field. So the helper answers the real question — "did
 * the app's write reach the server?" — rather than the tokenizer's.
 */
export async function findContactsByToken(client, accountId, token, properties = CARD_PROPERTIES) {
  let ids = await queryCardIds(client, accountId, { text: token })
  if (ids.length === 0) ids = await queryCardIds(client, accountId)
  const cards = await getCards(client, accountId, ids, properties)
  return cards.filter((card) => JSON.stringify(card).includes(token))
}

/** Groups (`kind:"group"`) whose `members` set includes `memberUid` — the FR-CON-04 assertion path. */
export async function findGroupsByMember(
  client,
  accountId,
  memberUid,
  properties = CARD_PROPERTIES,
) {
  const ids = await queryCardIds(client, accountId, { hasMember: memberUid })
  return getCards(client, accountId, ids, properties)
}

/**
 * Ensure a member contact tagged with `token` exists in `bookId`, and return its id + SERVER-assigned
 * `uid`. Idempotent (query-before-create). Crucially it reads the uid back with a `/get`: the server
 * mints its own and ignores ours, so a group test must add the member by the fetched uid, not a guess.
 */
export async function seedMemberContact(client, accountId, bookId, token) {
  const existing = await findContactsByToken(client, accountId, token)
  if (existing.length > 0) {
    const card = existing[0]
    return { id: card.id, uid: card.uid, name: card.name }
  }
  const res = await client.call(
    [CORE, CONTACTS],
    [
      [
        'ContactCard/set',
        {
          accountId,
          create: {
            m: {
              '@type': 'Card',
              version: '1.0',
              // The server overrides this; sent only so the create is a well-formed Card.
              uid: `urn:uuid:${token}`,
              kind: 'individual',
              addressBookIds: { [bookId]: true },
              name: {
                '@type': 'Name',
                components: [
                  { '@type': 'NameComponent', kind: 'given', value: 'Member' },
                  { '@type': 'NameComponent', kind: 'surname', value: token },
                ],
              },
              emails: { e1: { '@type': 'EmailAddress', address: `${token}@${DOMAIN}` } },
            },
          },
        },
        '0',
      ],
    ],
  )
  const created = res.methodResponses[0][1].created?.m
  if (!created) {
    throw new Error(
      `seedMemberContact failed: ${JSON.stringify(res.methodResponses[0][1].notCreated)}`,
    )
  }
  const [card] = await getCards(client, accountId, [created.id], ['uid', 'name'])
  if (!card) throw new Error('seedMemberContact: created card not readable back')
  return { id: created.id, uid: card.uid, name: card.name }
}

/**
 * Seed a message into `client`'s Inbox FROM a dedicated, token-tagged sender, so the sender-to-contact
 * flow (FR-CON-05) has a message to act on. A DIRECT `Email/set` injection (the `seedReplySource`
 * idiom from seed-write.mjs), not a real send — which is the whole point: the `from` can then be an
 * address that carries the `wwcon` token in BOTH its local-part AND its display name. So the card the
 * app creates from it is disposable (`resetContacts` destroys it) and findable
 * (`findContactsByToken` matches the token in the card's email + name) — unlike a card built from a
 * real `bob@` sender, whose untagged leftover would flip the popover to "Edit Contact" on the next run
 * and break the test. `token` MUST be a `contactsToken(...)` so the created card is auto-reset.
 *
 * Uses the MAIL account (`client.account()` / `client.mailboxes()`), not the contacts accountId — on
 * this fixture they coincide, but this stays honest about which is which. Returns the sender's email +
 * display name (the reading-pane trigger is named after the display name) and the seeded subject.
 */
export async function seedSenderMessage(client, token) {
  const acc = await client.account()
  const inbox = (await client.mailboxes()).find((box) => box.role === 'inbox')
  if (!inbox) throw new Error(`${client.login} has no inbox to seed a sender message into`)
  const senderEmail = `${token}@${DOMAIN}`
  const senderName = `Contact ${token}`
  const subject = `${token} sender-to-contact`
  const res = await client.call(
    [CORE, MAIL],
    [
      [
        'Email/set',
        {
          accountId: acc,
          create: {
            src: {
              mailboxIds: { [inbox.id]: true },
              keywords: {},
              from: [{ name: senderName, email: senderEmail }],
              to: [{ email: client.login }],
              subject,
              htmlBody: [{ partId: 'h', type: 'text/html' }],
              bodyValues: {
                h: {
                  value: '<p>Please add me to your contacts.</p>',
                  isEncodingProblem: false,
                  isTruncated: false,
                },
              },
            },
          },
        },
        '0',
      ],
    ],
  )
  const created = res.methodResponses[0][1].created?.src
  if (!created) {
    throw new Error(
      `seedSenderMessage failed: ${JSON.stringify(res.methodResponses[0][1].notCreated)}`,
    )
  }
  return { emailId: created.id, senderEmail, senderName, subject }
}

/**
 * Destroy any `wwcon`-tagged mail across `client`'s account (the sender-to-contact seed), so a rerun
 * starts clean. Idempotent. Filters on a subject SUBSTRING in JS (like `resetWriteMail`), never a
 * tokenized JMAP `subject` filter, because the marker sits in the subject and cannot be trusted to
 * tokenize to a reliable match term. Scoped to the account's newest 200 messages — ample on a fixture.
 */
export async function resetSenderMail(client) {
  const acc = await client.account()
  const q = await client.call(
    [CORE, MAIL],
    [
      [
        'Email/query',
        { accountId: acc, sort: [{ property: 'receivedAt', isAscending: false }], limit: 200 },
        '0',
      ],
    ],
  )
  const ids = q.methodResponses[0][1].ids
  if (ids.length === 0) return 0
  const g = await client.call(
    [CORE, MAIL],
    [['Email/get', { accountId: acc, ids, properties: ['subject'] }, '0']],
  )
  const doomed = g.methodResponses[0][1].list
    .filter((mail) => (mail.subject ?? '').includes(CONTACTS_TOKEN_PREFIX))
    .map((mail) => mail.id)
  if (doomed.length === 0) return 0
  await client.call([CORE, MAIL], [['Email/set', { accountId: acc, destroy: doomed }, '0']])
  return doomed.length
}

/**
 * Destroy every `wwcon`-tagged card (contacts AND groups) across the account so a rerun starts clean.
 * Idempotent. Scans the whole account and filters in JS on a fetched field, because the marker sits in
 * different places on a contact (surname/email) versus a group (name) — a single free-text filter
 * cannot be trusted to catch both.
 */
export async function resetContacts(client, accountId) {
  const ids = await queryCardIds(client, accountId)
  const cards = await getCards(client, accountId, ids)
  const doomed = cards
    .filter((card) => JSON.stringify(card).includes(CONTACTS_TOKEN_PREFIX))
    .map((card) => card.id)
  if (doomed.length === 0) return 0
  await client.call([CORE, CONTACTS], [['ContactCard/set', { accountId, destroy: doomed }, '0']])
  return doomed.length
}

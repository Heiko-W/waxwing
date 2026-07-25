import { expect, test } from '@playwright/test'
import {
  ACCOUNTS,
  type AddressBookLike,
  type ContactCardLike,
  contactsAccountId,
  contactsToken,
  DOMAIN,
  defaultWritableBook,
  findContactsByToken,
  findGroupsByMember,
  type JmapClient,
  jmapAs,
  readOnlyBook,
  resetContacts,
  resetSenderMail,
  seedMemberContact,
  seedSenderMessage,
} from '../stalwart/seed-contacts.mjs'
import { CREDENTIALS, login, messageList } from './helpers'

/**
 * M4.2 contacts suite — the REAL production bundle against the live Stalwart fixture (it runs in the
 * WRITE harness; see playwright.write.config.ts `testMatch`). It proves the work package's Done-when
 * end to end, and every effect is verified against the SERVER over JMAP rather than the screen that
 * wrote it — the same discipline as write.spec.ts / settings.spec.ts:
 *
 *  - CRUD (FR-CON-02): the app creates a contact; `ContactCard/query`+`/get` reads it back with the
 *    fields the form wrote.
 *  - Group (FR-CON-04): the app builds a group over a seeded member; the group's `members` set carries
 *    the member's SERVER-assigned `uid` (the server mints its own and ignores the client's, so the
 *    seed reads the real uid back before we assert on it).
 *  - Read-only (FR-CON-01): an HONEST premise-skip. A read-only shared book cannot be provisioned on
 *    this fixture (no `currentUserPrincipalId`, alice sees only her own account → no cross-account
 *    sharing), so the test checks that premise against the live session and skips with the reason when
 *    it is absent, rather than faking a red/green result. The gating itself is covered by the
 *    ContactDetail / ContactForm / GroupForm component tests.
 */

/** ONE client + ONE resolved contacts accountId for the whole file (anti-429; see settings.spec.ts). */
const alice: JmapClient = jmapAs(ACCOUNTS.alice)
let aliceAccountId = ''
/** The account's read-only book, if any — resolved once so the read-only test's premise is cheap. */
let roBook: AddressBookLike | null = null

/** Gentle poll: never bursts Stalwart's abuse limiter, ample for an outbox flush to reach the server. */
const POLL = { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }

/** Escape a token for use inside a `RegExp` accessible-name matcher. */
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test.beforeAll(async () => {
  aliceAccountId = await contactsAccountId(alice)
  roBook = await readOnlyBook(alice, aliceAccountId)
})

// Destroy any leftover `wwcon`-tagged cards AND mail so each test — and each rerun — starts clean.
test.beforeEach(async () => {
  await resetContacts(alice, aliceAccountId)
  await resetSenderMail(alice)
})

// Backstop: leave the fixture as we found it, whatever the last test did.
test.afterAll(async () => {
  await resetContacts(alice, aliceAccountId)
  await resetSenderMail(alice)
})

/** Open the Contacts area the way a user does — via the primary nav — and wait for the rail. */
async function openContacts(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Address books' })).toBeVisible({
    timeout: 30_000,
  })
}

/** Poll `fetch` (a JMAP read) until it returns a non-empty list, then hand the caller that list. */
async function pollContacts(
  fetchCards: () => Promise<ContactCardLike[]>,
): Promise<ContactCardLike[]> {
  let last: ContactCardLike[] = []
  await expect
    .poll(async () => {
      last = await fetchCards()
      return last.length
    }, POLL)
    .toBeGreaterThan(0)
  return last
}

test.describe('M4.2 contacts suite', () => {
  test('creates a contact that round-trips to the server (FR-CON-02)', async ({ page }) => {
    const token = contactsToken('c')
    await login(page, CREDENTIALS.alice)
    await openContacts(page)

    await page.getByRole('button', { name: 'New contact', exact: true }).click()
    await expect(page.getByLabel('First name', { exact: true })).toBeVisible({ timeout: 15_000 })
    await page.getByLabel('First name', { exact: true }).fill('Wax')
    await page.getByLabel('Last name', { exact: true }).fill(token)
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${token}@${DOMAIN}`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // The SERVER is the assertion — not the toast/navigation that followed the save.
    const cards = await pollContacts(() => findContactsByToken(alice, aliceAccountId, token))
    expect(cards.length, 'exactly one card carries the token').toBe(1)
    const card = cards[0]
    const addresses = Object.values(card?.emails ?? {}).map((entry) => entry.address)
    expect(addresses).toContain(`${token}@${DOMAIN}`)
    const surname = (card?.name?.components ?? []).find((c) => c.kind === 'surname')?.value
    expect(surname ?? card?.name?.full ?? '').toContain(token)
    // The card is left for `afterAll`/next `beforeEach` (`resetContacts`) to destroy.
  })

  test('adds a member to a new group that round-trips (FR-CON-04)', async ({ page }) => {
    const memberToken = contactsToken('m')
    const groupToken = contactsToken('g')

    // Seed the member over JMAP BEFORE login, so the app's initial sync carries it into the picker.
    const book = await defaultWritableBook(alice, aliceAccountId)
    if (book === null) throw new Error('alice has no writable address book to seed a member into')
    const member = await seedMemberContact(alice, aliceAccountId, book.id, memberToken)
    const memberUid = member.uid
    if (memberUid === undefined) throw new Error('the server assigned the member no uid')

    await login(page, CREDENTIALS.alice)
    await openContacts(page)
    // The seeded member must be in the replica before it can be picked as a candidate.
    await expect(page.getByRole('option', { name: new RegExp(escapeRe(memberToken)) })).toBeVisible(
      {
        timeout: 30_000,
      },
    )

    await page.getByRole('button', { name: 'New group', exact: true }).click()
    await page.getByLabel('Group name', { exact: true }).fill(groupToken)
    await page
      .getByRole('searchbox', { name: 'Search contacts to add', exact: true })
      .fill(memberToken)
    await page
      .getByRole('button', { name: new RegExp(`^Add\\b.*${escapeRe(memberToken)}`) })
      .click()
    // The member is now in the group draft — its remove affordance proves the pick committed.
    await expect(
      page.getByRole('button', { name: new RegExp(`^Remove\\b.*${escapeRe(memberToken)}`) }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // The SERVER is the assertion: a group whose `members` carries the member's SERVER uid.
    const groups = await pollContacts(() => findGroupsByMember(alice, aliceAccountId, memberUid))
    expect(groups.length, 'exactly one group holds the member').toBe(1)
    const group = groups[0]
    expect(group?.kind).toBe('group')
    expect(group?.members?.[memberUid]).toBe(true)
    expect(group?.name?.full ?? '').toContain(groupToken)
  })

  test('adds a message sender to Contacts, round-tripping to the server (FR-CON-05)', async ({
    page,
  }) => {
    const token = contactsToken('s')
    // A DEDICATED, token-tagged sender injected straight into alice's Inbox (the seedReplySource
    // idiom). The card the app builds from it carries the token in BOTH email and name, so it is
    // findable and `resetContacts`-disposable — unlike a card from a real `bob@` sender, whose
    // untagged leftover would flip the popover to "Edit Contact" on the next run.
    const seeded = await seedSenderMessage(alice, token)

    await login(page, CREDENTIALS.alice)
    // `login()` lands on the Inbox; wait for the seeded message to sync into the list, then open it.
    const row = messageList(page).getByText(seeded.subject)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()

    // The reading-pane sender trigger is named after the sender's DISPLAY name
    // (`reading.senderCard.trigger` = "Show contact card for {{name}}"), which carries the token.
    await page
      .getByRole('button', { name: new RegExp(`Show contact card for.*${escapeRe(token)}`) })
      .click()
    // The popover is an APG dialog; its "Add to Contacts" action appears once the cards liveQuery
    // resolves (the add-vs-edit choice is withheld until then — see SenderCard).
    const add = page.getByRole('button', { name: 'Add to Contacts', exact: true })
    await expect(add).toBeVisible({ timeout: 15_000 })
    await add.click()

    // The SERVER is the assertion — a card whose email is the sender's address — not the toast.
    const cards = await pollContacts(() => findContactsByToken(alice, aliceAccountId, token))
    expect(cards.length, 'exactly one card was added for the sender').toBe(1)
    const addresses = Object.values(cards[0]?.emails ?? {}).map((entry) => entry.address)
    expect(addresses).toContain(seeded.senderEmail)
    // The card is left for `resetContacts`, the seeded mail for `resetSenderMail`, to clean up.
  })

  test('imports a vCard whose contacts round-trip to the server (FR-CON-06)', async ({ page }) => {
    // One base token, two derived tokens: `contactsToken()` keys off `Date.now()`, so two calls in
    // the same millisecond would collide — deriving `a`/`b` guarantees two distinct, `wwcon`-tagged
    // (hence resettable) markers that each match exactly one imported card.
    const base = contactsToken('i')
    const token1 = `${base}a`
    const token2 = `${base}b`
    const vcard = `${[
      'BEGIN:VCARD',
      'VERSION:4.0',
      `FN:Import ${token1}`,
      `EMAIL:${token1}@${DOMAIN}`,
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:4.0',
      `FN:Import ${token2}`,
      `EMAIL:${token2}@${DOMAIN}`,
      'END:VCARD',
    ].join('\r\n')}\r\n`

    await login(page, CREDENTIALS.alice)
    await openContacts(page)

    await page.getByRole('button', { name: 'Import or export', exact: true }).click()
    // The import file input carries its own aria-label (`contacts.io.import.choose`); `setInputFiles`
    // drives it directly with an in-memory .vcf (no temp file).
    await page.getByLabel('Choose a file (.vcf or .json)').setInputFiles({
      name: 'roundtrip.vcf',
      mimeType: 'text/vcard',
      buffer: Buffer.from(vcard),
    })

    // Once parsed, the confirm button carries the plural count; each imported card is one Outbox
    // intent (`contacts.io.import.confirm` / `contacts.io.result.imported`).
    const confirm = page.getByRole('button', { name: 'Import 2 contacts', exact: true })
    await expect(confirm).toBeVisible({ timeout: 15_000 })
    await confirm.click()
    await expect(page.getByText('2 contacts imported.', { exact: true })).toBeVisible({
      timeout: 15_000,
    })

    // The SERVER is the assertion: both tagged cards reached alice's account with their addresses.
    const first = await pollContacts(() => findContactsByToken(alice, aliceAccountId, token1))
    expect(first.length, 'the first imported contact reached the server').toBe(1)
    expect(Object.values(first[0]?.emails ?? {}).map((entry) => entry.address)).toContain(
      `${token1}@${DOMAIN}`,
    )
    const second = await pollContacts(() => findContactsByToken(alice, aliceAccountId, token2))
    expect(second.length, 'the second imported contact reached the server').toBe(1)
    expect(Object.values(second[0]?.emails ?? {}).map((entry) => entry.address)).toContain(
      `${token2}@${DOMAIN}`,
    )
    // Both cards are left for `resetContacts` (`wwcon` prefix) to destroy.
  })

  test('a read-only shared book gates writes (FR-CON-01)', async ({ page }) => {
    test.skip(
      roBook === null,
      'no read-only shared book provisioned on the fixture — cross-account sharing/delegation is ' +
        'M4.4 groundwork; the read-only gating is covered by the ContactDetail/ContactForm/GroupForm ' +
        'component tests.',
    )
    // Unreachable once skipped; narrows `roBook` for TypeScript and future-proofs the assertion so a
    // fixture that DOES provision a read-only book exercises the read path rather than an empty body.
    if (roBook === null) return

    await login(page, CREDENTIALS.alice)
    await openContacts(page)
    const rail = page.getByRole('navigation', { name: 'Address books' })
    await expect(rail.getByText(roBook.name)).toBeVisible()
    await expect(rail.getByText('Read only', { exact: true })).toBeVisible()
  })
})

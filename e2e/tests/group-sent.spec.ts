import { expect, type Page, test } from '@playwright/test'
import { ensureGroup, GROUP, removeGroup } from '../stalwart/fixture.mjs'
import { jmapAs } from '../stalwart/seed-write.mjs'
import {
  clickSend,
  fillSubject,
  fillTo,
  openComposer,
  revealPasswordForm,
  SYNC_BUDGET_MS,
  setUndoGrace,
  typeBody,
} from './helpers'

// Issue #101 — a message sent under a GROUP address is filed in the group's Sent folder, where every
// member sees it, and not in the sender's personal Sent.
//
// The setup is the production one for a shared `info@` mailbox: a Stalwart `Group` principal
// (`team@waxwing.test`) with alice and bob as members, and an identity for the group address in
// alice's OWN account. The submission necessarily runs in alice's account (ADR-020); what this proves
// is the follow-up move into the group account, and that bob — the other member — can see the result.

const ALICE = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const CAROL = 'carol@waxwing.test'
const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'

const POLL = { timeout: 30_000, intervals: [500, 1000, 2000] }

type Client = ReturnType<typeof jmapAs>

/** The account id `client`'s session names for `name` (the group, or the user's own address). */
async function accountIdNamed(client: Client, name: string): Promise<string> {
  const doc = (await client.session()) as { accounts: Record<string, { name: string }> }
  const id = Object.entries(doc.accounts).find(([, account]) => account.name === name)?.[0]
  if (id === undefined) throw new Error(`${name} is not in ${client.login}'s session`)
  return id
}

/** Subjects in the Sent folder of `accountId` that contain `token`, as `client` sees them. */
/** The arguments of response `index` — the fixture client types `methodResponses` loosely. */
function argsOf(response: { methodResponses: unknown[] }, index: number): { list: unknown[] } {
  const entry = response.methodResponses[index] as [string, { list: unknown[] }] | undefined
  if (entry === undefined) throw new Error(`no method response #${index}`)
  return entry[1]
}

async function sentSubjects(client: Client, accountId: string, token: string): Promise<string[]> {
  const boxes = await client.call(
    [CORE, MAIL],
    [['Mailbox/get', { accountId, ids: null, properties: ['id', 'role'] }, '0']],
  )
  const sent = (argsOf(boxes, 0).list as { id: string; role: string | null }[]).find(
    (box) => box.role === 'sent',
  )
  if (sent === undefined) throw new Error(`account ${accountId} has no Sent folder`)
  const found = await client.call(
    [CORE, MAIL],
    [
      ['Email/query', { accountId, filter: { inMailbox: sent.id, subject: token } }, '0'],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
          properties: ['subject'],
        },
        '1',
      ],
    ],
  )
  return (argsOf(found, 1).list as { subject: string }[]).map((email) => email.subject)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(ALICE.user)
  await page.getByLabel('Password', { exact: true }).fill(ALICE.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  // The group's section only renders once its account has synced — and its Sent folder with it,
  // which the composer needs to know where the copy goes.
  await expect(page.getByRole('region', { name: GROUP.login })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/** Pick the From identity whose option text names `email`. */
async function chooseFrom(page: Page, email: string): Promise<void> {
  const from = page.getByLabel('From', { exact: true })
  await expect(from).toBeVisible()
  const value = await from
    .locator('option')
    .filter({ hasText: email })
    .first()
    .getAttribute('value')
  if (value === null) throw new Error(`no From option for ${email}`)
  await from.selectOption(value)
}

async function send(page: Page, fromEmail: string, subject: string): Promise<void> {
  await setUndoGrace(page, 1)
  await login(page)
  await openComposer(page)
  await chooseFrom(page, fromEmail)
  await fillTo(page, CAROL)
  await fillSubject(page, subject)
  await typeBody(page, 'Sent under the shared address.')
  await clickSend(page)
}

test.describe('issue #101 — sent copy of a group send', () => {
  test.beforeAll(async () => {
    await ensureGroup()
  })

  test.afterAll(async () => {
    await removeGroup()
  })

  test('a send as the group address lands in the GROUP Sent, visible to the other member', async ({
    page,
  }) => {
    const token = `group-sent-${Date.now()}`
    await send(page, GROUP.login, `[e2e] ${token}`)

    const alice = jmapAs(ALICE.user)
    const bob = jmapAs('bob@waxwing.test')
    const teamForBob = await accountIdNamed(bob, GROUP.login)
    const aliceOwn = await accountIdNamed(alice, ALICE.user)

    // Bob — the OTHER member — finds it in the group's Sent …
    await expect.poll(() => sentSubjects(bob, teamForBob, token), POLL).toHaveLength(1)
    // … and alice's personal Sent no longer holds it: moved, not duplicated.
    await expect.poll(() => sentSubjects(alice, aliceOwn, token), POLL).toHaveLength(0)
    // And it really went out.
    const carol = jmapAs(CAROL)
    await expect.poll(async () => (await carol.query(token)).length, POLL).toBe(1)
  })

  test('a send as the personal identity stays in the personal Sent', async ({ page }) => {
    const token = `own-sent-${Date.now()}`
    await send(page, ALICE.user, `[e2e] ${token}`)

    const alice = jmapAs(ALICE.user)
    const aliceOwn = await accountIdNamed(alice, ALICE.user)
    const teamForAlice = await accountIdNamed(alice, GROUP.login)

    await expect.poll(() => sentSubjects(alice, aliceOwn, token), POLL).toHaveLength(1)
    // Give a (wrong) follow-up move every chance to happen before asserting it did not.
    await page.waitForTimeout(3000)
    expect(await sentSubjects(alice, teamForAlice, token)).toHaveLength(0)
  })
})

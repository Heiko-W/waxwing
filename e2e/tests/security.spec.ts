import { expect, test } from '@playwright/test'
import { BASE_URL, DOMAIN, PASSWORD } from '../stalwart/fixture.mjs'
import { ACCOUNTS, type JmapClient, jmapAs } from '../stalwart/seed-write.mjs'
import { CREDENTIALS, login, openSettings, openSettingsSection } from './helpers'

/**
 * Settings → Account & security, against the live Stalwart fixture (findings X-1, X-2, X-4, X-5).
 *
 * Three things here can only be proved against a real server, and each one is verified through
 * JMAP rather than through the screen that wrote it:
 *
 *  1. **The capability really is where the client looks for it.** The unit tests assert the gate
 *     against a hand-made session; this asserts that the hand-made session still matches what the
 *     PINNED server sends. `capabilities-model.ts` documents what happens when those two drift:
 *     both sides pass, and they describe opposite worlds.
 *  2. **A created app password really authenticates.** The screen can only show a string. Whether
 *     that string is a working credential is a question for the server, and it is asked here with
 *     a raw Basic-auth request — the same thing a phone's mail app would do.
 *  3. **The language really lands on the account.** Written through the UI, read back over
 *     `x:AccountSettings/get`, and put back the way it was found.
 *
 * ── What this file deliberately does NOT do ──────────────────────────────────────────────────
 * **It never changes alice's password, right or wrong.** Not the happy path: the fixture's own
 * helpers (`seed-write.mjs`, `fixture.mjs`) authenticate with a compile-time constant, so a run
 * that changed the password and then failed before changing it back would leave every other suite
 * unable to sign in. And not the failure path either: Stalwart counts failed `currentSecret`
 * attempts and answers a run of them with `SecurityEvent::AuthenticationBan` — with `retries: 2`
 * on CI, one deliberately-wrong password per test becomes three per job, aimed at an account four
 * other suites need. The refusal path is covered hermetically instead
 * (`apps/web/src/settings/security.test.tsx`, "quotes the server when it refuses"); what is checked
 * here is that the form exists, is reachable and warns about the consequence.
 *
 * Runs in the WRITE harness: it creates and revokes a credential on alice, and moves her account
 * locale and back.
 */

const CORE = 'urn:ietf:params:jmap:core'
const STALWART = 'urn:stalwart:jmap'
const SECTION = 'Account & security'

/** Every app password this file makes carries it, so the cleanup can find its own litter. */
const TOKEN = 'wwsec'

interface SessionDoc {
  readonly capabilities: Record<string, unknown>
  readonly accounts: Record<string, { readonly accountCapabilities: Record<string, unknown> }>
  readonly primaryAccounts: Record<string, string>
}

interface AppPassword {
  readonly id: string
  readonly description: string
}

/** ONE client for the file — `jmapAs()` re-fetches the session per call, and Stalwart 429s a burst. */
const alice: JmapClient = jmapAs(ACCOUNTS.alice)
let aliceAccountId = ''

test.beforeAll(async () => {
  aliceAccountId = await alice.account()
})

/** The first response's arguments — `methodResponses` is typed loosely by the JS helper's `.d.mts`. */
function first(response: {
  methodResponses: [string, Record<string, unknown>, string][]
}): Record<string, unknown> {
  const invocation = response.methodResponses[0]
  if (invocation === undefined) throw new Error('no method response')
  return invocation[1]
}

async function appPasswords(): Promise<AppPassword[]> {
  const response = await alice.call(
    [CORE, STALWART],
    [['x:AppPassword/get', { accountId: aliceAccountId }, '0']],
  )
  return (first(response).list ?? []) as AppPassword[]
}

async function accountLocale(): Promise<string> {
  const response = await alice.call(
    [CORE, STALWART],
    [['x:AccountSettings/get', { accountId: aliceAccountId, ids: ['singleton'] }, '0']],
  )
  const list = first(response).list as { locale?: string }[]
  const singleton = list[0]
  if (singleton?.locale === undefined) throw new Error('no account settings singleton')
  return singleton.locale
}

async function setAccountLocale(locale: string): Promise<void> {
  await alice.call(
    [CORE, STALWART],
    [
      [
        'x:AccountSettings/set',
        { accountId: aliceAccountId, update: { singleton: { locale } } },
        '0',
      ],
    ],
  )
}

/** Leave nothing behind, whichever assertion failed. */
test.afterAll(async () => {
  const litter = (await appPasswords())
    .filter((one) => one.description.includes(TOKEN))
    .map((one) => one.id)
  if (litter.length > 0) {
    await alice.call(
      [CORE, STALWART],
      [['x:AppPassword/set', { accountId: aliceAccountId, destroy: litter }, '0']],
    )
  }
  if ((await accountLocale()) !== 'en_US') await setAccountLocale('en_US')
})

test.describe('Settings → Account & security', () => {
  test('is offered because THIS server advertises the capability — on the account, not the session', async ({
    page,
  }) => {
    // The premise, from the live session document. If Stalwart ever moves the URN to the top level
    // the app keeps working (`hasCapability` reads both), but the reason the unit fixture is shaped
    // the way it is would have expired — and this is where that shows up.
    const session = (await alice.session()) as unknown as SessionDoc
    expect(Object.keys(session.capabilities)).not.toContain(STALWART)
    const account = session.accounts[aliceAccountId]
    expect(Object.keys(account?.accountCapabilities ?? {})).toContain(STALWART)

    await login(page)
    await openSettings(page)

    const rail = page.getByRole('navigation', { name: 'Settings' })
    await expect(rail.getByRole('link', { name: SECTION, exact: true })).toBeVisible()
  })

  test('creates an app password whose secret really authenticates, then revokes it', async ({
    page,
  }) => {
    const name = `${TOKEN} phone ${Date.now()}`
    await login(page)
    await openSettings(page)
    await openSettingsSection(page, SECTION)

    await page.getByRole('button', { name: 'Create app password…', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('What is it for?').fill(name)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()

    // The one element in the dialog that carries the secret. Deliberately not a role query: the
    // <output> maps to `status`, and so does the toast region this page also renders.
    const secretBox = dialog.locator('output')
    await expect(secretBox).toBeVisible()
    const secret = ((await secretBox.textContent()) ?? '').trim()
    expect(secret).toMatch(/^app_[a-z0-9]+$/)

    // Said plainly, while the secret is still on screen.
    await expect(dialog).toContainText('This is the only time it is shown.')

    // THE assertion: a real Basic-auth request, the way a phone's mail app makes one.
    const probe = await fetch(`${BASE_URL}/jmap/session`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`alice@${DOMAIN}:${secret}`).toString('base64')}`,
      },
    })
    expect(probe.status).toBe(200)
    // …and it is a DIFFERENT credential from the account password, not an echo of it.
    expect(secret).not.toBe(PASSWORD)

    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    // Gone from the page the moment it is dismissed — there is no second chance to read it.
    await expect(page.locator('body')).not.toContainText(secret)

    // The server has it, masked, and the list shows it.
    await expect(page.getByText(name, { exact: true })).toBeVisible()
    expect((await appPasswords()).map((one) => one.description)).toContain(name)

    await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click()

    await expect(page.getByText(name, { exact: true })).toBeHidden()
    await expect
      .poll(async () => (await appPasswords()).map((one) => one.description), {
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .not.toContain(name)

    // And the revoked secret stops working — a "Revoke" that only removed a row would be a lie.
    const after = await fetch(`${BASE_URL}/jmap/session`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`alice@${DOMAIN}:${secret}`).toString('base64')}`,
      },
    })
    expect(after.status).not.toBe(200)
  })

  test('writes the language of the server’s own messages, and the account really has it', async ({
    page,
  }) => {
    expect(await accountLocale()).toBe('en_US')

    await login(page)
    await openSettings(page)
    await openSettingsSection(page, SECTION)

    await page.getByLabel('Language of server messages').selectOption('de_DE')

    await expect
      .poll(accountLocale, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBe('de_DE')

    // Put it back through the UI, so the revert is exercised too.
    await page.getByLabel('Language of server messages').selectOption('en_US')
    await expect
      .poll(accountLocale, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBe('en_US')
  })

  test('reports encryption at rest, and offers no way to switch it on', async ({ page }) => {
    // This client has no OpenPGP stack: with encryption at rest on it cannot display a word of the
    // mailbox. The state is worth reporting — it explains an otherwise baffling mailbox — and the
    // switch is not ours to offer.
    await login(page)
    await openSettings(page)
    await openSettingsSection(page, SECTION)

    const panel = page.getByRole('region', { name: SECTION })
    await expect(panel).toContainText('Off. Your server stores your messages unencrypted.')
    await expect(panel.getByRole('switch')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /encrypt/i })).toHaveCount(0)
  })

  test('offers the password form, and warns what changing it costs, without submitting one', async ({
    page,
  }) => {
    // See the note at the top of this file: the password is never changed against a shared fixture,
    // and a deliberately-wrong `currentSecret` is not sent either — Stalwart bans an account that
    // accumulates them, and CI retries would accumulate them three at a time.
    await login(page)
    await openSettings(page)
    await openSettingsSection(page, SECTION)

    await page.getByRole('button', { name: 'Change password…', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Current password')).toBeVisible()
    await expect(dialog.getByLabel('New password')).toBeVisible()
    await expect(dialog.getByLabel('Repeat new password')).toBeVisible()
    await expect(dialog).toContainText('App passwords keep working.')

    // The one thing safe to submit: two new passwords that disagree. Caught in the client, so no
    // request is made and no attempt is counted.
    await dialog.getByLabel('Current password').fill(CREDENTIALS.alice.pass)
    await dialog.getByLabel('New password').fill('one-Pw1!')
    await dialog.getByLabel('Repeat new password').fill('another-Pw1!')
    await dialog.getByRole('button', { name: 'Change password', exact: true }).click()

    await expect(dialog).toContainText('The two new passwords are not the same.')

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})

import { expect, test } from '@playwright/test'
import {
  ACCOUNTS,
  expectNoMail,
  jmapAs,
  mailboxRoles,
  pollEmail,
  pollMail,
  resetWriteMail,
  seedReplySource,
  WRITE_PREFIX,
} from '../stalwart/seed-write.mjs'
import {
  CREDENTIALS,
  clickSend,
  fillSubject,
  fillTo,
  login,
  messageList,
  openComposer,
  openFolder,
  setUndoGrace,
  typeBody,
} from './helpers'

// M2.9 write E2E suite — the REAL production bundle against the live Stalwart fixture (see
// playwright.write.config.ts + write.setup.mjs). It proves the Phase-2 "write" story end to end:
// compose → send → real delivery to the recipient's Inbox, reply threading + `$answered`, an
// attachment round-trip, draft autosave/recovery, and undo-send preventing delivery. The recipient
// side is verified over JMAP (not the app's ~60 s sweep), so the asserts are fast + non-flaky.
//
// DP-1 (verified live 2026-07-11): `EmailSubmission/set` alice→bob delivers to bob's Inbox and
// `onSuccessUpdateEmail` moves alice's copy Drafts→Sent, clears `$draft`, sets `$seen`.

const uniqueToken = (kind: string) => `${kind}-${Date.now()}`

// Clean any prior write-suite mail so each test starts from a known state.
test.beforeEach(async () => {
  await resetWriteMail()
})

test.describe('M2.9 write suite', () => {
  test('compose → send → recipient Inbox + sender Sent (FR-CMP-07)', async ({ page }) => {
    const token = uniqueToken('send')
    const subject = `${WRITE_PREFIX} ${token}`
    await setUndoGrace(page, 1)
    await login(page, CREDENTIALS.alice)
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'Hello from the write suite.')
    await clickSend(page)

    // Recipient: bob receives it in his Inbox, from alice.
    const bob = jmapAs(ACCOUNTS.bob)
    const received = await pollMail(bob, token, ['subject', 'mailboxIds', 'from'], {
      timeoutMs: 30_000,
    })
    expect(received.length).toBe(1)
    const bobRoles = await mailboxRoles(bob)
    const bobBoxes = Object.keys(received[0]?.mailboxIds ?? {}).map((id) => bobRoles.get(id))
    expect(bobBoxes).toContain('inbox')
    expect(received[0]?.from?.[0]?.email).toBe(ACCOUNTS.alice)

    // Sender: alice's copy is in Sent, $draft cleared, $seen set (onSuccessUpdateEmail).
    const alice = jmapAs(ACCOUNTS.alice)
    const sent = await pollMail(alice, token, ['mailboxIds', 'keywords'], { timeoutMs: 15_000 })
    expect(sent.length).toBe(1)
    const aliceRoles = await mailboxRoles(alice)
    expect(Object.keys(sent[0]?.mailboxIds ?? {}).map((id) => aliceRoles.get(id))).toContain('sent')
    expect(sent[0]?.keywords?.$draft).toBeUndefined()
    expect(sent[0]?.keywords?.$seen).toBe(true)
  })

  test('reply threads to the source and flags it $answered (FR-CMP-07)', async ({ page }) => {
    const source = await seedReplySource()
    await setUndoGrace(page, 1)
    await login(page, CREDENTIALS.alice)
    await messageList(page).getByText(source.subject).click()
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
      timeout: 15_000,
    })
    await typeBody(page, 'Thanks — will do.')
    await clickSend(page)

    // bob receives a "Re:" carrying inReplyTo/references = the source Message-ID.
    const bob = jmapAs(ACCOUNTS.bob)
    const received = await pollMail(bob, source.token, ['subject', 'inReplyTo', 'references'], {
      timeoutMs: 30_000,
    })
    const reply = received.find((m) => (m.subject ?? '').startsWith('Re:'))
    expect(reply, 'a Re: reply reached bob').toBeDefined()
    expect(reply?.inReplyTo).toContain(source.messageId)
    expect(reply?.references).toContain(source.messageId)

    // The source in alice's Inbox is flagged $answered.
    const alice = jmapAs(ACCOUNTS.alice)
    const src = await pollEmail(alice, source.emailId, (e) => e.keywords?.$answered === true)
    expect(src?.keywords?.$answered).toBe(true)
  })

  test('attachment round-trip — the recipient receives the file (FR-CMP-04)', async ({ page }) => {
    const token = uniqueToken('attach')
    const subject = `${WRITE_PREFIX} ${token}`
    await setUndoGrace(page, 1)
    await login(page, CREDENTIALS.alice)
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'Here you go.')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'hello.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('write-suite attachment payload'),
    })
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await clickSend(page)

    const bob = jmapAs(ACCOUNTS.bob)
    const received = await pollMail(bob, token, ['subject', 'attachments'], { timeoutMs: 30_000 })
    expect(received.length).toBe(1)
    expect(received[0]?.attachments?.some((a) => a.name === 'hello.txt')).toBe(true)
  })

  test('draft autosave + reload restores it in the Drafts folder (FR-CMP-03)', async ({ page }) => {
    const token = uniqueToken('draft')
    const subject = `${WRITE_PREFIX} ${token}`
    await login(page, CREDENTIALS.alice)
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'Draft in progress, do not lose me.')

    // The 3 s idle autosave lands a $draft in the Drafts mailbox.
    const alice = jmapAs(ACCOUNTS.alice)
    const saved = await pollMail(alice, token, ['subject', 'keywords'], { timeoutMs: 30_000 })
    expect(saved.length).toBe(1)
    expect(saved[0]?.keywords?.$draft).toBe(true)

    // A full reload drops the in-memory app; sign back in — the autosaved draft persisted to the
    // server (crash-safety), so it is findable in the Drafts folder without re-typing.
    await page.reload()
    await login(page, CREDENTIALS.alice)
    await openFolder(page, /Drafts/)
    await expect(messageList(page).getByText(subject)).toBeVisible({ timeout: 30_000 })
  })

  test('undo send cancels delivery and reopens the draft (FR-CMP-08)', async ({ page }) => {
    const token = uniqueToken('undo')
    const subject = `${WRITE_PREFIX} ${token}`
    await setUndoGrace(page, 10) // ample grace to click Undo before the send fires
    await login(page, CREDENTIALS.alice)
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'This send should be undone.')
    await clickSend(page)

    // The composer closes and an Undo snackbar appears; click it before the grace elapses.
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    // The draft reopens with its content intact.
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(subject)

    // bob NEVER receives it (poll past the 10 s grace).
    const bob = jmapAs(ACCOUNTS.bob)
    expect(await expectNoMail(bob, token, 13_000)).toEqual([])
  })
})

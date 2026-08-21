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

/**
 * Send options and attaching from Files (M-7, M-11, D-5) — the three findings of 2026-08-21 that
 * live in the compose path, each proved against the LIVE server rather than a fake.
 *
 * All three are request shapes no unit test can vouch for. `NOTIFY`/`ORCPT`/`RET` are ESMTP
 * parameters the JMAP layer forwards verbatim to the MTA, which either accepts the envelope or
 * refuses the whole submission; `MT-PRIORITY` was measured to accept only -6…5 on this build, so a
 * value from the RFC's wider range would fail the send and nothing local would notice; and D-5's
 * entire premise is that a `FileNode`'s `blobId` is usable as a message attachment — a claim about
 * two JMAP data types sharing a blob namespace, which only the server can settle.
 */
test.describe('compose: send options + stored attachments (M-7, M-11, D-5)', () => {
  test('a receipted, high-priority send carries the headers and gets a DSN back', async ({
    page,
  }) => {
    const token = uniqueToken('dsn')
    const subject = `${WRITE_PREFIX} ${token}`
    await setUndoGrace(page, 1)
    await login(page, CREDENTIALS.alice)
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'Please confirm you got this.')

    // The controls are behind ONE button and nothing else on the surface moved — that is the design
    // constraint, so it is asserted before the behaviour.
    await expect(page.getByLabel('Priority', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Send options', exact: true }).click()
    const options = page.getByRole('dialog').filter({ hasText: 'Send options' })
    await options.getByLabel('Priority', { exact: true }).selectOption('high')
    await options.getByRole('switch', { name: /delivery receipt/i }).click()
    await options.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(options).toBeHidden()

    await clickSend(page)

    // ---- the RECIPIENT sees the priority, because it travels as message headers (M-11). This is
    // the half MT-PRIORITY cannot do: it orders the sending queue and is invisible past the MTA.
    const bob = jmapAs(ACCOUNTS.bob)
    const received = await pollMail(
      bob,
      token,
      ['subject', 'header:X-Priority:asText', 'header:Importance:asText'],
      { timeoutMs: 30_000 },
    )
    expect(received.length).toBe(1)
    expect(received[0]?.['header:X-Priority:asText']).toBe('1')
    expect(received[0]?.['header:Importance:asText']).toBe('high')

    // ---- the ENVELOPE carried the DSN request (M-7). Read back off the submission the server
    // stored, which is the only place that proves the parameters survived the round trip.
    const alice = jmapAs(ACCOUNTS.alice)
    const accountId = await alice.account()
    const submissions = await alice.call(
      ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
      [
        [
          'EmailSubmission/query',
          { accountId, sort: [{ property: 'sentAt', isAscending: false }], limit: 1 },
          's0',
        ],
        [
          'EmailSubmission/get',
          { accountId, '#ids': { resultOf: 's0', name: 'EmailSubmission/query', path: '/ids' } },
          's1',
        ],
      ],
    )
    const submission = (
      submissions.methodResponses.find(([name]) => name === 'EmailSubmission/get')?.[1] as {
        list?: {
          envelope?: {
            mailFrom?: { parameters?: Record<string, string | null> | null }
            rcptTo?: { email: string; parameters?: Record<string, string | null> | null }[]
          } | null
        }[]
      }
    ).list?.[0]
    // `RET=HDRS`: a report about a large message must not carry the message back with it.
    expect(submission?.envelope?.mailFrom?.parameters?.RET).toBe('HDRS')
    const rcpt = submission?.envelope?.rcptTo?.[0]
    expect(rcpt?.parameters?.NOTIFY).toContain('SUCCESS')
    // Measured: NOTIFY may never mix NEVER with anything (`Invalid parameter: NOTIFY`), and ORCPT
    // without the `rfc822;` address-type prefix is refused outright.
    expect(rcpt?.parameters?.NOTIFY).not.toContain('NEVER')
    expect(rcpt?.parameters?.ORCPT).toMatch(/^rfc822;/)

    // ---- and the receipt actually COMES BACK. Measured against this fixture: it arrives as an
    // ordinary message from the mail system, not on `EmailSubmission.dsnBlobIds` (which stays
    // empty), which is why the reading side needed no change at all.
    const aliceAccount = await alice.account()
    const inbox = (await alice.mailboxes()).find((box) => box.role === 'inbox')
    const deadline = Date.now() + 60_000
    let report: { subject?: string } | undefined
    while (Date.now() < deadline && report === undefined) {
      const answer = await alice.call(
        ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        [
          [
            'Email/query',
            {
              accountId: aliceAccount,
              filter: { inMailbox: inbox?.id, from: 'MAILER-DAEMON' },
              sort: [{ property: 'receivedAt', isAscending: false }],
              limit: 1,
            },
            'q0',
          ],
          [
            'Email/get',
            {
              accountId: aliceAccount,
              '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
              properties: ['subject'],
            },
            'q1',
          ],
        ],
      )
      report = (
        answer.methodResponses.find(([name]) => name === 'Email/get')?.[1] as {
          list?: { subject?: string }[]
        }
      ).list?.[0]
      if (report === undefined) await page.waitForTimeout(2_000)
    }
    expect(report, 'no delivery report arrived from the mail system').toBeDefined()
  })

  test('a file already in the account is attached by reference — nothing is uploaded', async ({
    page,
  }) => {
    const token = uniqueToken('d5')
    const subject = `${WRITE_PREFIX} ${token}`
    const fileName = `e2e-attach-${token}.txt`
    const payload = `waxwing D-5 payload ${token}\n`
    await setUndoGrace(page, 1)
    await login(page, CREDENTIALS.alice)

    // ---- put a file in the account the ordinary way (this part DOES upload).
    await page.getByRole('link', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(payload),
    })
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 30_000 })

    // ---- from here on, COUNT every upload. The whole finding is that attaching a stored file
    // costs none: the message references the file's existing blob. A counter is the only way to
    // tell "referenced" from "quietly re-uploaded", because both produce a correct attachment.
    let uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/jmap\/upload\//.test(request.url())) uploads += 1
    })

    await page.getByRole('link', { name: 'Mail', exact: true }).click()
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await fillSubject(page, subject)
    await typeBody(page, 'The file is attached from my Files.')

    await page.getByRole('button', { name: 'Attach file', exact: true }).click()
    await page.getByRole('menuitem', { name: 'From Files…', exact: true }).click()
    const picker = page.getByRole('dialog').filter({ hasText: 'Attach from Files' })
    await picker.getByRole('checkbox', { name: new RegExp(fileName) }).click()
    await picker.getByRole('button', { name: /^Attach 1 file$/ }).click()
    await expect(picker).toBeHidden()

    // Instant, because there is nothing to transfer — no progress chip ever appears.
    await expect(page.getByText(fileName, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await clickSend(page)

    const bob = jmapAs(ACCOUNTS.bob)
    const received = await pollMail(bob, token, ['subject', 'attachments'], { timeoutMs: 30_000 })
    expect(received.length).toBe(1)
    const attachment = received[0]?.attachments?.find((a) => a.name === fileName)
    expect(attachment, 'the recipient did not get the stored file').toBeDefined()
    expect(attachment?.size).toBe(Buffer.byteLength(payload))

    // THE assertion. If the blobId had to be re-uploaded this would be 1, and D-5 would have cost
    // a download-plus-upload of every attached file rather than a one-line mapping.
    expect(uploads, 'attaching a stored file uploaded bytes it did not need to').toBe(0)

    // ---- clean up after ourselves: the write setup resets mail, never files.
    await page.getByRole('link', { name: 'Files', exact: true }).click()
    const inRow = page.getByRole('button', { name: `Delete ${fileName}`, exact: true })
    if (await inRow.isVisible().catch(() => false)) await inRow.click()
    else {
      await page.getByRole('button', { name: `More actions for ${fileName}`, exact: true }).click()
      await page.getByRole('menuitem', { name: `Delete ${fileName}`, exact: true }).click()
    }
    const confirm = page.getByRole('dialog')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText(fileName, { exact: true })).toHaveCount(0)
  })
})

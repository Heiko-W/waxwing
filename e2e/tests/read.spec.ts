import { expect, type Page, test } from '@playwright/test'
import {
  deliverLiveMail,
  READ_BODIES,
  READ_NESTED,
  READ_PDF,
  READ_PHISHING,
  READ_SUBJECTS,
  seedReadMail,
} from '../stalwart/seed-read.mjs'

// M1.9 read E2E suite — the REAL production bundle against the live Stalwart fixture (see
// playwright.read.config.ts + read.setup.mjs). It proves the Phase-2 "read" story end to end:
// Basic login, folder navigation, reading plain / HTML / threaded mail in the sandboxed frame,
// the triage actions (flag / archive / trash) round-tripping through the outbox, and a live
// delivery surfacing without a refresh (push → sync → liveQuery).

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** The reading-pane iframe for a given subject (title = "Message: <subject>"). */
const bodyFrame = (page: Page, subject: string) =>
  page.frameLocator(`iframe[title="Message: ${subject}"]`)

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  // The app is served from the same origin as its JMAP server (the preview proxy), so the
  // FR-AUTH-01 same-origin probe succeeds and onboarding lands straight on the Basic sign-in
  // step — no connect step to fill.
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await openInbox(page)
}

/** Wait for the connected shell, open the Inbox and wait for the seeded corpus to sync in. */
async function openInbox(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

// Reseed before every test so triage mutations never leak across tests (each test = fresh corpus).
test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M1.9 read suite', () => {
  test('Basic login lists the inbox corpus', async ({ page }) => {
    await login(page)
    const list = messageList(page)
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible()
    await expect(list.getByText(READ_SUBJECTS.newsletter)).toBeVisible()
    // The three-message thread collapses to one row showing the newest ("Re: …") subject.
    await expect(list.getByText(`Re: ${READ_SUBJECTS.thread}`)).toBeVisible()
  })

  test('reads a plain-text message in the sandboxed frame', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible({
      timeout: 20_000,
    })
  })

  test('reads the HTML newsletter: remote content blocked, then loaded', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.newsletter).click()
    // The newsletter carries a remote tracking image → the banner is shown (default block).
    await expect(page.getByText('Remote content blocked')).toBeVisible({ timeout: 20_000 })
    // The sandboxed frame still renders the message text (just not the remote image).
    await expect(
      bodyFrame(page, READ_SUBJECTS.newsletter).getByText(READ_BODIES.newsletterMarker),
    ).toBeVisible()
    // Loading images dismisses the banner (re-sanitized with remote content allowed).
    const violations: string[] = []
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
    })
    await page.getByRole('button', { name: 'Load images' }).click()
    await expect(page.getByText('Remote content blocked')).toHaveCount(0)

    // …and the images are then actually ALLOWED to load. The banner disappearing proved only that
    // we re-sanitized; it stayed green for months while the feature was dead. The frame's srcdoc
    // inherits the APP's policy container, and the outer `img-src 'self' data: blob:` overrode the
    // frame's own widened policy — both must allow, so every remote image was refused after the
    // reader explicitly asked for it. The fixture host is unresolvable on purpose (no third-party
    // request from a test), so what is asserted is the absence of a CSP refusal, not a pixel.
    await page.waitForTimeout(1000)
    expect(violations.filter((text) => /img-src/i.test(text))).toEqual([])
  })

  test('previews a PDF attachment — the frame really loads (F2)', async ({ page }) => {
    // `frame-src 'self'` does not cover a `blob:` URL, so this preview was CSP-blocked in every
    // build: an empty panel under `aria-expanded="true"`. `blob:` had been added to `img-src`
    // deliberately, so the need was understood — image previews go through `<img>` and worked,
    // which is exactly why the PDF path went unnoticed. Only a browser can tell the two apart.
    await login(page)
    await page.getByText(READ_SUBJECTS.pdf).click()
    await expect(page.getByText(READ_PDF.filename)).toBeVisible({ timeout: 20_000 })

    // Read the browser's own verdict rather than guessing from the outside. The preview frame is
    // `sandbox=""`, i.e. an opaque origin, so the parent cannot inspect it and Playwright reports
    // its URL as empty whether it loaded or was refused — the two states are indistinguishable from
    // out here. `securitypolicyviolation` is not.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __csp: string[] }).__csp = seen
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })
    await page.getByRole('button', { name: `Preview: ${READ_PDF.filename}` }).click()

    // The object URL reaches the element…
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document
              .querySelector('iframe[sandbox=""]')
              ?.getAttribute('src')
              ?.startsWith('blob:') ?? false,
        ),
      )
      .toBe(true)
    // …and the browser did not refuse it. Removing `blob:` from `frame-src` makes this line fail
    // with `frame-src blob` — verified by reverting the policy and rebuilding.
    await page.waitForTimeout(1000)
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
    expect(violations.filter((entry) => entry.startsWith('frame-src'))).toEqual([])
  })

  test('shows a threaded conversation with expandable older messages', async ({ page }) => {
    await login(page)
    await page.getByText(`Re: ${READ_SUBJECTS.thread}`).click()
    await expect(page.getByText('3 messages in this conversation')).toBeVisible({ timeout: 20_000 })
    // Newest is expanded: its body renders in the "Re: …" frame.
    await expect(
      bodyFrame(page, `Re: ${READ_SUBJECTS.thread}`).first().getByText(READ_BODIES.threadNewest),
    ).toBeVisible()
    // The oldest is collapsed (its preview is a button); expanding it renders its body.
    await page.getByText(/Kicking off Q3 planning/).click()
    await expect(
      bodyFrame(page, READ_SUBJECTS.thread).getByText(READ_BODIES.threadOldest),
    ).toBeVisible({ timeout: 20_000 })
  })

  test('flags and archives a message from the reading action bar', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Flag', exact: true }).click()
    // The flag stuck (optimistic apply): the control flips to Unflag.
    await expect(page.getByRole('button', { name: 'Unflag', exact: true })).toBeVisible({
      timeout: 15_000,
    })
    // Archiving moves it out of the inbox — the list row disappears (live).
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0, {
      timeout: 15_000,
    })
  })

  test('moves a message to Trash out of the inbox', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0, {
      timeout: 15_000,
    })
  })

  test('auto-refreshes on a live delivery, no manual reload', async ({ page }) => {
    // This used to be "the slow one", budgeted at 75 s because the WebSocket push handshake cannot
    // carry an `Authorization` header under Basic auth — so the comment concluded that push could
    // not authenticate in a browser at all and that live updates had to wait for the ≈60 s
    // safety-sweep poll. That conclusion was half wrong, and M3.10 measured it: SSE is a plain
    // streaming `fetch`, which CAN set the header, and since gap B4 restricted the browser to
    // `['sse','polling']` (engine.ts BROWSER_PUSH_TRANSPORTS) the delivery lands in well under a
    // second. The 60 s of dead budget on every read run is gone with it.
    //
    // The tightened budget is now load-bearing rather than defensive: 20 s is comfortably under the
    // safety sweep, so this can only pass if push really pushed. Reverting B4 (dropping the
    // `transports` allowlist) strands the channel on the un-authable WebSocket and blows it —
    // verified, not assumed. Do not loosen it back without re-reading that paragraph.
    await login(page)
    const list = messageList(page)
    const subject = await deliverLiveMail('t-live')
    await expect(list.getByText(subject)).toBeVisible({ timeout: 20_000 })
  })

  test('OAuth login reaches the inbox (secure-context localhost)', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in securely' }).click()
    // Stalwart's /login SPA (same-origin via the proxy): fill its form and submit; the app then
    // completes the PKCE code exchange and mounts the shell.
    await page.locator('#username').fill(CREDENTIALS.user)
    await page.locator('#password').fill(CREDENTIALS.pass)
    await page.locator('#login-form button[type="submit"]').click()
    await openInbox(page)
  })

  test('cross-tab: a flag in one tab reflects in another', async ({ page, context }) => {
    test.setTimeout(60_000)
    // Tab A signs in and persists the session; tab B (same context → same replica) restores it.
    await login(page, { stay: true })
    const b = await context.newPage()
    await b.goto('/')
    await openInbox(b)
    // Open the same message in both tabs, then flag it in A.
    await page.getByText(READ_SUBJECTS.plain).click()
    await b.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Flag', exact: true }).click()
    // B reflects the change through the shared Dexie replica (cross-tab liveQuery).
    await expect(b.getByRole('button', { name: 'Unflag', exact: true })).toBeVisible({
      timeout: 20_000,
    })
  })

  test('perf smoke: cached open and folder switch (records numbers)', async ({ page }) => {
    await login(page)
    // Warm the body cache (first open fetches + stores the body).
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible()
    // Navigate away, then re-open — now served from the replica, no network fetch (FR-OFF-02).
    await page.getByText(`Re: ${READ_SUBJECTS.thread}`).click()
    await expect(page.getByText('3 messages in this conversation')).toBeVisible()
    const openStart = Date.now()
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible()
    const cachedOpenMs = Date.now() - openStart
    // Folder switch round-trip: Inbox → Trash → Inbox; time the inbox list re-appearing.
    const switchStart = Date.now()
    await page.getByRole('treeitem', { name: /Trash/ }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible()
    const folderSwitchMs = Date.now() - switchStart
    // Record the numbers (the deliverable); the NFR-PERF-02 targets are <100ms open / <200ms switch.
    console.log(`[perf] cached message open: ${cachedOpenMs}ms (NFR-PERF-02 target <100ms)`)
    console.log(`[perf] folder switch Trash→Inbox: ${folderSwitchMs}ms (target <200ms)`)
    // Generous smoke bounds — headless E2E adds click+render overhead beyond the app's own work.
    expect(cachedOpenMs).toBeLessThan(3000)
    expect(folderSwitchMs).toBeLessThan(3000)
  })
})

// M3.9 — header details (FR-RD-06) and phishing friction (FR-RD-08), against the seeded phishing
// message. It carries every hostile pattern at once, because they co-occur in the real thing: two
// Authentication-Results headers (a failing one on top, the sender's own forgery below), a display
// name that IS a different email address, and a link whose text names a host it does not open.
test.describe('M3.9 reading polish', () => {
  test('the auth results shown are the TOPMOST header, never the sender’s forgery', async ({
    page,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(READ_SUBJECTS.phishing, {
      timeout: 20_000,
    })

    await page.getByRole('button', { name: 'Details' }).click()
    const details = page.locator('dl').first()

    // THE assertion of this work package. RFC 8621 §4.1.3 makes `header:X:asText` return the LAST
    // instance; the receiving MTA PREPENDS its own (RFC 8601 §5), so the last one is the ATTACKER'S.
    // Ask the obvious way and this reads "dmarc=pass" for a message that failed every check.
    await expect(details).toContainText(READ_PHISHING.trustedAuthserv)
    await expect(details).toContainText('dmarc=fail')
    await expect(details).not.toContainText(READ_PHISHING.forgedAuthserv)
    await expect(details).not.toContainText('dmarc=pass')
    // Reported, never adjudicated: the reader is told we cannot vouch for who wrote this.
    await expect(details).toContainText(/cannot be verified/i)
  })

  test('the sender’s real address is visible without hovering, and the fake name is marked', async ({
    page,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const article = page.getByRole('article').first()
    await expect(article).toBeVisible({ timeout: 20_000 })

    // "on hover/tap" is what the spec says; hover does not exist on a phone, so the address is
    // always on. No hover, no click, no disclosure — it is simply there.
    await expect(article).toContainText(READ_PHISHING.realAddress)
    await expect(article).toContainText(READ_PHISHING.displayName)
    // `From: "security@bank.test" <mallory@evil.tld>` — the name is impersonating an address.
    await expect(article).toContainText(/not the sender's real address/i)
  })

  test('a link whose text names another host is interrupted; Cancel opens nothing', async ({
    page,
    context,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const frame = bodyFrame(page, READ_SUBJECTS.phishing)
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    let opened = 0
    context.on('page', () => {
      opened += 1
    })

    await frame.getByText(READ_PHISHING.linkText).click()
    // The dialog is a LAZY chunk — wait for it. An immediate visibility check races the import and
    // reports a false "no warning", which is how this very test first lied to me.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText('bank.test')
    await expect(dialog).toContainText('paypa1-secure.ru')

    // The whole point: the default answer is "no", and it must be inert.
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(500)
    expect(opened).toBe(0)
  })

  test('an honest link in the same message opens with no warning at all', async ({ page }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const frame = bodyFrame(page, READ_SUBJECTS.phishing)
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    // The false-positive control, and it is not a formality: a warning readers learn to click
    // through is worse than no warning. Prose text over any href must stay silent.
    await frame.getByText(READ_PHISHING.benignText).click()
    await page.waitForTimeout(1500)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('View source shows the raw message, and Save as .eml downloads it', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(READ_SUBJECTS.plain, {
      timeout: 20_000,
    })

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'View source' }).click()
    const dialog = page.getByRole('dialog', { name: 'Message source' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The real RFC 5322 bytes — and single angle brackets, which the seeder used to double.
    await expect(dialog.locator('pre')).toContainText(`Message-ID: <lunch-thursday@waxwing.test>`)
    await expect(dialog.locator('pre')).toContainText(`Subject: ${READ_SUBJECTS.plain}`)

    const download = page.waitForEvent('download', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Save as .eml' }).click()
    const file = await download
    // The subject sanitizes into the filename; the `?` is not a legal one.
    expect(file.suggestedFilename()).toBe('Lunch on Thursday.eml')
  })
})

// M3.9 step 4 — the non-pointer move paths (FR-MBX-03, WCAG 2.2 SC 2.5.7). These run against the
// live server on purpose: `moveMailbox` was implemented in M1.5 and had ZERO callers until now, so
// nothing had ever executed it end to end. The unit tests stub the engine dispatch, which means they
// prove the UI asks correctly and nothing whatsoever about whether Stalwart accepts the ask.
test.describe('M3.9 move paths', () => {
  /** Create a top-level folder through the UI and wait for it to appear in the tree. */
  async function newFolder(page: Page, name: string): Promise<void> {
    await page.getByRole('button', { name: 'New folder' }).click()
    await page.getByLabel('Folder name', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toBeVisible({
      timeout: 15_000,
    })
  }

  /** Delete a folder through the UI, so the fixture is left as we found it. */
  async function removeFolder(page: Page, name: string): Promise<void> {
    const item = page.getByRole('treeitem', { name: new RegExp(name) })
    await item.hover()
    await item.getByRole('button', { name: 'Folder actions' }).click()
    // `exact`: the menu also carries "Delete older than…", which a prefix match would hit first.
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(item).toBeHidden({ timeout: 15_000 })
  }

  test('a folder re-parents itself — and the SERVER keeps it (moveMailbox first real run)', async ({
    page,
  }) => {
    // `stay` is required, not incidental: this test RELOADS to prove the server kept the move, and
    // without it the token lives only in memory (NFR-SEC-02) so a reload lands back on sign-in.
    await login(page, { stay: true })
    await newFolder(page, 'ZzSrc')
    await newFolder(page, 'ZzDst')

    const src = page.getByRole('treeitem', { name: /ZzSrc/ })
    // Top level: one level deep, i.e. aria-level 1.
    await expect(src).toHaveAttribute('aria-level', '1')

    await src.hover()
    await src.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('menuitem', { name: 'Move to…' }).click()

    const dialog = page.getByRole('dialog', { name: 'Move ZzSrc' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    // The subject must never be able to swallow itself.
    await expect(dialog.getByRole('button', { name: 'ZzSrc', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'ZzDst', exact: true }).click()

    // Optimistic: the row nests immediately.
    await expect(src).toHaveAttribute('aria-level', '2', { timeout: 15_000 })

    // The half that matters and that no unit test can reach: reload from the server. An optimistic
    // patch that the server rejected would snap back here.
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('treeitem', { name: /ZzSrc/ })).toHaveAttribute('aria-level', '2', {
      timeout: 30_000,
    })

    await removeFolder(page, 'ZzDst') // takes ZzSrc with it (it is now a child)
  })

  test('`v` moves the open message to a folder, with an Undo that puts it back', async ({
    page,
  }) => {
    await login(page)
    await page.keyboard.press('j')
    await page.keyboard.press('o')
    const subject = await page.getByRole('heading', { level: 2 }).innerText({ timeout: 20_000 })

    await page.keyboard.press('v')
    const dialog = page.getByRole('dialog', { name: 'Move to folder' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click()

    // Named after its target — a bare `actions.move` (what MessageView did until M3.9) raised no
    // toast at all, so the one move the user chose explicitly was the only one without an Undo.
    await expect(page.getByText('Moved to Archive')).toBeVisible({ timeout: 15_000 })
    await expect(messageList(page).getByText(subject, { exact: true })).toBeHidden({
      timeout: 15_000,
    })

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(messageList(page).getByText(subject, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })
})

// M3.9 step 5b — HTML5 drag & drop (FR-MBX-03). Runs against the live server because nothing else
// exercises real DnD: jsdom fires no drag events, so the unit tests stage `getActiveDrag` by hand and
// prove the wiring but not that a browser's dragstart→dragover→drop actually lands the move.
test.describe('M3.9 drag & drop', () => {
  /**
   * Drive a real HTML5 drag through the browser. Playwright's built-in dragTo does not reliably
   * synthesize dragstart/drop for HTML5 DnD, so dispatch the sequence with ONE shared DataTransfer —
   * the pattern the ecosystem settled on for this API.
   */
  async function dragDrop(page: Page, subject: string, targetFolder: string): Promise<void> {
    await page.evaluate(
      ([subj, folder]) => {
        // The draggable node is the row's wrapper (`[draggable]`); the row itself is inside it.
        const row = [...document.querySelectorAll('[role="row"]')].find((r) =>
          r.textContent?.includes(subj as string),
        )
        const src = row?.closest('[draggable="true"]')
        const dst = [...document.querySelectorAll('[role="treeitem"]')].find((t) =>
          t.textContent?.includes(folder as string),
        )
        if (!src || !dst) throw new Error(`drag nodes missing: src=${!!src} dst=${!!dst}`)
        const dataTransfer = new DataTransfer()
        const fire = (node: Element, type: string) =>
          node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
        fire(src, 'dragstart')
        fire(dst, 'dragenter')
        fire(dst, 'dragover')
        fire(dst, 'drop')
        fire(src, 'dragend')
      },
      [subject, targetFolder],
    )
  }

  test('dragging a message onto a folder moves it — through the undo seam', async ({ page }) => {
    await login(page)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain).first()).toBeVisible({
      timeout: 20_000,
    })

    await dragDrop(page, READ_SUBJECTS.plain, 'Archive')
    // A real move dispatched through triage.moveTo raises the named Undo toast…
    await expect(page.getByText('Moved to Archive')).toBeVisible({ timeout: 15_000 })
    // …and the row leaves the inbox list.
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeHidden({
      timeout: 15_000,
    })
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })
})

// M3.9 step 7 — a nested message/rfc822 opens in-app via Email/parse (FR-RD-07). Live because the
// parse round-trip and its body-value delivery were only ever exercised in the dev demo (SP.4); this
// asserts the production affordance end to end against the real server.
test.describe('M3.9 nested message', () => {
  test('an attached .eml opens inline through Email/parse', async ({ page }) => {
    await login(page)
    // Open the carrier message that forwards the original as an attachment.
    await page.getByText(READ_SUBJECTS.rfc822).first().click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(READ_SUBJECTS.rfc822, {
      timeout: 20_000,
    })

    // The attachment strip lists the .eml with an Open message affordance (not a download preview).
    const open = page.getByRole('button', { name: 'Open message' })
    await expect(open).toBeVisible({ timeout: 15_000 })
    await open.click()

    // Email/parse round-trips and the inner message renders: its header (subject + sender) and its
    // body inside the sandboxed frame. The body value coming back inline is the SP.4 caveat live.
    await expect(page.getByText(READ_NESTED.subject)).toBeVisible({ timeout: 20_000 })
    const innerFrame = page.frameLocator(`iframe[title="Attached message: ${READ_NESTED.subject}"]`)
    await expect(innerFrame.getByText(READ_NESTED.body)).toBeVisible({ timeout: 20_000 })

    // Toggling it closed removes the nested view.
    await page.getByRole('button', { name: 'Hide message' }).click()
    await expect(page.getByText(READ_NESTED.subject)).toBeHidden()
  })
})

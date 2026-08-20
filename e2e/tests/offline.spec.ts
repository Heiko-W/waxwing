import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { jmapAs } from '../stalwart/seed-write.mjs'
import { openSettingsSection, revealPasswordForm, setUndoGrace } from './helpers'

/**
 * A bulk-bar action, wherever the bar has put it.
 *
 * The bar shows what fits and hands the rest to a `⋯` menu; the split is MEASURED at runtime, so
 * an action's location is a property of the column width rather than of the code. Asking for the
 * action and letting the component answer is correct at every width.
 *
 * Wrapped in `toPass` because deciding where it is and acting on that decision are two steps, and
 * the answer can change between them: a bar that is still mounting reports no button for one that
 * is about to appear, and a menu opened on a stale answer does not contain the action. One failed
 * attempt costs a second and re-asks; without this the first wrong guess became a 60s
 * actionability wait with nothing to report but a timeout.
 */
async function bulkAction(page: import('@playwright/test').Page, name: string): Promise<void> {
  const trigger = page.getByRole('button', { name: 'More actions for the selection', exact: true })
  const onBar = page.getByRole('button', { name, exact: true })
  await expect(async () => {
    if (await onBar.first().isVisible()) {
      await onBar.first().click({ timeout: 2_000 })
      return
    }
    await trigger.click({ timeout: 2_000 })
    await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/**
 * M3.10 offline suite (FR-OFF-01/03/04, and the G2 gap-B1/B2 payoffs) — the live counterpart the
 * M3.3 chaos suite explicitly defers to (`engine.chaos.test.ts` header: "the same scenarios against
 * the Stalwart fixture — is M3.10").
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE. The chaos suite injects everything: a virtual clock, a fake
 * online flag, a fake JMAP port, a fake LockManager. It proves the engine's logic and nothing about
 * the wiring. This suite drives the real thing — the real `navigator.onLine`, the real IndexedDB
 * replica, the real Stalwart — so what it catches is the class of bug that is invisible upstream: a
 * seam that is correct in isolation and connected to nothing.
 *
 * THE CONNECTIVITY SEAM, AND WHY THE FIRST TEST IS A GATE. There is no injectable offline hook in
 * the production build. `createSyncEngine` hard-wires `isOnline: () => navigator.onLine` and
 * `StatusRegion` reads the same global through `useSyncExternalStore`; both subscribe to the window
 * `online`/`offline` events. So every test below stands or falls on whether Playwright's
 * `context.setOffline(true)` actually moves that global.
 *
 * It does, and it was measured rather than assumed before any of these tests were written:
 * `navigator.onLine` flips to `false`, exactly one `offline` event fires, the app's own chip appears,
 * and a `fetch()` from the page throws `TypeError: Failed to fetch` — i.e. the network is genuinely
 * down, not merely declared down. Reconnecting reverses all four. The first test pins that, so a
 * future Playwright or Chromium change that breaks the mechanism fails ONCE, here, naming itself,
 * instead of turning six later tests into a confusing pile of timeouts.
 *
 * Runs under playwright.read.config.ts: it needs exactly that fixture (a seeded inbox, an Archive
 * folder, the same-origin proxy) and that config is already serial with a per-test reseed.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

/** The app's own connectivity chip — a polite live region, so `role=status` is the stable handle. */
const offlineChip = (page: Page) => page.getByRole('status').filter({ hasText: 'Offline' })

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

/**
 * The subjects of the visible rows, in DOM order.
 *
 * B2 and B1 both assert a POSITION, not mere presence: a splice that puts the row back in the wrong
 * place, or a re-sort that never happened, would both sail past a `toBeVisible()`. Read the subject
 * CELL rather than the row — a row's text begins with the "Unread" badge and the sender, so its
 * `textContent` would hand back "Unread" where the subject was expected (the same trap
 * `keyboard.spec.ts` documents for `focusedRowSubject`).
 */
async function rowSubjects(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="row"]')]
      .map((row) => row.querySelector('[class*="subject"]')?.textContent?.trim() ?? '')
      .filter((subject) => subject !== ''),
  )
}

/** Tick a row's checkbox by subject, which raises the bulk bar carrying the triage buttons. */
async function selectRow(page: Page, subject: string): Promise<void> {
  await messageList(page)
    .getByRole('row')
    .filter({ hasText: subject })
    .getByRole('checkbox')
    .first()
    .check()
}

/**
 * Go offline and WAIT FOR THE APP TO AGREE.
 *
 * `context.setOffline()` resolves as soon as the CDP command is acknowledged, which is well before
 * React has re-rendered off the `offline` event. Returning early would make every caller race its
 * own precondition, and the failure would surface several assertions later as "the outbox dispatched
 * while offline" — a symptom that points at the app rather than at the test. Assert the chip here so
 * a broken seam fails at the seam.
 */
async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true)
  await expect(offlineChip(page)).toBeVisible({ timeout: 15_000 })
}

/** Reconnect, and wait on the observable rather than on `RECONNECT_DEBOUNCE_MS` (750 ms, engine.ts). */
async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false)
  await expect(offlineChip(page)).toBeHidden({ timeout: 15_000 })
}

// Reseed before every test — these tests MOVE mail, and `seedReadMail()` destroys the previous
// `wread` batch across ALL mailboxes first, so a message parked in Archive by one test is cleaned up
// rather than inherited by the next.
test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M3.10 offline', () => {
  test('GATE: the browser going offline reaches the app, and reaches the network', async ({
    page,
    context,
  }) => {
    await login(page)

    await context.setOffline(true)
    // The app's own read of the seam, not the test's opinion of it.
    await expect(offlineChip(page)).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)

    // …and the network is REALLY down. Without this the suite could pass against a browser that
    // merely reports `onLine: false` while happily serving requests, which would quietly turn every
    // "queues instead of dispatching" assertion below into a coincidence.
    const attempt = await page.evaluate(async () => {
      try {
        return `status ${(await fetch('/.well-known/jmap')).status}`
      } catch (error) {
        return `threw ${(error as Error).name}`
      }
    })
    expect(attempt).toBe('threw TypeError')

    await context.setOffline(false)
    await expect(offlineChip(page)).toBeHidden({ timeout: 15_000 })
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  })

  test('B2: offline, archiving a message and undoing it puts the row back — no reconnect', async ({
    page,
  }) => {
    // THE PAYOFF OF GAP B2, and the reason the gap was rescoped. Before M3.10 an offline archive
    // pruned the row locally but the UNDO only voided the window's baseline and waited for a
    // re-query — and offline there is nothing to re-query (`runReplay` puts the whole replay behind
    // `isOnline()`). So the row vanished instantly and did not come back until reconnect: the Undo
    // button worked and looked broken, which is worse than not working.
    //
    // TWO CORPUS CONSTRAINTS THIS TEST DEPENDS ON. Both hold today and neither is enforced by the
    // seeder, so they are asserted rather than assumed — a future seeder change must fail loudly
    // here instead of quietly making this test vacuous.
    //  1. `collapseThreads: true` is the default for every folder list, and `placeArrival` REFUSES
    //     to splice when the arriving message's thread is already represented in the window. The
    //     seeded "Q3 planning sync" thread has three messages, so archiving one of those and undoing
    //     it would hit that refusal and prove nothing. Use `plain`, a single-message thread.
    //  2. A tail insert is only legal on a COMPLETE window (`ids.length >= total`). The collapsed
    //     inbox is 5 rows against PAGE_SIZE 50, so every index is legal.
    await login(page)

    const before = await rowSubjects(page)
    expect(before[0]).toBe(`Re: ${READ_SUBJECTS.thread}`)
    expect(before[1]).toBe(READ_SUBJECTS.plain)
    expect(before.length).toBeLessThan(50)

    await goOffline(page)

    await selectRow(page, READ_SUBJECTS.plain)
    await bulkAction(page, 'Archive')
    await expect(page.getByText('Moved to Archive')).toBeVisible({ timeout: 15_000 })
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeHidden({
      timeout: 15_000,
    })

    await page.getByRole('button', { name: 'Undo' }).click()

    // Back on screen AND back in the right slot. `toBeVisible()` alone would accept a splice that
    // appended the row to the bottom of the list, which is precisely the bug the sort-key half of
    // `placeArrival` exists to prevent.
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(async () => (await rowSubjects(page))[1], { timeout: 15_000 })
      .toBe(READ_SUBJECTS.plain)
    expect(await rowSubjects(page)).toEqual(before)

    // The whole claim is "without reconnecting". If the browser had come back online at any point,
    // a server round-trip could have restored the row and this test would be measuring nothing.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    await expect(offlineChip(page)).toBeVisible()
  })

  test('an offline archive is not a lie: after reconnecting the server agrees', async ({
    page,
  }) => {
    // The other half of FR-OFF-03. The optimistic prune must survive the reconnect that follows it:
    // the message is really in Archive, it does not flicker back into the Inbox when the queued move
    // is replayed, and the re-query that follows does not duplicate it.
    await login(page)
    await goOffline(page)

    await selectRow(page, READ_SUBJECTS.plain)
    await bulkAction(page, 'Archive')
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeHidden({
      timeout: 15_000,
    })

    await goOnline(page)

    await page.getByRole('treeitem', { name: /Archive/ }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toHaveCount(1, {
      timeout: 20_000,
    })

    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.newsletter)).toBeVisible({
      timeout: 20_000,
    })
    // Held, not sampled once: the failure this guards against is a LATE `fullRequery` resurrecting
    // the row a second or two after the list first repaints, which an instant assertion would miss.
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    })
    await page.waitForTimeout(3000)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toHaveCount(0)
  })

  test('a send composed offline is queued, says so, and really leaves on reconnect', async ({
    page,
  }) => {
    // FR-OFF-03 / FR-CMP-08. `runReplay` puts the entire network half behind `if (online)`, so
    // offline the submission is persisted and NOT dispatched. The two surfaces that tell the user
    // this are the sticky toast (no auto-dismiss — an offline send may sit for hours) and the
    // durable chip, which is the only one that survives a reload.
    const token = `wread-offline-${Date.now()}`
    const bob = jmapAs('bob@waxwing.test')

    // PIN the undo grace instead of inheriting the deployment default. What this test asserts is
    // that a queued send LEAVES on reconnect; how long the app waits before dispatching is a
    // different question, answered by the "called back" test below (which deliberately waits the
    // full grace out). Inheriting it made this test's 30 s reconnect budget a function of
    // `public/config.json` — and it duly broke when that file was corrected from 10 s to the 15 s
    // the spec and `DEFAULT_CONFIG` both state.
    await setUndoGrace(page, 1)

    await login(page)

    // PRE-WARM THE LAZY CHUNK. `ComposerHost` is `React.lazy`, and the service worker deliberately
    // does not `clientsClaim()`, so on a first, uncontrolled page load the chunk is fetched from the
    // network — which offline fails with a chunk error rather than a queued send. Opening the
    // composer once while online resolves the module and `lazy()` caches it for the rest of the
    // page's life. This is deterministic in a way that "reload so the SW is in control" is not,
    // which is why it is done this way and not that way.
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
      timeout: 15_000,
    })
    await page.keyboard.press('Escape')

    await goOffline(page)

    await page.getByRole('button', { name: 'New message', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
      timeout: 15_000,
    })
    const to = page.getByRole('combobox', { name: 'To', exact: true })
    await to.click()
    await to.fill('bob@waxwing.test')
    await to.press('Enter')
    await page.getByLabel('Subject', { exact: true }).fill(token)
    const body = page.getByRole('textbox', { name: 'Message body' })
    await body.click()
    await page.keyboard.type('Queued while the line was down.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    // The sticky toast states the outcome in the user's words…
    await expect(page.getByText('You’re offline — this will send when you reconnect')).toBeVisible({
      timeout: 15_000,
    })
    // …and the durable chip is the one that is still there tomorrow.
    const queue = page.getByRole('status', { name: 'Queued messages' })
    await expect(queue).toContainText(token, { timeout: 15_000 })
    await expect(queue).toContainText('Will send when you’re back online')

    await goOnline(page)
    await expect(queue).toBeHidden({ timeout: 30_000 })

    // Verified at the SERVER, not in the app that queued it. Exactly one copy: the no-duplicate half
    // of the guarantee is the reason this polls for a count rather than for presence.
    await expect
      .poll(async () => (await bob.query(token, ['subject'])).length, { timeout: 30_000 })
      .toBe(1)

    // Clean up after ourselves: this message carries no `wread` keyword and lives in BOB's account,
    // so `seedReadMail()` will never reap it and it would accumulate one row per run forever.
    const delivered = await bob.query(token, ['subject'])
    const accountId = await bob.account()
    await bob.call(
      ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      [['Email/set', { accountId, destroy: delivered.map((email) => email.id) }, '0']],
    )
  })

  test('a queued offline send can still be cancelled from its chip', async ({ page }) => {
    // FR-CMP-08: cancellation is allowed for as long as the row is `pending` — i.e. while the
    // submission provably has not been dispatched — WHATEVER its age. That is deliberately not the
    // online undo-grace rule, which expires after a few seconds; offline the message may sit for
    // hours and the Cancel button must still be there when the user comes back to it.
    // Two deliberate real-time waits below (18 s past the grace, 8 s past the reconnect) put this
    // over the config's 60 s default with a login and a build-cold first paint in front of them.
    test.setTimeout(90_000)
    const token = `wread-cancel-${Date.now()}`
    const bob = jmapAs('bob@waxwing.test')

    await login(page)
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
      timeout: 15_000,
    })
    await page.keyboard.press('Escape')

    await goOffline(page)

    await page.getByRole('button', { name: 'New message', exact: true }).click()
    const to = page.getByRole('combobox', { name: 'To', exact: true })
    await to.click()
    await to.fill('bob@waxwing.test')
    await to.press('Enter')
    await page.getByLabel('Subject', { exact: true }).fill(token)
    const body = page.getByRole('textbox', { name: 'Message body' })
    await body.click()
    await page.keyboard.type('This one is called back.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    const queue = page.getByRole('status', { name: 'Queued messages' })
    await expect(queue).toContainText(token, { timeout: 15_000 })

    // WAIT OUT THE WHOLE UNDO GRACE, and mind the number: `undoSendSeconds` defaults to 15, so the
    // wait has to clear 15 s or it proves nothing at all. An earlier draft of this test waited 6 s,
    // which sits INSIDE the grace — it passed happily against a build that had been mutated to gate
    // Cancel on `notBefore`, because at 6 s that gate was still open. The margin is the assertion.
    //
    // Past this point `notBefore` has elapsed and the row is `pending` for exactly one reason: the
    // line is down and the submission provably has not been dispatched. `cancelSend` checks that and
    // deliberately checks nothing else — "there is deliberately NO `notBefore` check (M3.3)".
    await page.waitForTimeout(18_000)
    await queue.getByRole('button', { name: 'Cancel send' }).click()
    await expect(queue).toBeHidden({ timeout: 15_000 })

    await goOnline(page)

    // The cancellation has to hold ACROSS the reconnect — a queue that replays a cancelled send is
    // the failure this exists to catch, and it can only appear once the line is back.
    await page.waitForTimeout(8000)
    expect(await bob.query(token, ['subject'])).toEqual([])
  })

  test('B1: with "Unread first" on, marking a message read re-sorts it', async ({ page }) => {
    // GAP B1 — and note what is actually being claimed, because the plan's prose overstates it.
    // `resorted` does exactly one thing: it VOIDS the window's `queryState`. It does not re-order
    // `ids` locally. The row therefore moves when `reconcileQuery` takes its `fullRequery` branch,
    // which needs the server. What B1 bought is that the client re-queries PROACTIVELY, as soon as
    // the outbox drains, instead of waiting for the server's push StateChange to echo — so this is
    // an ONLINE assertion, and `outbox.ts`'s own block comment says so in as many words.
    //
    // WHY SSE IS BLOCKED, and this is the whole reason the test is shaped like this. B4 — shipped in
    // this same milestone — made push connect properly, and the server's echo now lands in ~100 ms.
    // Against a live SSE channel the re-sort therefore happens either way, and the first draft of
    // this test passed against a build with `resorted` mutated to `() => false`: the echo was doing
    // the work and the test was applauding B1 for it. B1 is only load-bearing when push is NOT
    // delivering — which is a real state (a server without SSE, or a channel that has failed over),
    // and is precisely the state B1 was written for.
    //
    // So the eventsource stream is aborted, the channel falls back to polling, and the earliest any
    // server-initiated echo can arrive is DEFAULT_POLL_INTERVAL_MS = 30 s (the safety sweep is 60 s).
    // A 15 s budget therefore sits below every path except the one under test, which makes the budget
    // itself the assertion. Do not loosen it and do not remove the abort — either one hands the test
    // back to the echo.
    // A RegExp, not a glob. The advertised URL is `/jmap/eventsource/?types=…` — note the slash
    // BEFORE the query string — and in a Playwright glob `*` does not cross a `/`, so the obvious
    // `**/jmap/eventsource*` silently matches nothing. That is not a hypothetical: it is what this
    // test did on its first run, and only the positive control below turned it into a failure
    // instead of a green test measuring the very thing it meant to rule out.
    const blockedPush: string[] = []
    await page.route(/\/jmap\/eventsource/, async (route) => {
      blockedPush.push(route.request().url())
      await route.abort()
    })

    await login(page)

    // POSITIVE CONTROL for the abort: if the route never matched, push would still be live and every
    // timing claim below would be measuring the echo again — silently, and in the passing direction.
    await expect.poll(() => blockedPush.length, { timeout: 20_000 }).toBeGreaterThan(0)

    // `.click()` and then wait, NOT `.check()`. The checkbox is a controlled React input whose
    // `checked` comes from a pref that lives in Dexie, so the click's effect only lands after an
    // IndexedDB round-trip — until then React re-renders the box back to unchecked, and `.check()`'s
    // synchronous "did the state change?" verification fails outright rather than retrying.
    // The view options live behind a disclosure in the pane toolbar now: they were four rows
    // permanently above every folder (156 px on a phone) for settings a user changes about as often
    // as their signature, so they are collapsed by default.
    await page.getByRole('button', { name: 'Show view options' }).click()
    const unreadFirst = page.getByRole('checkbox', { name: 'Unread first' })
    await unreadFirst.click()
    await expect(unreadFirst).toBeChecked({ timeout: 15_000 })

    // Flipping the toggle changes the WINDOW KEY, so the list backfills from the server as a fresh
    // query. Wait for the new order before touching read state, or the mark-read below races a list
    // that is still the old window.
    await expect
      .poll(async () => (await rowSubjects(page))[0], { timeout: 20_000 })
      .toBe(READ_SUBJECTS.plain)
    const sorted = await rowSubjects(page)
    // Unread on top (`hasKeyword $seen` ascending), each group by date descending. The seeder marks
    // the Q3 thread, the newsletter, the forwarded message and the PDF carrier as read; `plain` and
    // the phishing sample are the only unread ones.
    expect(sorted.slice(0, 2)).toEqual([READ_SUBJECTS.plain, READ_SUBJECTS.phishing])

    await selectRow(page, READ_SUBJECTS.plain)
    await bulkAction(page, 'Mark as read')

    // It leaves the unread block and lands among the read messages in date order — behind the
    // remaining unread row and behind the newer Q3 thread, ahead of the older newsletter.
    await expect
      .poll(async () => (await rowSubjects(page)).indexOf(READ_SUBJECTS.plain), { timeout: 15_000 })
      .toBe(2)
    expect(await rowSubjects(page)).toEqual([
      READ_SUBJECTS.phishing,
      `Re: ${READ_SUBJECTS.thread}`,
      READ_SUBJECTS.plain,
      READ_SUBJECTS.newsletter,
      READ_SUBJECTS.rfc822,
      // Oldest, and read: the PDF carrier the F2 preview test needs (seed-read.mjs `at(7)`).
      READ_SUBJECTS.pdf,
    ])
  })

  test('FR-OFF-04: the storage meter is real and "Free up space now" reaches the engine', async ({
    page,
  }) => {
    // SMOKE, deliberately. Both the engine's maintenance pass and the settings meter read
    // `navigator.storage.estimate()` through the same `browserEstimate` helper, so ONE override
    // pressures both — and it overrides a BROWSER API the app reads, not a production hook, which is
    // why no test-only seam had to be added to ship this.
    //
    // WHAT IS NOT ASSERTED, AND WHY. A pressured pass on this corpus frees NOTHING, by design:
    // `planEviction` clamps the pressured target at MIN_EVICTABLE_BYTES = 32 MB and the seeded cache
    // is kilobytes. "Nothing to free up" is therefore the CORRECT outcome here, not a failure — so
    // the assertion is the button → `runMaintenance({force:true})` → toast WIRING, matched against
    // either outcome. Asserting "Freed X" would need tens of MB of seeded attachments; proving the
    // eviction loop itself in a browser is a separate, slow spec and is filed rather than smuggled
    // into the read suite.
    await page.addInitScript(() => {
      Object.defineProperty(StorageManager.prototype, 'estimate', {
        configurable: true,
        value: async () => ({ usage: 95_000_000, quota: 100_000_000 }),
      })
    })
    await login(page)

    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await openSettingsSection(page, 'Offline & storage')

    // A real `<progress>` against the browser's real quota API — the override supplies the numbers,
    // the element and its plumbing are the app's.
    const meter = page.getByRole('progressbar', { name: 'Storage used' })
    await expect(meter).toBeVisible({ timeout: 15_000 })
    await expect(meter).toHaveAttribute('max', '100000000')
    await expect(page.getByText(/of .* used/)).toBeVisible()

    // The four-category breakdown, including the one that only exists when a quota IS reported.
    await expect(page.getByText('Message index (estimated)')).toBeVisible()
    // `exact` for the same reason as the line below: the templates section on this page
    // describes a template as a "Reusable message bodies…", which substring-matches.
    await expect(page.getByText('Message bodies', { exact: true })).toBeVisible()
    // `exact` matters: the same page carries an "Attachments per message" control further down.
    await expect(page.getByText('Attachments', { exact: true })).toBeVisible()
    await expect(page.getByText('Other (app & offline shell)')).toBeVisible()

    await page.getByRole('button', { name: 'Free up space now' }).click()
    await expect(page.getByText(/^(Freed |Nothing to free up)/)).toBeVisible({ timeout: 20_000 })
  })

  test('FR-OFF-04: with no quota reported the meter says so rather than inventing one', async ({
    page,
  }) => {
    // The honesty half. `browserEstimate` maps both a rejection and a zero quota to `null`, and the
    // section then states plainly that it does not know rather than inventing a denominator.
    //
    // NOTE WHAT DOES *NOT* DISAPPEAR, because it is a deliberate design choice and not a bug: the
    // `<progress>` bar stays. With no browser estimate the section meters the app's OWN accounting
    // against the configured cache budget — "the only ratio we can honestly draw", as the code says.
    // What goes is the "Other (app & offline shell)" row, and it goes for a principled reason: that
    // figure is only computable as the REMAINDER of a known total, so without a quota there is no
    // honest number to put there. Asserting the bar away would have been asserting the wrong thing.
    await page.addInitScript(() => {
      Object.defineProperty(StorageManager.prototype, 'estimate', {
        configurable: true,
        value: async () => {
          throw new Error('no quota here')
        },
      })
    })
    await login(page)

    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await openSettingsSection(page, 'Offline & storage')

    await expect(page.getByText('Your browser does not report a storage quota.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/of .* used/)).toHaveCount(0)
    await expect(page.getByText('Other (app & offline shell)')).toHaveCount(0)
    // POSITIVE CONTROLS for those two absences. Without them a settings page that failed to render
    // at all would score two clean zeroes and call itself honest. The breakdown row that does NOT
    // depend on a quota is still there, and so is the fallback meter described above.
    // `exact` for the same reason as the line below: the templates section on this page
    // describes a template as a "Reusable message bodies…", which substring-matches.
    await expect(page.getByText('Message bodies', { exact: true })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Storage used' })).toBeVisible()
  })

  test('a queued move whose folder was deleted dead-letters, and the user can discard it', async ({
    page,
  }) => {
    // THE OTHER HALF OF FR-OFF-03, and the half that had never once run in a browser: what happens
    // when a queued action can NEVER succeed. `StatusRegion`'s "still trying" notice is deliberately
    // actionless because those actions are not lost — only a DEAD LETTER asks the user to decide,
    // and that decision is `OutboxProblemsButton` → dialog → Try again / Discard.
    //
    // HOW THE CONFLICT IS FORCED, and it is worth reading because it looks impossible at first: the
    // browser is offline, so how does the folder get deleted underneath it? `context.setOffline`
    // isolates the BROWSER, not the test process. Node still talks to Stalwart on 127.0.0.1:18080
    // throughout. So the queued move sits in the outbox while the world moves on without it — which
    // is exactly the real scenario (another client, another device, a filter rule) and not a
    // contrivance. The chaos suite covers this at `folderGone`; what it fakes is the server that
    // rejects, which is the one thing that has to be real for the dialog to be worth anything.
    const alice = jmapAs('alice@waxwing.test')
    const mail = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
    const accountId = await alice.account()
    const created = await alice.call(mail, [
      ['Mailbox/set', { accountId, create: { doomed: { name: 'ZzDoomed', parentId: null } } }, '0'],
    ])
    // Indexed access is checked under this tsconfig, so unwrap deliberately rather than with `!`:
    // a seeder change that stops returning the mailbox should fail HERE with a sentence, not with a
    // `TypeError: undefined` thirty lines later inside the offline block.
    const createdMailbox = created.methodResponses[0]?.[1] as
      | { created?: Record<string, { id: string } | undefined> }
      | undefined
    const folderId = createdMailbox?.created?.doomed?.id
    expect(folderId, 'the fixture did not create the ZzDoomed mailbox').toBeTruthy()
    if (folderId === undefined) return

    try {
      await login(page)
      await expect(page.getByRole('treeitem', { name: /ZzDoomed/ })).toBeVisible({
        timeout: 20_000,
      })

      await goOffline(page)

      await selectRow(page, READ_SUBJECTS.plain)
      await bulkAction(page, 'Move to…')
      await page.getByRole('button', { name: 'ZzDoomed', exact: true }).click()
      await expect(messageList(page).getByText(READ_SUBJECTS.plain, { exact: true })).toBeHidden({
        timeout: 15_000,
      })

      // The world moves on while the move is still queued.
      await alice.call(mail, [['Mailbox/set', { accountId, destroy: [folderId] }, '0']])

      await goOnline(page)

      // The replay now fails in a way no retry can fix, so it dead-letters and the affordance
      // appears. It is hidden entirely while the queue is clean, which is what makes its presence
      // an assertion rather than a coincidence.
      const problems = page.getByRole('button', { name: /didn’t go through/ })
      await expect(problems).toBeVisible({ timeout: 30_000 })
      await problems.click()

      const dialog = page.getByRole('dialog', { name: 'Some actions didn’t go through' })
      await expect(dialog).toBeVisible({ timeout: 15_000 })
      // The message names the actual cause rather than a generic failure — `describeConflict`
      // mapping `folderGone` onto a sentence a person can act on is the point of the surface.
      await expect(dialog.getByText('Couldn’t move — that folder was deleted.')).toBeVisible()

      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()

      // Discarding the last dead letter empties the queue, so the button goes away again.
      await expect(problems).toBeHidden({ timeout: 15_000 })
    } finally {
      // Idempotent: the folder is normally already gone, but a failure ANYWHERE above must not leave
      // a stray folder in the tree for every later test in the run (`seedReadMail` reaps mail, never
      // mailboxes). `Mailbox/set destroy` on a missing id is a notDestroyed entry, not a throw.
      await alice
        .call(mail, [['Mailbox/set', { accountId, destroy: [folderId] }, '0']])
        .catch(() => undefined)
    }
  })
})

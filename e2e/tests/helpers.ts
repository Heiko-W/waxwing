import { expect, type Page } from '@playwright/test'

// Shared page-objects for the live suites (M2.9). Kept minimal + role-based so they track the app's
// accessible names, not brittle DOM structure.

export const CREDENTIALS = {
  alice: { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' },
  bob: { user: 'bob@waxwing.test', pass: 'waxwing-e2e-Pw1!' },
}

export const messageList = (page: Page) =>
  page.getByRole('region', { name: 'Messages', exact: true })

/**
 * How long a live suite may wait for something that has to come back from the server (B53).
 *
 * ## The measurement, and a hypothesis it killed
 * Across ten full `e2e:read` runs, individual tests span a factor of 10–50 between their fastest
 * and slowest run — `read.spec.ts`'s folder-role test took **2.4 s and 33.8 s**, the reorder test
 * **2.1 s and 33.2 s**, the nested-message test **0.6 s and 30.4 s** — while the suite's MEDIAN test
 * duration stays flat at 0.6–1.7 s and shows no upward trend across positions. So a 30 s budget was
 * below the observed maximum of tests that legitimately pass: the budget, not the app, decided the
 * outcome. That is what this constant fixes, and the justification is the measured spread — nothing
 * more.
 *
 * **It is NOT the throttle, and that was the first guess.** `stalwart/http.mjs` throttles the
 * seeders deliberately and gives the app under test no retry concession, so the obvious story was:
 * the app meets a 429, backs off on `SYNC_RETRY_BACKOFF` (`baseMs: 2_000, factor: 2`, cumulative
 * 2/6/14/30 s), and burns the budget before its fourth attempt. Measured instead, with the response
 * status of every `/jmap` call recorded across five runs of a login behind a full reseed:
 * **zero 429s, and the inbox rendered in 384–486 ms every time.** The app is not being throttled at
 * all. The backoff curve is real but never entered, so it explains nothing here and this constant
 * must not be read as being derived from it.
 *
 * ## Why 60 s
 * Twice the largest passing observation (33.8 s), which leaves room for the same spread to widen
 * somewhat without turning into a red run, and still keeps a genuine hang cheap to spot. It is NOT
 * a licence to paper over slowness: raising this instead of reading it would be the same mistake one
 * size larger — and note that a failure at the full 60 s is a DIFFERENT animal from one at 30 s,
 * because nothing measured here takes anywhere near that long.
 */
export const SYNC_BUDGET_MS = 60_000

/** `expect.poll` options for a server round-trip; same budget, same reasoning as {@link SYNC_BUDGET_MS}. */
export const SYNC_POLL: { timeout: number; intervals: number[] } = {
  timeout: SYNC_BUDGET_MS,
  intervals: [500, 1000, 1000, 2000],
}

/**
 * Override the app's `undoSendSeconds` for this page by intercepting `config.json` (deep-merged over
 * the built-in defaults, so branding/auth are untouched). Call BEFORE navigating.
 */
export async function setUndoGrace(page: Page, seconds: number): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { features: { undoSendSeconds: seconds } } }),
  )
}

/**
 * Reveal the password form. It is collapsed behind a disclosure whenever OAuth leads (a secure
 * context and `auth: ["oauth", ...]`), because only OAuth can carry a second factor — see
 * `LoginForm`. A fixture whose config lists Basic first, or a non-secure origin, renders the form
 * open and the trigger absent, so this is a no-op there rather than a failure.
 */
export async function revealPasswordForm(page: Page): Promise<void> {
  const disclosure = page.getByRole('button', {
    name: 'Sign in with a password instead',
    exact: true,
  })
  const username = page.getByLabel('Username', { exact: true })
  // Wait for the sign-in step to exist in EITHER shape first. A bare `isVisible()` resolves against
  // whatever is on screen at that instant — during the boot spinner that is neither, so the
  // disclosure went unclicked and the caller then waited out its timeout on a field that was never
  // going to appear.
  await expect(disclosure.or(username).first()).toBeVisible({ timeout: 30_000 })
  if (await disclosure.isVisible()) await disclosure.click()
}

/**
 * Basic sign-in (same-origin proxy → onboarding lands straight on the Basic step), then open Inbox.
 * `stay: true` checks "Stay signed in" so the session survives a `page.reload()` (draft-recovery test).
 */
export async function login(
  page: Page,
  creds = CREDENTIALS.alice,
  options: { stay?: boolean } = {},
): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(creds.user)
  await page.getByLabel('Password', { exact: true }).fill(creds.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await openFolder(page, /Inbox/)
}

/**
 * Open the Settings screen the way a user does — by clicking the nav rail.
 *
 * NOT `page.goto('/settings')`: that is a full page load, and `login()` does not tick "Stay signed
 * in", so a reload deliberately drops the session and lands back on the sign-in form (see the
 * cross-tab test, which passes `{ stay: true }` precisely because it depends on persistence).
 * Routing through the nav also exercises the lazy `/settings` chunk, which is the real path.
 */
export async function openSettings(page: Page, section?: string): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  if (section !== undefined) await openSettingsSection(page, section)
}

/**
 * Choose a settings section from the rail.
 *
 * Settings is master/detail since the 2026-08-19 pass: fourteen sections behind five groups, one
 * panel at a time. A test that wants a control has to say which panel it lives in — the same
 * sentence the reader has to say to themselves.
 */
export async function openSettingsSection(page: Page, section: string): Promise<void> {
  const rail = page.getByRole('navigation', { name: 'Settings' })
  await rail.getByRole('link', { name: section, exact: true }).click()
  await expect(page.getByRole('heading', { name: section, level: 2 })).toBeVisible()
}

/** Click a folder in the tree by name pattern. */
export async function openFolder(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('treeitem', { name }).click()
}

export async function openComposer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({ timeout: 15_000 })
}

/** Add a recipient pill to the To field (type + Enter commits it). */
export async function fillTo(page: Page, address: string): Promise<void> {
  const to = page.getByRole('combobox', { name: 'To', exact: true })
  await to.click()
  await to.fill(address)
  await to.press('Enter')
}

export async function fillSubject(page: Page, subject: string): Promise<void> {
  await page.getByLabel('Subject', { exact: true }).fill(subject)
}

export async function typeBody(page: Page, text: string): Promise<void> {
  await typeInEditor(page, 'Message body', text)
}

/**
 * Type into a rich-text editor by its accessible name.
 *
 * `locator.fill()` does NOT work here and never will: the editor is a Squire `contenteditable`, and
 * `fill()` sets the text without producing the input events Squire listens to — the React state
 * behind it never learns anything, so the value is silently dropped on save. Click and type, the way
 * a person does.
 */
export async function typeInEditor(page: Page, name: string, text: string): Promise<void> {
  const editor = page.getByRole('textbox', { name })
  await editor.click()
  await page.keyboard.type(text)
}

export async function clickSend(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

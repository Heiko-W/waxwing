import { expect, type Page } from '@playwright/test'

// Shared page-objects for the live suites (M2.9). Kept minimal + role-based so they track the app's
// accessible names, not brittle DOM structure.

export const CREDENTIALS = {
  alice: { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' },
  bob: { user: 'bob@waxwing.test', pass: 'waxwing-e2e-Pw1!' },
}

export const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })

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
 * Basic sign-in (same-origin proxy → onboarding lands straight on the Basic step), then open Inbox.
 * `stay: true` checks "Stay signed in" so the session survives a `page.reload()` (draft-recovery test).
 */
export async function login(
  page: Page,
  creds = CREDENTIALS.alice,
  options: { stay?: boolean } = {},
): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(creds.user)
  await page.getByLabel('Password', { exact: true }).fill(creds.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await openFolder(page, /Inbox/)
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
  const body = page.getByRole('textbox', { name: 'Message body' })
  await body.click()
  await page.keyboard.type(text)
}

export async function clickSend(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

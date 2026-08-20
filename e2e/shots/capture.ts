import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { revealPasswordForm } from '../tests/helpers'

/**
 * PNGs land here, NOT in `docs/site/shots/`. The published directory holds only the converted
 * WebP files, so a half-finished run cannot leave a 2 MB screenshot in the deployed site — and
 * `pnpm shots` is the only thing that writes there. The directory is gitignored.
 */
const OUT = fileURLToPath(new URL('./out/', import.meta.url))

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

export const SHOT_NAMES: string[] = []

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  // NOT `waitForLoadState('networkidle')`, which is what this tried first and which can never
  // resolve here: the sync engine holds an EventSource open for the lifetime of the session, so
  // the network is never idle and every shot times out at 90 s. Wait for the two things that
  // actually decide whether the pixels are final — webfonts (text reflows when they land) and one
  // paint after them.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled' })
  SHOT_NAMES.push(name)
}

/** Sign in. Deliberately NOT `tests/helpers.ts#login`: that one waits on the folder rail, which on
 *  a phone viewport is an off-canvas drawer with `visibility: hidden` — it never becomes visible,
 *  so the shared helper cannot serve the shots this run exists for. */
/** The message-list region. `exact` is load-bearing: the default substring match also matches
 *  the live-region labelled "Status messages", which is `visibility: hidden` by design — so the
 *  loose form waits 30 s and then fails on the wrong element. */
const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

export async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 })
}

/** Wait for a seeded subject to have synced into the list — the corpus arrives asynchronously. */
export async function waitForCorpus(page: Page, subject: string): Promise<void> {
  await expect(messageList(page).getByText(subject)).toBeVisible({ timeout: 30_000 })
}

/**
 * Wait for the message BODY, not just its heading. The body renders in a sandboxed iframe that
 * lays out after the surrounding pane, so a shot taken on the heading alone photographs a
 * correct-looking client with an empty white rectangle where the message should be.
 */
export async function waitForBody(page: Page, subject: string, text: string): Promise<void> {
  await expect(
    page.frameLocator(`iframe[title="Message: ${subject}"]`).getByText(text).first(),
  ).toBeVisible({ timeout: 15_000 })
}

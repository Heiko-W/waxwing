/**
 * The WebKit smoke suite (M5.15).
 *
 * Every other spec in this repo runs on Chromium, and that gap is not a matter of coverage
 * percentages — it hid two defects that made the app unusable on Safari, both of which passed the
 * entire Chromium suite:
 *
 *  1. **The mail screen did not render.** `distinctKeywords` read the `akw` index with Dexie's
 *     `uniqueKeys()`, which opens a `nextunique` key cursor; WebKit cannot open one on an EMPTY
 *     multiEntry index and fails the request with `UnknownError: Unable to open cursor`. Every
 *     account's FIRST paint has an empty index, and a mailbox that never receives mail has one
 *     forever, so the label rail threw into the route error boundary and replaced the whole screen —
 *     folder tree included — with "part of the app could not be loaded".
 *  2. **No link in a message opened.** WebKit delivers the outer page no click events at all from a
 *     sandboxed frame, so the interception the app opened links from never ran (see `frame.ts`).
 *     Clicking a link did nothing whatsoever.
 *
 * So this suite is deliberately small and deliberately about those two things: it exists to keep the
 * engine difference visible, not to re-test behaviour the Chromium suites already own. Add to it
 * only what genuinely differs BETWEEN engines.
 */

import { expect, test } from '@playwright/test'
import { READ_PHISHING, READ_SUBJECTS } from '../stalwart/seed-read.mjs'
import { login } from './helpers'

test('the mail screen renders — folders AND the label rail (empty akw index)', async ({ page }) => {
  await login(page)
  // `login()` already waits for the folder tree, which is half the proof: the boundary replaced the
  // whole screen, so a rendered tree means nothing threw beside it.
  await expect(page.getByText('Something went wrong')).toHaveCount(0)
  // The label rail is where it threw. It renders its own heading even with no labels at all, which
  // is exactly the state that broke: no cached mail yet ⇒ empty index ⇒ the cursor WebKit refuses.
  await expect(page.getByText('Labels', { exact: true })).toBeVisible({ timeout: 30_000 })
})

test('an honest link in a message opens in a new tab', async ({ page, context }) => {
  await login(page)
  await page.getByText(READ_SUBJECTS.phishing).first().click()
  const frame = page.frameLocator('iframe[title^="Message:"]')
  // The one link in that message whose text claims no host at all, so the gate releases it.
  const benign = frame.locator('a[target="_blank"]').first()
  await expect(benign).toBeVisible({ timeout: 30_000 })

  // Where it points is read off the anchor, not off the tab: the destination is a host that does not
  // resolve from the fixture, so the new page sits at `about:blank` with the navigation still
  // failing and `url()` answers "". A tab OPENING is the whole assertion — on Safari it did not.
  expect(await benign.getAttribute('href')).toBe(READ_PHISHING.benignTarget)
  const opened = context.waitForEvent('page', { timeout: 15_000 })
  await benign.click()
  const tab = await opened
  await tab.close()
})

/**
 * The other half, and the one that must never regress quietly: a link whose TEXT names one host
 * while its href goes to another is not released to the browser, so no `target` is ever put on it
 * and nothing opens.
 *
 * On Chromium the click is additionally intercepted and raises the interstitial; on WebKit no click
 * event reaches the app at all, so the reader gets silence instead of an explanation. Silence is a
 * poor answer and it is tracked as such — but it is the SAFE one, and this test pins the part that
 * matters: the deceptive link does not open.
 */
test('a deceptive link is not handed to the browser', async ({ page, context }) => {
  await login(page)
  await page.getByText(READ_SUBJECTS.phishing).first().click()
  const frame = page.frameLocator('iframe[title^="Message:"]')
  const deceptive = frame.locator('a:not([target])').first()
  await expect(deceptive).toBeVisible({ timeout: 30_000 })

  const before = context.pages().length
  await deceptive.click()
  await page.waitForTimeout(2000)
  expect(context.pages()).toHaveLength(before)
})

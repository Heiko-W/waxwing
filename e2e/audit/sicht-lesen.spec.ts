import { expect, test } from '@playwright/test'
import { check, shot, signIn } from './sicht-helpers'

/**
 * The reading pane, at all three widths — the surfaces the HIG round changed and no existing sweep
 * photographs.
 *
 * The phone case is the one that needs eyes on it. The action row (Reply, Reply all, Forward,
 * Trash, ⋯) used to be a plain block inside the scrolling conversation: in the top third when the
 * message opened, and off the screen entirely once it had been read. It is now the LAST child of
 * the article and sticks to the bottom edge. That is a change no assertion describes well —
 * "position: sticky" is in the stylesheet either way; what matters is whether the bar is on screen
 * with content under it and whether it reaches both edges of the pane.
 */

test('reading: the action bar, the message, and where they sit', async ({ page }) => {
  await signIn(page)
  // `signIn` already waits for the Messages region; the shell resolves a default folder on every
  // tier, so the list is on screen here at all three widths.
  await expect(page.getByRole('grid', { name: 'Messages' })).toBeVisible({ timeout: 30_000 })

  await page
    .getByRole('grid', { name: 'Messages' })
    .getByText('Quarterly report (PDF)', { exact: true })
    .first()
    .click()

  const bar = page.getByRole('toolbar', { name: 'Message actions' }).first()
  await expect(bar).toBeVisible({ timeout: 30_000 })
  await shot(page, 'lesen-aktionen')
  await check(page, 'reading with its action bar')

  // Where the bar actually is, in numbers, so the photograph has something beside it.
  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"]')
    const rect = toolbar?.getBoundingClientRect()
    return rect === undefined
      ? null
      : {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          viewport: { w: window.innerWidth, h: window.innerHeight },
        }
  })
  console.log(`[sicht] action bar: ${JSON.stringify(geometry)}`)

  // Scroll the message: on a phone the bar must still be there afterwards, which is the whole point.
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(300)
  await shot(page, 'lesen-nach-scrollen')
  const after = await page.evaluate(() => {
    const rect = document.querySelector('[role="toolbar"]')?.getBoundingClientRect()
    return rect === undefined ? null : { bottom: Math.round(rect.bottom), h: window.innerHeight }
  })
  console.log(`[sicht] action bar after scrolling: ${JSON.stringify(after)}`)

  /*
   * The MECHANISM, asserted rather than photographed.
   *
   * The fixture's messages are short, so nothing in this pane actually scrolls — and a sticky
   * element that has nothing to scroll sits exactly where it would have sat anyway. The photograph
   * above therefore shows the right layout for the wrong reason, and on its own it would keep
   * showing it after someone deleted the rule. The two facts that make the behaviour are: the row
   * is the LAST thing in the article (so `inset-block-end: 0` lifts it rather than pushing it down
   * into a gap), and it is `position: sticky`. Both are checked here; how it feels on a long real
   * message stays a device question, and the audit says so.
   */
  const mechanism = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"]')
    const article = toolbar?.closest('article')
    if (!toolbar || !article) return null
    const style = getComputedStyle(toolbar)
    return {
      last: article.lastElementChild === toolbar,
      position: style.position,
      bottom: style.insetBlockEnd,
      width: Math.round(toolbar.getBoundingClientRect().width),
      pane: Math.round((article.parentElement?.getBoundingClientRect().width ?? 0) * 10) / 10,
    }
  })
  console.log(`[sicht] action bar mechanism: ${JSON.stringify(mechanism)}`)
  if ((page.viewportSize()?.width ?? 0) < 640) {
    expect.soft(mechanism?.last, 'the action row is not the last thing in the article').toBe(true)
    expect.soft(mechanism?.position, 'the action row does not stick').toBe('sticky')
    expect.soft(mechanism?.bottom, 'the action row sticks to the wrong edge').toBe('0px')
  } else {
    // …and on the wider tiers it is exactly where it was: first under the header, in the flow.
    expect
      .soft(mechanism?.last, 'the action row moved on a tier that did not ask for it')
      .toBe(false)
    expect.soft(mechanism?.position, 'the action row should not stick here').toBe('static')
  }
})

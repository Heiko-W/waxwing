import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { noOverflow } from '../tests/no-overflow'

/** Where the sweep's evidence lands. One file per surface and width. */
const OUT = '/tmp/jmapgap/sicht'

export const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
}

/** Photograph the surface, named after the surface and the width, as the report references it. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await settle(page)
  const width = page.viewportSize()?.width ?? 0
  await page.screenshot({ path: `${OUT}/${name}-${width}.png`, animations: 'disabled' })
}

/**
 * Everything a surface owes at a width, in one call: nothing crosses the viewport edge, every
 * button reaches `--waxwing-control-min`, and any open dialog fits the viewport.
 *
 * Soft assertions throughout. A sweep that stops at the first defect only ever finds one, and the
 * point of walking twenty surfaces is the twentieth.
 */
export async function check(page: Page, where: string): Promise<void> {
  await settle(page)
  await test.step(`check ${where}`, async () => {
    await noOverflowSoft(page, where)
    await targetsSoft(page, where)
    await dialogFitsSoft(page, where)
    // Reported, not asserted: a long name that ellipsises is correct behaviour, and only the
    // screenshot beside it says whether THIS one had room it was not given.
    const cut = await truncated(page)
    if (cut.length > 0) console.log(`[sicht] ${where}: cut off — ${cut.join('; ')}`)
  })
}

async function noOverflowSoft(page: Page, where: string): Promise<void> {
  try {
    await noOverflow(page, where)
  } catch (error) {
    expect.soft(String(error), `${where}: overflow`).toBe('')
  }
}

/** `--waxwing-control-min` as the running context resolves it — 34 px fine, 44 px coarse. */
export async function controlMin(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.blockSize = 'var(--waxwing-control-min)'
    probe.style.position = 'absolute'
    document.body.append(probe)
    const size = probe.getBoundingClientRect().height
    probe.remove()
    return size
  })
}

/**
 * Controls that are DELIBERATELY smaller than the token, with the reason recorded.
 *
 * Same shape as `DESIGN_EXEMPT` in target-size.spec.ts and for the same reason: an exemption
 * without a stated reason is a defect somebody stopped looking at. Matched on the class name,
 * because these are decided by a rule in a stylesheet rather than by one label.
 */
const SIZE_EXEMPT: Record<string, string> = {
  chip: 'month-grid event chip: three plus a date have to fit one cell (calendar.module.css)',
  swatchInput: 'the 1px radio under a colour swatch; the LABEL is the target',
}

/**
 * Buttons and other pressables that fall short of the token.
 *
 * Text links inside a sentence and native checkboxes are left out for the reasons target-size.spec
 * gives: they are sized by the line they sit in, or by the browser.
 *
 * While a modal is open only the modal is measured. Everything behind it is `inert` to a reader,
 * and reporting it once per screen turns one finding into twenty copies of an old one.
 */
export async function undersizedTargets(page: Page): Promise<string[]> {
  const min = await controlMin(page)
  return page.evaluate(
    ({ token, exempt }) => {
      const out: string[] = []
      const selector = 'button, [role=button], summary, a[role=button]'
      const modal = document.querySelector('[aria-modal="true"]')
      const root: ParentNode = modal ?? document
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (!(el instanceof HTMLElement)) continue
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') continue
        if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') continue
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        if (style.display === 'inline') continue
        // CSS-module class names carry a hash: `_chip_1m59f_271`. Match the readable half.
        const classes = typeof el.className === 'string' ? el.className : ''
        if (Object.keys(exempt).some((name) => classes.includes(`_${name}_`))) continue
        if (box.height < token - 0.5 || box.width < token - 0.5) {
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)
          out.push(
            `"${label || el.tagName}" ${Math.round(box.width)}×${Math.round(box.height)} < ${token}`,
          )
        }
      }
      return [...new Set(out)]
    },
    { token: min, exempt: SIZE_EXEMPT },
  )
}

async function targetsSoft(page: Page, where: string): Promise<void> {
  expect.soft(await undersizedTargets(page), `${where}: below --waxwing-control-min`).toEqual([])
}

/** An open dialog that runs past the bottom (or the side) of the viewport, with nothing to scroll. */
export async function dialogOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('[role=dialog], dialog'))) {
      if (!(el instanceof HTMLElement)) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)
      // A box past the edge is only a defect when nothing inside it scrolls: a tall dialog with a
      // scrolling body is how a long form is meant to work on a phone.
      const scrollable = Array.from(el.querySelectorAll('*')).some((child) => {
        const cs = getComputedStyle(child)
        return /(auto|scroll)/.test(cs.overflowY) && child.scrollHeight > child.clientHeight + 1
      })
      const selfScrolls =
        /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
      if (box.bottom > window.innerHeight + 1 && !scrollable && !selfScrolls) {
        out.push(`"${label}" runs to ${Math.round(box.bottom)} past ${window.innerHeight}`)
      }
      if (box.top < -1 && !scrollable && !selfScrolls) {
        out.push(`"${label}" starts at ${Math.round(box.top)}`)
      }
    }
    return out
  })
}

async function dialogFitsSoft(page: Page, where: string): Promise<void> {
  expect.soft(await dialogOverflow(page), `${where}: dialog does not fit`).toEqual([])
}

/** Sign in and land in the Inbox. Phone folds the folder tree into a drawer. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  const disclosure = page.getByRole('button', {
    name: 'Sign in with a password instead',
    exact: true,
  })
  const username = page.getByLabel('Username', { exact: true })
  await expect(disclosure.or(username).first()).toBeVisible({ timeout: 30_000 })
  if (await disclosure.isVisible()) await disclosure.click()
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Messages', exact: true })).toBeVisible({
    timeout: 45_000,
  })
  /*
   * State what this run is measuring against, once, in the log.
   *
   * `--waxwing-control-min` is 34 px under `pointer: fine` and 44 px under `pointer: coarse`. A
   * project that forgot `hasTouch` reports the desktop number on a phone-sized viewport and every
   * touch-target finding it makes is about a screen nobody has. That mistake has been made here
   * before, so the number is printed rather than assumed.
   */
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  console.log(
    `[sicht] ${test.info().project.name}: pointer:coarse=${coarse}, --waxwing-control-min=${await controlMin(page)}px`,
  )
}

/** Follow a top-level destination from the main navigation (rail on wide, bottom bar on phone). */
export async function goTo(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click()
}

/**
 * Text that its own box has cut off — the defect a viewport sweep cannot see.
 *
 * Nothing overflows and nothing is undersized: a control added to a row takes the width from the
 * name beside it, the name ellipsises, and every edge is still where it belongs. The signal is
 * `scrollWidth > clientWidth` on a box that ellipsises, which is the browser saying "I dropped
 * some of this".
 *
 * Reported with the text so a caller can tell a genuinely long name (fine) from a short one being
 * squeezed (not fine).
 */
export async function truncated(page: Page, keepAtLeast = 0): Promise<string[]> {
  return page.evaluate((floor) => {
    const out: string[] = []
    const modal = document.querySelector('[aria-modal="true"]')
    const root: ParentNode = modal ?? document
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement)) continue
      const style = getComputedStyle(el)
      if (style.textOverflow !== 'ellipsis') continue
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (el.scrollWidth <= el.clientWidth + 1) continue
      // `keepAtLeast` separates "a long name ellipsised" from "a name squeezed by its neighbours".
      // 0 reports every cut; 0.5 reports only the ones that lost half of what they asked for.
      if (el.clientWidth / el.scrollWidth >= floor && floor > 0) continue
      const text = (el.textContent ?? '').trim()
      if (text === '') continue
      out.push(`"${text.slice(0, 40)}" cut to ${el.clientWidth}px of ${el.scrollWidth}px`)
    }
    return [...new Set(out)]
  }, keepAtLeast)
}

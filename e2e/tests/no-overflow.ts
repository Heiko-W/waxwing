import { expect, type Page } from '@playwright/test'

/**
 * Nothing rendered may cross the viewport's edges.
 *
 * Measured over every element rather than a named few, because the defects this catches are in
 * components no test would have thought to name — a header that measured 412 px against a 390 px
 * viewport, and a navigation label that started at x = -1 because German needed 72 px where the
 * rail gave it 40.
 *
 * An element ENTIRELY outside is fine and is how the closed drawer works
 * (`transform: translateX(-100%)`); the failure is a box that is partly on screen and partly not,
 * which is what a cut-off control is.
 *
 * Extracted from `narrow.spec.ts` so the sweep can run at more than one width. It was written for
 * 390 px and lived there, which is exactly why the rail defect survived: that label is a BOTTOM BAR
 * at 390 px and only becomes a side rail at 40em, so the one viewport the sweep ran at was the one
 * viewport where the bug could not appear.
 */
export async function noOverflow(page: Page, where: string): Promise<void> {
  // Transitions move boxes. A rect read mid-slide is neither where it was nor where it is going.
  await page.waitForTimeout(400)
  const width = page.viewportSize()?.width ?? 0
  const escaping = await page.evaluate(() => {
    window.scrollTo(0, 0)
    const w = window.innerWidth
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')
        continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right <= 0 || r.left >= w) continue // entirely off-canvas: by design
      if (r.right > w + 1 || r.left < -1) {
        const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''
        const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
        out.push(
          `${el.tagName.toLowerCase()}.${cls} "${label}" [${Math.round(r.left)}…${Math.round(r.right)}]`,
        )
      }
    }
    return [...new Set(out)]
  })
  expect(escaping, `${where}: elements cross the ${width}px viewport edge`).toEqual([])
}

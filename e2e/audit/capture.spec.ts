import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

/**
 * TEMPORARY UI-audit capture (not committed, not part of any gate). One signed-in session walks the
 * app and photographs every screen at the project's viewport, plus a small measurement report:
 * how much of the viewport is chrome before the first message, and which controls fall below the
 * 44 px touch minimum FR-A11Y-01 asks for.
 */

const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const measurements: Record<string, unknown> = {}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(450)
}

async function shot(page: Page, name: string): Promise<void> {
  const project = test.info().project.name
  mkdirSync(`${OUT}${project}`, { recursive: true })
  await settle(page)
  await page.screenshot({ path: `${OUT}${project}/${name}.png`, animations: 'disabled' })
}

const messageList = (page: Page) => page.getByRole('grid', { name: 'Nachrichten' })

/** Open a message by its subject. `exact` + `.first()`: the preview line of a phishing mail repeats
 *  its own subject, so the loose form is a strict-mode violation. */
async function openMessage(page: Page, subject: string): Promise<void> {
  await messageList(page).getByText(subject, { exact: true }).first().click()
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Benutzername', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Passwort', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('checkbox', { name: 'Angemeldet bleiben' }).check()
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  // NOT the folder navigation: on a phone it is an off-canvas drawer with `visibility: hidden`, so
  // it is absent from the accessibility tree and no role query can ever see it.
  await expect(page.getByRole('region', { name: 'Nachrichten' })).toBeVisible({ timeout: 30_000 })
}

/** Open the Inbox — on a phone that means opening the drawer first. */
async function openInbox(page: Page): Promise<void> {
  const toggle = page.locator('#waxwing-folder-toggle')
  if (await toggle.isVisible()) await toggle.click()
  await page.getByRole('treeitem', { name: /Posteingang/ }).click()
  // The drawer closes on a SELECTION CHANGE. Tapping the folder that is already open changes
  // nothing, so it stays open -- which is how the search shot ended up photographing the drawer.
  if (await toggle.isVisible()) await page.keyboard.press('Escape')
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Lunch on Thursday?')).toBeVisible({ timeout: 30_000 })
}

/** How much of the viewport is spent on chrome rather than on mail. */
async function measureChrome(page: Page, key: string): Promise<void> {
  const data = await page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]')
    const nav = document.querySelector('nav[aria-label="Hauptnavigation"]')
    if (!grid) return null
    const g = grid.getBoundingClientRect()
    const vh = window.innerHeight
    // The bottom bar only exists on the phone; on the desktop rail it is a side column.
    const navRect = nav?.getBoundingClientRect()
    const bottom = navRect && navRect.top > vh / 2 ? Math.round(vh - navRect.top) : 0
    const bands: { name: string; top: number; h: number }[] = []
    const add = (name: string, el: Element | null | undefined) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.height > 0) bands.push({ name, top: Math.round(r.top), h: Math.round(r.height) })
    }
    add('header', document.querySelector('header'))
    add('Ordner-Knopf-Zeile', document.getElementById('waxwing-folder-toggle')?.parentElement)
    add('Suche', document.querySelector('search'))
    for (const s of Array.from(document.querySelectorAll('select'))) {
      add(`select "${s.getAttribute('aria-label') ?? ''}"`, s.closest('div'))
    }
    return {
      viewport: { w: window.innerWidth, h: vh },
      controlMin: getComputedStyle(document.documentElement)
        .getPropertyValue('--waxwing-control-min')
        .trim(),
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      chromeAboveList: Math.round(g.top),
      chromeBelowList: bottom,
      listHeight: Math.round(g.height),
      chromePercent: Math.round(((g.top + bottom) / vh) * 100),
      bands,
    }
  })
  if (data) measurements[key] = data
}

/** Controls below the 44 px touch minimum, with the gap to their nearest neighbour. */
async function measureTargets(page: Page, key: string): Promise<void> {
  const data = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], input, select'),
    )
    const vh = window.innerHeight
    const vw = window.innerWidth
    const boxes = els
      .map((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
          tag: el.tagName.toLowerCase(),
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.left),
          y: Math.round(r.top),
          hidden: cs.visibility === 'hidden' || cs.display === 'none',
        }
      })
      .filter((b) => !b.hidden && b.w > 0 && b.h > 0 && b.y >= 0 && b.y < vh && b.x < vw)
    return {
      total: boxes.length,
      under44: boxes.filter((b) => b.w < 44 || b.h < 44),
      under24: boxes.filter((b) => b.w < 24 || b.h < 24),
    }
  })
  measurements[key] = data
}

test.describe.configure({ mode: 'serial' })

test('capture', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/')
  await shot(page, '01-anmeldung')

  await signIn(page)
  await shot(page, '02-nach-anmeldung')
  await measureChrome(page, `${test.info().project.name}/nach-anmeldung`)

  // The folder drawer, open (phone) — on the desktop the rail is already in shot 02.
  const toggle = page.locator('#waxwing-folder-toggle')
  if (await toggle.isVisible()) {
    await toggle.click()
    await shot(page, '03-ordner-drawer')
    await page.keyboard.press('Escape')
  }

  await openInbox(page)
  await shot(page, '04-posteingang')
  await measureChrome(page, `${test.info().project.name}/posteingang`)
  await measureTargets(page, `${test.info().project.name}/ziele-posteingang`)

  // Selection / bulk bar.
  await page.getByRole('checkbox', { name: 'Nachricht auswählen' }).first().check()
  await shot(page, '05-auswahl-massenleiste')
  await page.keyboard.press('Escape')
  await page.getByRole('checkbox', { name: 'Nachricht auswählen' }).first().uncheck()

  // Reading: plain, phishing, attachment.
  await openMessage(page, 'Lunch on Thursday?')
  await shot(page, '06-lesen-einfach')
  await measureTargets(page, `${test.info().project.name}/ziele-lesen`)

  await page.goBack()
  await expect(messageList(page)).toBeVisible()
  await openMessage(page, 'Your account needs verification')
  await shot(page, '07-lesen-phishing')

  await page.goBack()
  await expect(messageList(page)).toBeVisible()
  await openMessage(page, 'Quarterly report (PDF)')
  await shot(page, '08-lesen-anhang')

  // Composer, empty and as a reply.
  await page.getByRole('button', { name: 'Neue Nachricht' }).click()
  await shot(page, '09-verfassen-neu')
  await measureTargets(page, `${test.info().project.name}/ziele-verfassen`)
  await page.getByRole('button', { name: 'Entwurf verwerfen' }).click()
  const confirm = page.getByRole('button', { name: /Verwerfen|Löschen/ }).last()
  if (await confirm.isVisible().catch(() => false)) await confirm.click()

  await page.getByRole('button', { name: 'Antworten', exact: true }).first().click()
  await shot(page, '10-verfassen-antwort')
  await page.getByRole('button', { name: 'Schließen' }).first().click()

  // Search.
  await page.goBack().catch(() => {})
  await openInbox(page).catch(() => {})
  const search = page.getByRole('searchbox', { name: 'Suchen' })
  await search.fill('report')
  await search.press('Enter')
  await page.waitForTimeout(1500)
  await shot(page, '11-suche')
  await measureChrome(page, `${test.info().project.name}/suche`)

  // Account menu + command palette.
  await page.getByRole('button', { name: 'Konto' }).click()
  await shot(page, '12-kontomenue')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Befehlspalette/ }).click()
  await page.waitForTimeout(600)
  await shot(page, '13-befehlspalette')
  await page.keyboard.press('Escape')

  // Settings + contacts.
  await page.getByRole('link', { name: 'Einstellungen' }).click()
  await page.waitForTimeout(1200)
  await shot(page, '14-einstellungen')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await shot(page, '15-einstellungen-unten')

  await page.getByRole('link', { name: 'Kontakte' }).click()
  await page.waitForTimeout(1200)
  await shot(page, '16-kontakte')

  // Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('link', { name: 'E-Mail' }).click()
  await openInbox(page).catch(() => {})
  await shot(page, '17-dunkel-posteingang')
  await openMessage(page, 'Lunch on Thursday?')
  await shot(page, '18-dunkel-lesen')

  mkdirSync(OUT, { recursive: true })
  writeFileSync(
    `${OUT}messungen-${test.info().project.name}.json`,
    JSON.stringify(measurements, null, 2),
  )
})

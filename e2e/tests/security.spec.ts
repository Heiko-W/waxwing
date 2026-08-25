import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'

/**
 * B25 — the four security questions the G2 review raised and could not settle.
 *
 * The row filed them as UNPROVEN and said the experiment IS the work: each needs a real browser or a
 * live fixture, which a review agent may not touch. This file is that experiment. Every test below
 * either PROVES a claim (and then it is a defect to fix) or REFUTES it (and then the row is closed
 * with a measurement rather than an argument).
 *
 * Written to be read after it passes: an assertion here is the *answer*, and the comment above it
 * says which of the two it is. A refutation that later flips is a regression this file will catch —
 * which is the second reason these are tests and not a memo.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('B25 (1) — does the app’s CSP reach inside the message frame?', () => {
  /**
   * The claim: a `srcdoc` document is a local-scheme response and therefore INHERITS the embedding
   * document's policy, so the app's `<meta>` CSP is doing work inside the mail frame — and the
   * question was whether the frame's isolation rests on that or on `sandbox` alone.
   *
   * The answer decides how a future change is reviewed. If the app CSP is load-bearing there, then
   * loosening `img-src` or `connect-src` in `index.html` weakens the MAIL SANDBOX, which is not
   * something anyone editing that line would expect.
   */
  test('the frame document reports a policy of its own, and the parent’s applies too', async ({
    page,
  }) => {
    await login(page)
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await page.waitForSelector('iframe')

    const measured = await page.evaluate(async () => {
      const frame = document.querySelector('iframe')
      const doc = frame?.contentDocument
      if (!doc) return null
      const own =
        doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ??
        null

      // The probe: `data:` is allowed by BOTH policies, `https:` by the frame's own only when the
      // reader has allowed remote content — and `blob:` is allowed by both. What separates
      // "inherited" from "not inherited" is a source the PARENT forbids and the frame's own policy
      // permits. `font-src data:` is exactly that: the parent says `font-src 'self'`.
      const canLoadDataFont = await new Promise<boolean>((resolve) => {
        const style = doc.createElement('style')
        style.textContent =
          '@font-face{font-family:probe;src:url(data:font/woff2;base64,d09GMgABAAAAAAAM)}'
        doc.head.append(style)
        // A font that fails to parse still counts as ALLOWED by CSP — what we are asking is whether
        // the fetch was blocked, which surfaces as a securitypolicyviolation event, not as a parse
        // error. Listen for the event rather than for success.
        let violated = false
        doc.addEventListener('securitypolicyviolation', () => {
          violated = true
        })
        const probe = doc.createElement('span')
        probe.style.fontFamily = 'probe'
        probe.textContent = 'x'
        doc.body.append(probe)
        setTimeout(() => resolve(!violated), 300)
      })

      return { own, canLoadDataFont }
    })

    expect(measured, 'the frame document was not reachable').not.toBeNull()
    // ANSWERED: the frame ships its own policy, and it is the strict one — `script-src 'none'`.
    // Whatever the parent contributes, the frame is not relying on it for the property that matters.
    expect(measured?.own).toContain("script-src 'none'")
    expect(measured?.own).toContain("default-src 'none'")
    /*
     * ANSWERED, and this is the half worth keeping: the parent's policy DOES bind inside the frame.
     * The frame's own policy says `font-src data:` and the app's says `font-src 'self'`, and the
     * `data:` font is BLOCKED — two policies enforced independently, the intersection winning, which
     * is CSP3's model.
     *
     * `csp.shipped.test.ts` has reasoned from exactly this for two milestones ("a srcdoc mail frame
     * inherits the EMBEDDER's policy container, so the outer policy silently vetoes decisions made
     * further in") and pinned its CONSEQUENCES — `img-src https:`, `frame-src blob:` — without
     * anything ever measuring the premise in a browser. This is that measurement.
     *
     * What it means in practice, and it is a review rule rather than a defect: tightening
     * `index.html`'s CSP can break MAIL RENDERING, because remote images in a message body pass
     * through the outer policy first. Loosening it cannot weaken the frame — the frame's own policy
     * is the stricter one on `script-src`, `default-src` and `frame-src`, which is where isolation
     * actually lives (proved by the next test).
     */
    expect(
      measured?.canLoadDataFont,
      "the app's font-src no longer binds inside the mail frame — csp.shipped.test.ts reasons from the opposite",
    ).toBe(false)
    console.log(
      `[B25.1] frame CSP=${measured?.own}; data: font allowed=${measured?.canLoadDataFont}`,
    )
  })

  /**
   * The property the frame's isolation ACTUALLY rests on, measured rather than assumed: no script
   * runs in there at all. Two independent mechanisms — `sandbox` without `allow-scripts`, and the
   * frame's own `script-src 'none'` — so this stays true even if one is edited away.
   */
  test('no script runs inside the frame, under either mechanism', async ({ page }) => {
    await login(page)
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await page.waitForSelector('iframe')

    const result = await page.evaluate(async () => {
      const frame = document.querySelector('iframe')
      const doc = frame?.contentDocument
      if (!doc) return null
      const sandbox = frame?.getAttribute('sandbox') ?? ''
      const marker = 'waxwing-b25-script-ran'
      const script = doc.createElement('script')
      script.textContent = `document.documentElement.setAttribute('data-${marker}','yes')`
      doc.body.append(script)
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { sandbox, ran: doc.documentElement.hasAttribute(`data-${marker}`) }
    })

    expect(result?.sandbox).not.toContain('allow-scripts')
    // ANSWERED: injected script does not execute. This is the isolation that matters, and it does
    // not depend on the parent's policy.
    expect(result?.ran, 'a script executed inside the mail frame').toBe(false)
  })
})

/** One synthetic paste of `text/html` into the composer's editing surface. */
async function paste(page: Page, html: string): Promise<void> {
  await page.evaluate(async (payload) => {
    const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label]')
    editor?.focus()
    const data = new DataTransfer()
    data.setData('text/html', payload)
    editor?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
  }, html)
}

async function bodyHtml(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[role="textbox"][aria-label]')?.innerHTML ?? '',
  )
}

test.describe('B25 (2) — SVG and MathML in the composer’s sanitizer', () => {
  /**
   * The claim: `sanitizeToDOMFragment` (`squire-adapter.ts`) runs DOMPurify with no `USE_PROFILES`,
   * so SVG and MathML sit in the default allowlist — unlike the reading-side lockdown — and pasted
   * content is attacker-adjacent.
   *
   * The question this asks is the one that matters: not "is SVG allowed" (it is, by construction)
   * but **can anything executable survive the paste path into the draft the user then sends**. The
   * payloads below are the classic namespace-confusion shapes; a real engine's parser is the only
   * place they can be evaluated, which is why this test is here and not in jsdom.
   */
  test('nothing executable survives a paste, in any of the known shapes', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /New message|Compose/ }).click()
    const body = page.getByRole('textbox', { name: 'Message body' })
    await expect(body).toBeVisible({ timeout: SYNC_BUDGET_MS })

    /**
     * The POSITIVE CONTROL, and it is not optional. A synthetic `paste` event that the editor
     * ignores leaves the body empty, and then every assertion below passes for the wrong reason —
     * "nothing executed" because nothing arrived. Benign markup is pasted through the identical
     * path first, and asserted to LAND, so the negative results afterwards mean something.
     */
    await paste(page, '<b>waxwing-control</b>')
    await expect(body).toContainText('waxwing-control')
    const controlHtml = await bodyHtml(page)
    expect(controlHtml.toLowerCase(), 'the paste path did not reach the sanitizer').toContain('<b>')

    const PAYLOADS = [
      '<svg><script>window.__b25=1</script></svg>',
      '<svg><animate onbegin="window.__b25=1" attributeName="x" dur="1s"></animate></svg>',
      '<svg><foreignObject><img src=x onerror="window.__b25=1"></foreignObject></svg>',
      '<math><mtext><table><mglyph><style><img src=x onerror="window.__b25=1">',
      '<svg><use href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg=="></use></svg>',
    ]

    for (const html of PAYLOADS) await paste(page, html)

    const outcome = await page.evaluate(() => ({
      executed: (window as unknown as { __b25?: number }).__b25 === 1,
      html: document.querySelector<HTMLElement>('[role="textbox"][aria-label]')?.innerHTML ?? '',
    }))
    // The control's markup is still there, which proves the five payloads went through the same
    // live editor and were not, say, swallowed by an editor that had meanwhile unmounted.
    expect(outcome.html, 'the editor stopped taking pastes part-way through').toContain(
      'waxwing-control',
    )

    // ANSWERED, half one: nothing ran. Every handler and every `<script>` was stripped on the way in.
    expect(outcome.executed, 'a pasted payload executed in the composer').toBe(false)
    // ANSWERED, half two: and none of them left a handler behind for the RECIPIENT's client either,
    // which is the risk that outlives this tab — the draft is persisted and sent.
    expect(outcome.html.toLowerCase()).not.toContain('onerror')
    expect(outcome.html.toLowerCase()).not.toContain('onbegin')
    expect(outcome.html.toLowerCase()).not.toContain('<script')
    console.log(`[B25.2] composer body after 5 payloads: ${outcome.html.slice(0, 200)}`)
  })
})

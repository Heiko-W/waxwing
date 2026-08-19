import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { DIST_B, SERVED_ROOT, stageBuildA } from '../pwa-build.mjs'
import { ACCOUNTS, jmapAs } from '../stalwart/seed-write.mjs'
import { fillTo, openComposer, revealPasswordForm, typeBody } from './helpers'

/**
 * M3.10 DEPLOY suite (FR-DEP-04, FR-OFF-01; handed over from M3.5).
 *
 * The two promises a static-only webmail client makes to whoever hosts it:
 *
 *   1. **Rebrand without a rebuild.** Edit `config.json` / `manifest.json` in the deployed
 *      directory and the next load picks it up. This is why those files are runtime-cached
 *      NetworkFirst and never precached (sw-routes.ts `NEVER_PRECACHE`) — a precached copy would
 *      pin a hoster's branding to whichever release happened to build it.
 *   2. **A deploy never yanks the rug.** A new build offers itself in a sticky toast and waits.
 *      `sw.ts` calls neither `skipWaiting()` nor `clientsClaim()` precisely so a live tab keeps its
 *      own precache — activating under it would 404 its next lazy chunk. And when the user does
 *      accept, open drafts are flushed BEFORE the reload, because autosave is a 3 s idle debounce
 *      and everything typed inside that window exists nowhere but the DOM.
 *
 * Runs under playwright.deploy.config.ts, which serves a directory this suite rewrites underneath
 * the running server. See that config for why no existing harness can host these tests.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** `use-draft-autosave.ts` AUTOSAVE_DEBOUNCE_MS. Duplicated because e2e cannot import app source. */
const AUTOSAVE_DEBOUNCE_MS = 3000

/**
 * The product name the SERVED root carries before any test edits it.
 *
 * ── A TRAP, WRITTEN DOWN WHERE IT WOULD BE SPRUNG ────────────────────────────────────────────
 * The shipped `apps/web/public/config.json` sets `branding.productName` to `"Waxwing"`, which is
 * BYTE-IDENTICAL to `DEFAULT_CONFIG.branding.productName` in `apps/web/src/app/config.ts`. So an
 * assertion that the title is "Waxwing" passes whether config.json was fetched and applied or the
 * app never found it and silently fell back to its built-in defaults. It proves NOTHING, and it
 * looks like it proves everything — the same shape as the M3.5 defect where a test kept passing
 * after its deadline was deleted.
 *
 * The fix is to give this suite's root a name that cannot be produced by the fallback path, and to
 * do it HERE rather than by changing the shipped config: altering what users get in order to make a
 * test meaningful would be the tail wagging the dog.
 */
const STAGED_PRODUCT = 'Waxwing Staging Origin'

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
}

/** Rewrite a JSON file in the SERVED directory — a hoster editing a deployed file. */
function editServedJson(name: string, patch: (json: Record<string, unknown>) => void): void {
  const path = resolve(SERVED_ROOT, name)
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  patch(json)
  writeFileSync(path, JSON.stringify(json, null, 2))
}

/**
 * Reload, and come back with the page under the worker's control.
 *
 * A freshly registered worker never controls the page that registered it — no `clientsClaim()` — so
 * until this happens the worker's fetch handler has not run once and no route below has been
 * exercised. Gate on `controller`, not on `ready`: `ready` resolves on an ACTIVE worker and says
 * nothing about THIS page being controlled, which is the same distinction `register-sw.ts` encodes
 * as `isStale()`.
 */
async function reloadIntoServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}))
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 15_000,
    })
    .toBe(true)
}

/**
 * Which build is serving this page: `undefined` for A, `'b'` for the staged deploy.
 *
 * The catch is required, not defensive dressing. This is polled across the very reload the update
 * toast triggers, and `page.evaluate` throws "Execution context was destroyed" if it lands mid
 * navigation — which it did, on the first run of this suite. Returning a SENTINEL rather than
 * `undefined` is the careful part: `undefined` is a meaningful answer here (it means "build A"), so
 * swallowing a navigation error into it would let "still on the old build" and "could not look"
 * become the same result, and the assertions above that expect `undefined` would then pass while
 * blind.
 */
const NAVIGATING = '<navigating>'
const runningBuild = async (page: Page): Promise<string | undefined> => {
  try {
    return await page.evaluate(
      () => (globalThis as { __WAXWING_STAGED_BUILD__?: string }).__WAXWING_STAGED_BUILD__,
    )
  } catch {
    return NAVIGATING
  }
}

/**
 * Everything in the replica's local `drafts` store, as one string.
 *
 * Read straight out of IndexedDB rather than through the UI: a draft flushed milliseconds before a
 * reload is, by design, in the local store and nowhere else yet, and no screen in the app lists a
 * local-only pending draft. Going through Dexie's own API is not an option either — this is the
 * page's database, not the test's.
 */
async function localDraftContents(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open('waxwing-replica')
        open.onerror = () => resolve('')
        open.onsuccess = () => {
          try {
            const all = open.result.transaction('drafts', 'readonly').objectStore('drafts').getAll()
            all.onsuccess = () => resolve(JSON.stringify(all.result))
            all.onerror = () => resolve('')
          } catch {
            resolve('')
          }
        }
      }),
  )
}

/** Copy build B over the served root — a hoster uploading a new release. */
function deployBuildB(): void {
  // Overwrite rather than replace: a static host normally leaves the previous release's
  // content-addressed chunks in place, and a live tab that has not accepted the update yet still
  // needs them. Modelling a destructive deploy here would test a scenario the design explicitly
  // protects against, and would do it by breaking the fixture rather than the product.
  cpSync(DIST_B, SERVED_ROOT, { recursive: true, force: true })
}

test.beforeEach(() => {
  // The served root is shared mutable state — every test starts from build A with the staged
  // product name, whatever the previous test left behind.
  stageBuildA()
  editServedJson('config.json', (json) => {
    ;(json.branding as Record<string, unknown>).productName = STAGED_PRODUCT
  })
})

test.describe('M3.10 deploy', () => {
  test('a hoster edits config.json and manifest.json in place — branding changes, no rebuild', async ({
    page,
    context,
  }) => {
    await page.goto('/')

    // The BASELINE, and the reason STAGED_PRODUCT exists — see its comment. This assertion is what
    // makes every later one non-vacuous: it can only pass if config.json was actually fetched,
    // parsed and applied, because no fallback path in the app can produce this string.
    await expect(page).toHaveTitle(STAGED_PRODUCT)

    await reloadIntoServiceWorkerControl(page)

    // Now the worker is in the loop, and `config.json` has been served from its NetworkFirst cache
    // at least once. This is the state in which a naive precache would freeze the branding forever.
    await expect(page).toHaveTitle(STAGED_PRODUCT)

    editServedJson('config.json', (json) => {
      const branding = json.branding as Record<string, unknown>
      branding.productName = 'Acme Mail'
      branding.accentColor = '#ff00aa'
    })
    editServedJson('manifest.json', (json) => {
      json.name = 'Acme Mail'
      json.short_name = 'Acme'
    })

    await page.reload()

    // `applyBranding` (app/theme.ts) writes both of these at boot from the fetched config.
    await expect(page).toHaveTitle('Acme Mail')
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--waxwing-accent').trim(),
      ),
    ).toBe('#ff00aa')

    // The manifest has NO DOM projection at all — nothing in the page reflects it, so the only
    // honest way to see what the browser parsed is to ask the browser. `Page.getAppManifest` is a
    // CDP call and therefore CHROMIUM-ONLY; this assertion does not exist on other engines, and
    // that is a limit of the harness rather than of the product. (WebKit was deliberately dropped
    // from M3.10: it exposes no install API whatsoever — `beforeinstallprompt` is Chromium's own
    // non-standard event — so there is no cross-engine installability assertion to be had.)
    const cdp = await context.newCDPSession(page)
    const manifest = (await cdp.send('Page.getAppManifest')) as {
      errors?: { message: string }[]
      data?: string
    }
    await cdp.detach()
    expect(manifest.errors ?? []).toEqual([])
    expect(JSON.parse(manifest.data ?? '{}')).toMatchObject({
      name: 'Acme Mail',
      short_name: 'Acme',
    })
  })

  test('a staged deploy offers a sticky toast, and accepting it lands on the new build', async ({
    page,
  }) => {
    await login(page, { stay: true })

    // ── THE ABSENCE HALF, AND WHY IT NEEDS THE `ready` GATE ──────────────────────────────────
    // No toast may be offered to an UNCONTROLLED page. `register-sw.ts`'s `isStale()` refuses one
    // because `skipWaiting()` only re-parents clients the OUTGOING worker controlled — this page
    // has no outgoing worker, so it would never get its `controllerchange`, never reload, and the
    // toast would be a button that does nothing. Awaiting `ready` first is load-bearing: the toast
    // would be raised from a `statechange` handler, so asserting absence before the worker has
    // reached `installed` would pass on a build where the guard had been deleted.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => {}))
    await expect(page.getByText('An update is ready')).toHaveCount(0)

    await reloadIntoServiceWorkerControl(page)
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(messageList(page).first()).toBeVisible({ timeout: 30_000 })

    // Still build A. If this were already 'b' the deploy below would prove nothing.
    expect(await runningBuild(page)).toBeUndefined()

    deployBuildB()

    // ── WHAT DRIVES THE UPDATE CHECK HERE, AND WHAT THAT MEANS THIS TEST DOES NOT COVER ──────
    //
    // Nothing below triggers it. Chromium notices the new worker on its own, about 1.8 s after the
    // bytes change on disk, and raises the toast with no help from the test.
    //
    // That was measured rather than assumed, in both directions, because it decides what this test
    // is allowed to claim:
    //   * WITHOUT `deployBuildB()` above, no toast ever appears (30 s). So the toast really is
    //     caused by the new deployment and not by some ambient churn — without this control the
    //     assertion below would be worthless.
    //   * With the app's OWN `visibilitychange` listener deleted from `startUpdateChecks`
    //     (register-sw.ts), this test still passes. So it does NOT exercise the production update
    //     triggers, and no comment here may pretend otherwise.
    //
    // An earlier draft drove the check by backgrounding the tab behind a decoy page and calling
    // `page.bringToFront()`, on the reasoning that the visibility path is the one a real user hits.
    // It was removed once the mutation above showed it changed nothing: a step that appears to be
    // the point of the test while being inert is worse than no step at all. `startUpdateChecks`'s
    // hourly interval and its visibilitychange listener stay unit-covered only — an hourly timer is
    // not something a browser test can wait for, and the visibility path cannot be isolated from a
    // browser that checks anyway.
    const toast = page.getByText('An update is ready')
    await expect(toast).toBeVisible({ timeout: 30_000 })
    // Exactly one. A second waiting build must REPLACE the offer rather than stack another
    // (use-update-prompt.ts drops the previous toast id before raising the next).
    await expect(toast).toHaveCount(1)

    // The offer is STICKY (`duration: 0`), not a notification that expires while the user is
    // reading. An unnoticed update is worse than none, and a self-dismissing one is worst.
    await page.waitForTimeout(6000)
    await expect(toast).toBeVisible()

    // …and it has NOT reloaded anything on its own. This is the "no forced reloads mid-compose"
    // guarantee: the new build is sitting in `waiting`, and the tab is still running the old one.
    expect(await runningBuild(page)).toBeUndefined()

    // The reload happened, and it landed on the NEW build — not merely "a reload occurred". This is
    // what the staged second build buys: `__WAXWING_STAGED_BUILD__` exists only in B, so this
    // distinguishes "a new worker took over" from "the thing that took over was the new deploy",
    // which a copy-dist-and-touch-sw.js fixture could never tell apart.
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect.poll(() => runningBuild(page), { timeout: 60_000 }).toBe('b')
  })

  /**
   * ── "Open drafts are saved first" — the toast's second sentence, now true ────────────────────
   *
   * Shipped as a `test.fixme` by M3.10 wave 2, which established that the app did NOT satisfy it:
   * `useUpdatePrompt` called `useDraftSync()`, which calls `useReplicaOptional()`. But
   * `useUpdatePrompt()` runs in `AppBody` (app/App.tsx) and `ReplicaProvider` is rendered by
   * `SyncEngineHost` (sync/engine/react.tsx) — a DESCENDANT of `AppBody`. A hook cannot read a
   * context its own subtree provides, so the read was always `null`, `useDraftSync()` returned its
   * `replica === null` branch whose `flush` is `async () => {}`, and `flushOpenDrafts` awaited a
   * no-op in BOTH places it is called. For five milestones the toast promised a save that never
   * happened, and every unit test passed because each one injected `deps.draftSync`.
   *
   * FIXED by moving the SEAM rather than the prompt: the registration stays above the auth gate,
   * where FR-OFF-01 and FR-DEP-06 need it, and `flushActiveDraft` (compose/use-draft-sync.ts)
   * resolves the live replica through `getActiveReplica()` at call time, needing no ancestry.
   *
   * WHY THIS TEST IS TRUSTWORTHY, since a negative is easy to get wrong. The positive control run
   * before the defect was reported: the same flow with a 5 s pause before accepting — long enough
   * for the 3 s autosave debounce to fire — put the draft in the store and it survived the reload,
   * proving the store, the database name and the IndexedDB read below are all correct. Without the
   * pause the store was EMPTY. And re-running this test with the seam reverted to its inert form
   * turns it RED again, so it is testing the fix and not the neighbourhood of the fix.
   */
  test('accepting the update flushes an open draft first', async ({ page }) => {
    const token = `wwrite-deploy-${Date.now()}`

    await login(page, { stay: true })
    await reloadIntoServiceWorkerControl(page)
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(messageList(page).first()).toBeVisible({ timeout: 30_000 })

    deployBuildB()
    await expect(page.getByText('An update is ready')).toBeVisible({ timeout: 30_000 })

    // Compose everything EXCEPT the token, then add the token last and accept immediately. The
    // ordering is the whole point: autosave is a 3 s IDLE debounce, so a token introduced
    // milliseconds before the reload cannot have been persisted by autosave. Whatever survives,
    // survives because `flushOpenDrafts` put it there.
    await openComposer(page)
    await fillTo(page, ACCOUNTS.bob)
    await typeBody(page, 'Deploy landed mid-compose.')
    expect(await jmapAs(ACCOUNTS.alice).query(token, ['subject'])).toEqual([])

    const startedTyping = Date.now()
    await page.getByLabel('Subject', { exact: true }).fill(`[wwrite] ${token}`)
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    const elapsed = Date.now() - startedTyping

    // THE ASSERTION THAT KEEPS THIS TEST HONEST. If the composer sat idle longer than the debounce,
    // autosave could have saved the draft and the flush would be proving nothing — the test would
    // pass on a build with `flushOpenDrafts` deleted. Asserting the elapsed time makes that failure
    // mode RED instead of silently green, which is the direction it has to fail in.
    expect(
      elapsed,
      'typed the token and accepted the update inside the autosave debounce',
    ).toBeLessThan(AUTOSAVE_DEBOUNCE_MS)

    await expect.poll(() => runningBuild(page), { timeout: 60_000 }).toBe('b')

    // The local `drafts` store, which is where `flushDraft`'s AWAITED `putDraft` lands — "the
    // durable local write, the crash-safety guarantee". Not the server: `flushDraft` queues the
    // server copy with a fire-and-forget `void …dispatch(…)` that loses its race with the reload,
    // so no server assertion could hold here even once the defect above is fixed.
    await expect.poll(() => localDraftContents(page), { timeout: 30_000 }).toContain(token)
  })
})

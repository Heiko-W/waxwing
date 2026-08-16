import { expect, type Page, test } from '@playwright/test'

/**
 * M4.8 — startup performance against the SHIPPING bundle (NFR-PERF-01).
 *
 * Measured on the built artifact served by `vite preview`, not the dev server: the dev server ships
 * unbundled modules and a HMR client, so a number taken there describes a program nobody runs.
 *
 * **What "interactive" means here.** The sign-in screen, ready for input. Deliberately not "the
 * inbox is on screen": that number is dominated by the server's response to `Session/get` and the
 * first `Email/query`, so it measures Stalwart and the network, and would move under Waxwing's feet
 * for reasons Waxwing cannot fix. What this suite owns is the time from navigation to a usable
 * application — parse, execute, hydrate, paint — which is exactly what the bundle budget governs.
 *
 * **Why the median of several runs.** A single cold load on a developer machine is noisy to the tune
 * of hundreds of milliseconds — another process, a GC pause, the disk. A median over `RUNS` is
 * stable enough to fail on a real regression instead of on a busy laptop, and every individual
 * sample is logged so a failure can be read rather than guessed at.
 *
 * The budgets are NFR-PERF-01's own numbers. They are not padded: a padded budget passes for years
 * and then reports a doubling as "within limits".
 *
 * **Everything except the desktop case is throttled, and that is not belt-and-braces.** The server
 * under test is `vite preview` on localhost, where transfer time is effectively zero — so an
 * unthrottled "cold" load and an unthrottled "service-worker cached" load measure the same thing
 * (parse, execute, hydrate) and differ by noise. Reporting them as two passing budgets would be
 * three green ticks that say one thing. The precache only pays for itself when there is a network
 * to avoid, so that is where it is measured.
 */

/** Samples per measurement. Odd, so the median is an observed value rather than an average. */
const RUNS = 5

/** NFR-PERF-01, mid-range laptop, cold (nothing cached). */
const COLD_BUDGET_MS = 2_000
/** NFR-PERF-01, service-worker cached. */
const CACHED_BUDGET_MS = 1_000
/** NFR-PERF-01, throttled 4G phone, cold. */
const MOBILE_BUDGET_MS = 4_000

/**
 * A "slow 4G" profile: the numbers Chrome DevTools itself uses for Fast 3G/Slow 4G, applied through
 * CDP because Playwright has no throttling API. 4× CPU slowdown alongside it — a mid-range phone is
 * as much a slow processor as a slow radio, and a network-only test would flatter a bundle that is
 * cheap to download and expensive to execute, which is the failure mode a JS budget exists to catch.
 */
const MOBILE_NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
}
const MOBILE_CPU_SLOWDOWN = 4

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0

/**
 * Navigate cold and return the milliseconds from navigation start to the sign-in field being
 * interactive. Read from the Navigation Timing entry rather than wall-clock around `goto`, so
 * Playwright's own round-trip overhead is not counted as the app's.
 */
async function timeToInteractive(page: Page): Promise<number> {
  await page.goto('/', { waitUntil: 'commit' })
  const field = page.getByLabel('Username', { exact: true })
  await expect(field).toBeVisible({ timeout: 30_000 })
  await expect(field).toBeEnabled()
  return page.evaluate(() => performance.now())
}

/**
 * Everything a repeat visit would reuse — so the next load is genuinely cold.
 *
 * The HTTP cache is NOT reachable from page script and has to be disabled over CDP by the caller.
 * Leaving it on produced exactly the artefact you would expect: a third "cold" sample that came in
 * at 850 ms against 1500 ms for the first two, because the bundle was still sitting in it.
 */
async function clearEverything(page: Page): Promise<void> {
  await page.context().clearCookies()
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    for (const key of await caches.keys()) await caches.delete(key)
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registration) => registration.unregister()))
  })
}

function report(label: string, samples: number[], budget: number): void {
  const value = median(samples)
  console.log(
    `[perf] ${label}: median ${Math.round(value)} ms (budget ${budget} ms) — samples ${samples
      .map((sample) => Math.round(sample))
      .join(', ')}`,
  )
}

test.describe('M4.8 startup performance (NFR-PERF-01)', () => {
  test('cold start reaches an interactive sign-in inside the budget', async ({ page }) => {
    const client = await page.context().newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.setCacheDisabled', { cacheDisabled: true })

    const samples: number[] = []
    for (let run = 0; run < RUNS; run++) {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await clearEverything(page)
      samples.push(await timeToInteractive(page))
    }

    // On localhost this is parse + execute + hydrate with no transfer time worth the name — which
    // is precisely the cost the JS budget governs, and the number that moves when a dependency is
    // added. The network side of a cold start is the throttled case below.
    report('cold (desktop, no transfer cost)', samples, COLD_BUDGET_MS)
    expect(median(samples)).toBeLessThan(COLD_BUDGET_MS)
  })

  test('a service-worker cached start beats the network it replaces', async ({ page }) => {
    // Prime on a fast link, then throttle: this is the shape of the real case — a returning user on
    // a phone, whose bundle is already on disk.
    await page.goto('/')
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForTimeout(500) // let the precache finish writing

    const client = await page.context().newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', MOBILE_NETWORK)
    // The SAME CPU throttle as the cold 4G case. Without it this test ran on a full-speed processor
    // against a slow one and the two numbers were not comparable — which would make "the precache
    // is faster" a claim about the CPU rather than about the precache.
    await client.send('Emulation.setCPUThrottlingRate', { rate: MOBILE_CPU_SLOWDOWN })

    const samples: number[] = []
    for (let run = 0; run < RUNS; run++) samples.push(await timeToInteractive(page))
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })

    report('service-worker cached (throttled 4G, 4× CPU)', samples, CACHED_BUDGET_MS)
    // Under the same phone as the cold case below, a precached start must come in under the
    // separate, tighter budget — it does not touch that network at all.
    expect(median(samples)).toBeLessThan(CACHED_BUDGET_MS)
  })

  test('a throttled 4G phone still reaches an interactive sign-in', async ({ page }) => {
    const client = await page.context().newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', MOBILE_NETWORK)
    await client.send('Network.setCacheDisabled', { cacheDisabled: true })
    await client.send('Emulation.setCPUThrottlingRate', { rate: MOBILE_CPU_SLOWDOWN })

    const samples: number[] = []
    // Fewer runs: each one downloads the whole bundle over a 1.6 Mbps pipe.
    for (let run = 0; run < 3; run++) {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await clearEverything(page)
      samples.push(await timeToInteractive(page))
    }

    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    report('cold (throttled 4G, 4× CPU)', samples, MOBILE_BUDGET_MS)
    expect(median(samples)).toBeLessThan(MOBILE_BUDGET_MS)
  })
})

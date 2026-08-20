import { expect, type Page, test } from '@playwright/test'

/**
 * The fixture-free smoke test on the SHIPPING bundle (P0.3, retargeted in M3.10).
 *
 * This is the only suite `playwright.config.ts` collects, and it is the only one that runs with
 * no Stalwart fixture, no proxy and no seeded account. What it is worth is therefore narrow and
 * specific: it proves the production build BOOTS — React mounts under the strict production
 * <meta> CSP (NFR-SEC-01), the entry chunk and its assets resolve against document.baseURI, and
 * the first screen paints. Every fixture-backed suite would also catch a boot failure, but they
 * cost a Docker fixture and 30+ seconds to say so; this says it in five.
 *
 * WHY IT WAS REWRITTEN. Until M3.10 this spec asserted `<h1>` contains "Waxwing", described in
 * its own comment as "the product name from config.json interpolated into the shell tagline
 * heading". That was true of the P0.3 placeholder shell and has been false since M1.4 replaced
 * it with real onboarding: with `sessionUrl: null` + `allowCustomServer: true` (the shipped
 * public/config.json), SessionProvider probes the current origin, `vite preview` SPA-falls-back
 * `/.well-known/jmap` to index.html with a 200, the probe reads that as "a server is here", and
 * the app lands on the LOGIN step whose `<h1>` is `auth.signInTitle` — "Sign in to {host}".
 * LoginForm takes `productName` as a prop and never renders it, so the product name is not on
 * this screen at all and no assertion here can honestly claim to check branding. The suite was
 * red rather than stale-but-passing, and it went unnoticed because `pnpm verify:e2e` was itself
 * red one step earlier (see the testMatch comment in playwright.config.ts).
 *
 * So the assertions below deliberately claim LESS than the old ones did: that the app booted,
 * which is all a serverless smoke test can honestly know. Branding is covered where it is real —
 * `apps/web/src/app/config.ts` unit tests and the fixture-backed suites' signed-in shell.
 */
test.describe('placeholder shell', () => {
  test('the production bundle boots and renders the sign-in screen', async ({ page }) => {
    const violations = cspErrors(page)

    await page.goto('/')

    // Booting past the spinner into the onboarding card is the real assertion: it means the entry
    // chunk loaded, React mounted and the config fetch resolved. The heading text is the login
    // step's `auth.signInTitle`, carrying the host the app decided to talk to — here the preview
    // origin itself, because the SPA fallback makes the same-origin probe succeed (see above).
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Webmail for')

    // An interactive control is present, so the card is the real form and not an error fallback.
    // The shipped config lists `["oauth", "basic"]` and `localhost` is a secure context, so OAuth
    // leads and the password form sits behind its disclosure — both controls are asserted, which
    // also pins that the collapsed layout reached the production bundle.
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Sign in with a password instead', exact: true }),
    ).toBeVisible()

    // The production CSP forbids inline script and eval. A violation here means the shipped
    // bundle would be dead on any correctly-served deployment, which is exactly the class of
    // defect a build-artifact smoke test exists to catch before the slow suites run.
    expect(violations).toEqual([])
  })
})

/** Collects CSP violations / "Refused to…" console errors so a test can assert none occurred. */
function cspErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/content security policy|refused to/i.test(text)) errors.push(text)
  })
  return errors
}

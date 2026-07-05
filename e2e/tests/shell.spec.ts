import { expect, test } from '@playwright/test'

// Placeholder end-to-end spec (P0.3). It exercises only the built static shell served by
// `vite preview` — no JMAP server is involved. Server-backed specs land with P0.4/M1.9
// (see playwright.config.ts).
test.describe('placeholder shell', () => {
  test('renders the branded product name and a control', async ({ page }) => {
    await page.goto('/')

    // The product name comes from the deployment config.json (branding.productName) and
    // is interpolated into the shell tagline heading.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Waxwing')

    // At least one interactive control (a theme / language switch button) is present.
    await expect(page.getByRole('button').first()).toBeVisible()
  })
})

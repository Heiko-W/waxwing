import { render } from '@testing-library/react'
import { describe, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { App } from './App'
import { DEFAULT_CONFIG } from './config'

// Example a11y test — the template the M1.1 base-component tests copy.
//
// The App shell renders inline, so asserting against RTL's `container` is correct here.
// IMPORTANT for portal-rendering components (Dialog, Menu, Tooltip, Toast/Snackbar):
// their DOM mounts into document.body, OUTSIDE `container`. Assert those against the
// helper's default (document.body) — call `expectNoA11yViolations()` with no argument —
// or the scan runs over an empty subtree. (`expectNoA11yViolations` throws on an empty
// subtree to catch exactly that mistake.)
describe('App shell accessibility', () => {
  it('has no WCAG 2.x A/AA axe violations', async () => {
    const { container } = render(<App config={DEFAULT_CONFIG} />)

    await expectNoA11yViolations(container)
  })
})

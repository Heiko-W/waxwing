import axe from 'axe-core'

/**
 * axe-core integration for component-level a11y assertions in Vitest (jsdom).
 *
 * axe-core is wrapped directly (rather than via a matcher library) so it stays pinned
 * to the versions we control and framework-agnostic. Assertions run against the WCAG
 * 2.x A/AA rule set — Waxwing's target is WCAG 2.2 AA (FR-A11Y-01) — and deliberately
 * exclude axe's "best-practice" rules, which are advisory rather than conformance
 * failures.
 *
 * Scope and limits of this jsdom helper — read before copying the example test:
 *  - jsdom has no layout engine or canvas, so the `color-contrast` rule (WCAG 1.4.3)
 *    cannot run here. It is disabled explicitly (see JSDOM_DISABLED_RULES) so runs stay
 *    deterministic and quiet — otherwise every run logs `HTMLCanvasElement.getContext`
 *    warnings and reports contrast as perpetually "incomplete". Contrast conformance and
 *    light/dark theme rendering are covered instead by a browser-based axe scan over the
 *    component gallery in M1.1 (implementation-plan.md §M1.1: "contrast-check every token
 *    pair (WCAG AA)"). This helper therefore covers structural/ARIA rules only.
 *  - `runAxe` returns the full AxeResults, including axe's `incomplete` list, so callers
 *    can inspect rules jsdom could not fully evaluate rather than have them silently
 *    dropped.
 *
 * Portals: components that render through a React portal (Dialog, Menu, Tooltip,
 * Toast/Snackbar) mount into `document.body`, OUTSIDE the React Testing Library
 * `container`. Assert those against the default (`document.body`) — not the RTL
 * `container` — or the scan runs over an empty subtree.
 */

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

// color-contrast needs real layout/canvas that jsdom lacks; it is verified in a browser
// (the M1.1 gallery scan) instead. Kept as a default so callers can still re-enable or
// override rules explicitly via `options.rules`.
const JSDOM_DISABLED_RULES: axe.RunOptions['rules'] = {
  'color-contrast': { enabled: false },
}

export async function runAxe(
  container: Element = document.body,
  options: axe.RunOptions = {},
): Promise<axe.AxeResults> {
  return axe.run(container, {
    runOnly: { type: 'tag', values: [...WCAG_AA_TAGS] },
    ...options,
    // Merge after `options` so a caller can add/override individual rules while
    // color-contrast stays disabled by default under jsdom.
    rules: { ...JSDOM_DISABLED_RULES, ...options.rules },
  })
}

function formatViolations(violations: readonly axe.Result[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n')
      return `  [${violation.id}] ${violation.help} (impact: ${violation.impact ?? 'n/a'})\n${targets}`
    })
    .join('\n')
}

/**
 * Assert that the given subtree has no WCAG A/AA axe violations. Throws a readable,
 * violation-by-violation error when any are found so the failure is actionable.
 *
 * Fails loudly on an empty subtree: a component that renders nothing (or whose portal
 * content mounts elsewhere) would otherwise pass this assertion vacuously.
 */
export async function expectNoA11yViolations(
  container: Element = document.body,
  options: axe.RunOptions = {},
): Promise<void> {
  if (container.childElementCount === 0) {
    throw new Error(
      'expectNoA11yViolations: the scanned subtree is empty — the component rendered ' +
        'nothing, or it renders through a portal. Assert against document.body (the ' +
        'default) instead of the React Testing Library container.',
    )
  }

  const { violations } = await runAxe(container, options)
  if (violations.length > 0) {
    throw new Error(
      `Expected no accessibility violations but found ${violations.length}:\n${formatViolations(violations)}`,
    )
  }
}

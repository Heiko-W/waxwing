import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { SplitPane } from './SplitPane'

function Fixture() {
  return (
    <SplitPane
      label="Resize sidebar"
      defaultPrimarySize={300}
      minPrimarySize={160}
      maxPrimarySize={480}
      step={20}
    >
      <div>Primary</div>
      <div>Secondary</div>
    </SplitPane>
  )
}

describe('SplitPane', () => {
  it('exposes a separator with an orientation and value range', () => {
    render(<Fixture />)
    const separator = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuenow', '300')
    expect(separator).toHaveAttribute('aria-valuemin', '160')
    expect(separator).toHaveAttribute('aria-valuemax', '480')
  })

  it('resizes with the keyboard and clamps to the range', async () => {
    const user = userEvent.setup()
    render(<Fixture />)
    const separator = screen.getByRole('separator')
    separator.focus()
    await user.keyboard('{ArrowRight}')
    expect(separator).toHaveAttribute('aria-valuenow', '320')
    await user.keyboard('{Home}')
    expect(separator).toHaveAttribute('aria-valuenow', '160')
    await user.keyboard('{ArrowLeft}')
    expect(separator).toHaveAttribute('aria-valuenow', '160')
    await user.keyboard('{End}')
    expect(separator).toHaveAttribute('aria-valuenow', '480')
  })

  it('maps the arrow keys and aria-orientation for a vertical split', async () => {
    const user = userEvent.setup()
    render(
      <SplitPane
        orientation="vertical"
        label="Resize top pane"
        defaultPrimarySize={200}
        minPrimarySize={100}
        maxPrimarySize={300}
        step={25}
      >
        <div>Top</div>
        <div>Bottom</div>
      </SplitPane>,
    )
    const separator = screen.getByRole('separator', { name: 'Resize top pane' })
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    separator.focus()
    await user.keyboard('{ArrowDown}')
    expect(separator).toHaveAttribute('aria-valuenow', '225')
    await user.keyboard('{ArrowUp}')
    expect(separator).toHaveAttribute('aria-valuenow', '200')
    await user.keyboard('{End}')
    expect(separator).toHaveAttribute('aria-valuenow', '300')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Fixture />)
    await expectNoA11yViolations(container)
  })
})

/**
 * The size the reader chose, and the size they get before they choose (D-06, T-06).
 *
 * Two defects with one cause: the width lived in `useState` and nowhere else. So it reset on every
 * reload — the one thing in this screen set with the reader's hands was the one thing not
 * remembered, beside sort, threading, unread-first, collapsed accounts, pinned folders and the
 * reading-pane mode, which all are — and the per-tier CONSTANT that seeded it could not be right at
 * both ends of its own tier: 420px is the audit's answer for a 1440px desktop and leaves an iPad in
 * landscape a 352px reading pane, narrower than the 410 the same device gets in portrait on 278px
 * less screen.
 *
 * jsdom lays nothing out, so `clientWidth` is 0 and the effect that applies both would return
 * early. It is stubbed here for the same reason `scrollbar-metrics.test.ts` stubs its probe: what
 * is being tested is the arithmetic and the decision, not the browser's box model.
 */
function stubWidth(width: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: width })
}

function clearWidthStub(): void {
  // DELETED rather than restored: jsdom defines `clientWidth` on Element.prototype, so there is no
  // own descriptor on HTMLElement.prototype to put back — and "restore what was there" silently
  // becomes "keep the first stub for the rest of the file", which is a test reading a width no
  // test set.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
}

describe('SplitPane — the remembered size', () => {
  const KEY = 'waxwing.test.split'

  function renderShared(width: number, props: Record<string, unknown> = {}) {
    // The stub stays up for the whole test: the width is read again when a resize is REMEMBERED,
    // not only when the default is applied.
    stubWidth(width)
    return render(
      <SplitPane
        label="Resize"
        defaultPrimary={{ fraction: 0.37, min: 300, max: 460 }}
        storageKey={KEY}
        minPrimarySize={260}
        maxPrimarySize={640}
        step={20}
        {...props}
      >
        <div>Primary</div>
        <div>Secondary</div>
      </SplitPane>,
    )
  }

  afterEach(() => {
    localStorage.removeItem(KEY)
    clearWidthStub()
  })

  it('takes its share of the room it is actually in', () => {
    // 1131px is a 1440px desktop minus the icon rail and the folder column. 37% of it is the 420
    // the audit measured — the constant this replaces, reproduced at the width it was chosen at.
    renderShared(1131)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '418')
  })

  it('does not let a narrow window squeeze the list below what its chrome needs', () => {
    // iPad landscape: 796px of pane area. 37% is 295, and the list carries a search field, a
    // folder title and a view toggle.
    renderShared(796)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '300')
  })

  it('does not let a wide window make the list wider than it can use', () => {
    // 1611px on a 1920px screen. The old constant gave the same 420 here as at 1024; a bare share
    // would give 596, which buys nothing.
    renderShared(1611)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '460')
  })

  it('remembers a keyboard resize as a share, and restores it', () => {
    localStorage.setItem(KEY, '0.5000')
    renderShared(1000)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '500')
  })

  it('lets what the reader dragged to beat a changed default', async () => {
    const user = userEvent.setup()
    renderShared(1000)
    const separator = screen.getByRole('separator')
    separator.focus()
    await user.keyboard('{ArrowRight}')
    // 370 + 20, stored as a share of 1000.
    expect(localStorage.getItem(KEY)).toBe('0.3900')
  })

  it('ignores a stored value that is not a layout anyone chose', () => {
    // A corrupted or hand-edited entry must not be able to leave the app with an invisible pane
    // and no way back to a usable one.
    localStorage.setItem(KEY, 'nonsense')
    renderShared(1000)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '370')
    localStorage.setItem(KEY, '0.99')
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '370')
  })

  it('stores nothing without a storage key', async () => {
    // Every other caller of this component keeps its old behaviour exactly.
    const user = userEvent.setup()
    const before = localStorage.length
    renderShared(1000, { storageKey: undefined })
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowRight}')
    expect(localStorage.length).toBe(before)
  })
})

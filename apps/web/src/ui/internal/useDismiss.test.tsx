import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDismiss } from './useDismiss'

/**
 * The outside-pointer half of {@link useDismiss} — specifically, what it costs to keep open (N-10).
 *
 * `Menu.tsx` passes `extraRefs: [triggerRef]` as an inline literal, so the array is a fresh object
 * on every render and the effect that owns the document listener re-ran each time: measured, 200
 * re-renders of an open menu produced 201 `pointerdown` registrations and 200 removals, ~34 µs per
 * render. No leak and no misbehaviour — which is why this was an observation — but it is also the
 * contract this hook already refused to ask of its callers for `onDismiss` (R-39), so the array is
 * read through a ref for the same reason.
 */
function Harness({ label, extra }: { label: string; extra: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useDismiss(
    true,
    ref,
    () => {
      document.body.dataset.dismissed = label
    },
    extra ? { extraRefs: [triggerRef] } : {},
  )
  return (
    <>
      <button type="button" ref={triggerRef} data-testid="trigger">
        trigger {label}
      </button>
      <div ref={ref} data-testid="surface">
        surface
      </div>
      <div data-testid="outside">outside</div>
    </>
  )
}

afterEach(() => {
  delete document.body.dataset.dismissed
  vi.restoreAllMocks()
})

describe('useDismiss outside-pointer', () => {
  it('registers its document listener ONCE across re-renders, despite an inline extraRefs', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const { rerender } = render(<Harness label="a" extra />)
    add.mockClear()
    remove.mockClear()

    for (let i = 0; i < 20; i += 1) rerender(<Harness label={`a${i}`} extra />)

    expect(add.mock.calls.filter((call) => call[0] === 'pointerdown')).toHaveLength(0)
    expect(remove.mock.calls.filter((call) => call[0] === 'pointerdown')).toHaveLength(0)
  })

  it('still treats the extra ref as inside, and the rest of the document as outside', async () => {
    const user = userEvent.setup()
    const { getByTestId, rerender } = render(<Harness label="a" extra />)
    // Re-rendered first: the array the listener closed over at mount is gone, so this also proves
    // the ref is read at dismiss time rather than captured.
    rerender(<Harness label="b" extra />)

    await user.click(getByTestId('trigger'))
    expect(document.body.dataset.dismissed).toBeUndefined()
    await user.click(getByTestId('surface'))
    expect(document.body.dataset.dismissed).toBeUndefined()

    await user.click(getByTestId('outside'))
    expect(document.body.dataset.dismissed).toBe('b')
  })

  it('without extraRefs, a press on the trigger IS outside', async () => {
    const user = userEvent.setup()
    const { getByTestId } = render(<Harness label="c" extra={false} />)
    await user.click(getByTestId('trigger'))
    expect(document.body.dataset.dismissed).toBe('c')
  })
})

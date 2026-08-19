/**
 * The read-receipt banner (M5.22).
 *
 * The load-bearing assertion is the first one: rendering the banner must send NOTHING. That is the
 * whole difference between this feature and the one NFR-PRIV-01 forbids, and it is exactly the sort
 * of thing a later refactor breaks by moving the call into an effect.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import type { MdnRequest } from './mdn'
import { ReadReceiptBanner } from './ReadReceiptBanner'

const SAME: MdnRequest = { notifyTo: 'sender@example.com', matchesFrom: true }
const ELSEWHERE: MdnRequest = { notifyTo: 'tracker@harvest.example', matchesFrom: false }

function renderBanner(
  request: MdnRequest = SAME,
  onConfirm = vi.fn(async () => {}),
  alreadySent = false,
) {
  const view = render(
    <ReadReceiptBanner request={request} alreadySent={alreadySent} onConfirm={onConfirm} />,
  )
  return { ...view, onConfirm }
}

describe('opening a message sends nothing', () => {
  it('does not confirm on render', () => {
    const { onConfirm } = renderBanner()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('says plainly that nothing has been sent yet', () => {
    renderBanner()
    expect(screen.getByText(/Nothing has been sent/i)).toBeInTheDocument()
  })

  it('sends only after the button is pressed', async () => {
    const { onConfirm } = renderBanner()
    await userEvent.click(screen.getByRole('button', { name: /Confirm I read it/i }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })
})

describe('who would be told', () => {
  it('names the address', () => {
    renderBanner()
    expect(screen.getByText(/sender@example\.com/)).toBeInTheDocument()
  })

  it('says so when the receipt would go somewhere other than the sender', () => {
    // The case a reader would most want to decline and least expect to need to.
    renderBanner(ELSEWHERE)
    expect(screen.getByText(/not the address this message came from/i)).toBeInTheDocument()
    expect(screen.getByText(/tracker@harvest\.example/)).toBeInTheDocument()
  })
})

describe('declining', () => {
  it('removes the banner and sends nothing', async () => {
    const { onConfirm } = renderBanner()
    await userEvent.click(screen.getByRole('button', { name: /^No$/i }))
    expect(screen.queryByText(/asked to be told/i)).not.toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('when it has already been answered', () => {
  it('shows that it was, rather than asking again', () => {
    renderBanner(
      SAME,
      vi.fn(async () => {}),
      true,
    )
    expect(screen.getByText(/You confirmed you read this/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm I read it/i })).not.toBeInTheDocument()
  })
})

describe('when the send fails', () => {
  it('says nobody was told, and lets the reader try again', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('refused')
    })
    renderBanner(SAME, onConfirm)
    await userEvent.click(screen.getByRole('button', { name: /Confirm I read it/i }))

    expect(await screen.findByText(/Nobody was told/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm I read it/i })).toBeEnabled()
  })
})

describe('accessibility', () => {
  it('has no violations', async () => {
    const { container } = renderBanner(ELSEWHERE)
    await expectNoA11yViolations(container)
  })
})

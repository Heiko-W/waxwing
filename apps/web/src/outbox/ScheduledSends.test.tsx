/**
 * The list of server-held sends (M5.4, FR-CMP-11).
 *
 * The three answers a cancel can produce are three different sentences, and the component owes the
 * reader whichever one is true: it was cancelled, it had already gone out, or nobody knows because
 * the request never reached the server.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui'
import { ScheduledSends } from './ScheduledSends'
import type { ScheduledClient, ScheduledSend } from './scheduled-client'

const HELD: ScheduledSend = {
  id: 's1',
  emailId: 'e1',
  sendAt: '2026-09-02T10:00:00Z',
  subject: 'Lunch?',
}

function renderList(client: ScheduledClient) {
  render(
    <ToastProvider>
      <ScheduledSends client={client} />
    </ToastProvider>,
  )
  return userEvent.setup()
}

describe('ScheduledSends', () => {
  it('says so when the cancel succeeds', async () => {
    const user = renderList({
      list: vi.fn(async () => [HELD]),
      cancel: vi.fn(async () => true),
    })
    await user.click(await screen.findByRole('button', { name: 'Cancel send' }))
    expect(await screen.findByText('Send canceled')).toBeInTheDocument()
  })

  it('says the message had already gone out', async () => {
    const user = renderList({
      list: vi.fn(async () => [HELD]),
      cancel: vi.fn(async () => false),
    })
    await user.click(await screen.findByRole('button', { name: 'Cancel send' }))
    expect(await screen.findByText('Already sent — it had left the queue.')).toBeInTheDocument()
  })

  /**
   * R-55: `cancel` had a `try/finally` and no `catch`. Offline, the spinner simply stopped — no
   * toast, the row unchanged — and the reader was left not knowing whether the message is still
   * going out. The rejection was unhandled on top of that.
   */
  it('says the cancel could not be delivered, instead of falling silent', async () => {
    const user = renderList({
      list: vi.fn(async () => [HELD]),
      cancel: vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    })
    const button = await screen.findByRole('button', { name: 'Cancel send' })
    await user.click(button)

    expect(
      await screen.findByText('The send could not be canceled. The message may still go out.'),
    ).toBeInTheDocument()
    // …and the row is still there, still offering the action: nothing was silently resolved.
    expect(screen.getByText('Lunch?')).toBeInTheDocument()
    await waitFor(() => expect(button).toBeEnabled())
  })
})

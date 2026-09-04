/**
 * The list of server-held sends (M5.4, FR-CMP-11).
 *
 * The three answers a cancel can produce are three different sentences, and the component owes the
 * reader whichever one is true: it was cancelled, it had already gone out, or nobody knows because
 * the request never reached the server.
 *
 * The LOAD path is here for the same reason (N-10): until it was, this file covered only the
 * cancel, and the three states the reader sees before any button exists — asking, nothing
 * scheduled, could not be asked — were untested. "Nothing scheduled" and "could not be loaded" are
 * the pair it is easiest to conflate, and conflating them tells someone their message is not going
 * out when it is.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
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
  it('says it is asking, and then shows what came back', async () => {
    // `null` items is "not asked yet", NOT "nothing scheduled" — the reader must not be told the
    // queue is empty while the question is still in flight.
    let answer: (value: ScheduledSend[]) => void = () => {}
    renderList({
      list: vi.fn(
        async () =>
          await new Promise<ScheduledSend[]>((resolve) => {
            answer = resolve
          }),
      ),
      cancel: vi.fn(async () => true),
    })

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('Nothing scheduled.')).not.toBeInTheDocument()

    await act(async () => {
      answer([HELD])
    })
    expect(await screen.findByText('Lunch?')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('says the queue is empty when the server answers with nothing', async () => {
    renderList({ list: vi.fn(async () => []), cancel: vi.fn(async () => true) })

    expect(await screen.findByText('Nothing scheduled.')).toBeInTheDocument()
    // An empty answer is an ANSWER: no spinner left behind, and emphatically not the failure line.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(
      screen.queryByText('The scheduled messages could not be loaded.'),
    ).not.toBeInTheDocument()
  })

  /**
   * And a load that FAILS says so, rather than borrowing the empty state.
   *
   * The two are one character apart in the component (`items === null` versus `failed`) and worlds
   * apart on screen: "nothing scheduled" over a failed request tells someone their message is not
   * going out when it is. It is announced (`role="alert"`), because it contradicts what the reader
   * came to this section to check.
   */
  it('says the list could not be loaded, and does not pass it off as an empty queue', async () => {
    renderList({
      list: vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      cancel: vi.fn(async () => true),
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The scheduled messages could not be loaded.')
    expect(screen.queryByText('Nothing scheduled.')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

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

/**
 * The send options sheet (M-7, M-11).
 *
 * The behaviour worth pinning is the GATE: a switch for something the account did not advertise is
 * worse than no switch, because it turns an unavailable feature into a failed send. Priority is the
 * exception and is always offered — it travels as message headers, which need no extension.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import SendOptionsDialog from './SendOptionsDialog'
import { DEFAULT_SEND_OPTIONS, type SubmissionExtensions } from './send-options'

const ALL: SubmissionExtensions = { dsn: true, requireTls: true, mtPriority: true }
const NONE: SubmissionExtensions = { dsn: false, requireTls: false, mtPriority: false }

function open(extensions: SubmissionExtensions, onChange = vi.fn()) {
  render(
    <SendOptionsDialog
      value={DEFAULT_SEND_OPTIONS}
      extensions={extensions}
      onChange={onChange}
      onClose={() => {}}
    />,
  )
  return onChange
}

describe('SendOptionsDialog', () => {
  it('offers priority even where nothing is advertised — headers need no extension', () => {
    open(NONE)
    expect(screen.getByLabelText('Priority')).toBeInTheDocument()
  })

  it('hides the receipt switch where the account does not advertise DSN', () => {
    open(NONE)
    expect(screen.queryByRole('switch', { name: /delivery receipt/i })).toBeNull()
  })

  it('hides the TLS switch where the account does not advertise REQUIRETLS', () => {
    open(NONE)
    expect(screen.queryByRole('switch', { name: /encrypted connection/i })).toBeNull()
  })

  it('shows both switches where the account advertises both', () => {
    open(ALL)
    expect(screen.getByRole('switch', { name: /delivery receipt/i })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /encrypted connection/i })).toBeInTheDocument()
  })

  it('reports a priority change', async () => {
    const onChange = open(ALL)
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'high')
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SEND_OPTIONS, priority: 'high' })
  })

  it('reports the receipt switch', async () => {
    const onChange = open(ALL)
    await userEvent.click(screen.getByRole('switch', { name: /delivery receipt/i }))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SEND_OPTIONS, deliveryReceipt: true })
  })

  it('states the CONSEQUENCE of requiring TLS, not just the setting', async () => {
    open(ALL)
    // A privacy switch that quietly turns into a bounce is a worse outcome than not offering it,
    // so the hint says what happens and is wired to the switch by aria-describedby.
    const tls = screen.getByRole('switch', { name: /encrypted connection/i })
    const hint = document.getElementById(tls.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toMatch(/returned to you/i)
  })

  it('has no a11y violations', async () => {
    open(ALL)
    await expectNoA11yViolations(document.body)
  })
})

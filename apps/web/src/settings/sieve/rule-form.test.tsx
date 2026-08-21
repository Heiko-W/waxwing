/**
 * The rule editor's vocabulary is the server's, not a constant (M-8, FR-SIEVE-01).
 *
 * Stalwart advertises around fifty Sieve extensions and every deployment advertises its own set.
 * A `require` for one the server does not implement can compile cleanly and then fail when mail
 * actually arrives (ADR-023), so an entry that would generate one has to be absent rather than
 * present-and-broken.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RuleForm } from './RuleForm'
import type { SieveRule } from './rule-model'

const ALL = [
  'envelope',
  'spamtest',
  'relational',
  'comparator-i;ascii-numeric',
  'date',
  'duplicate',
  'reject',
  'mime',
]

function renderForm(options: { extensions?: readonly string[]; rule?: SieveRule } = {}) {
  const onSubmit = vi.fn()
  render(
    <RuleForm
      rule={options.rule ?? null}
      mailboxes={[]}
      extensions={options.extensions}
      busy={false}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  )
  return { onSubmit }
}

/** The nth `<select>` labelled "Part" — the condition kind, then the date part inside it. */
function partSelect(index = 0): HTMLElement {
  const found = screen.getAllByLabelText('Part')[index]
  if (found === undefined) throw new Error(`no "Part" select at index ${String(index)}`)
  return found
}

/** The option labels of the condition "Part" select. */
const partOptions = () =>
  [...partSelect().querySelectorAll('option')].map((option) => option.textContent)

describe('<RuleForm> vocabulary gating', () => {
  it('offers only the 1.0 vocabulary to a server that advertised no extension list', () => {
    renderForm()

    expect(partOptions()).toEqual([
      'Sender',
      'To',
      'Cc',
      'Subject',
      'Message text',
      'Size',
      'Has attachment',
    ])
    expect(screen.queryByRole('option', { name: 'Refuse with a reason' })).not.toBeInTheDocument()
  })

  it('offers the envelope, spam, delivery-time and duplicate conditions when the server has them', () => {
    renderForm({ extensions: ALL })

    expect(partOptions()).toEqual([
      'Sender',
      'To',
      'Cc',
      'Subject',
      'Message text',
      'Envelope sender',
      'Envelope recipient',
      'Size',
      'Has attachment',
      'Spam score',
      'Delivery time',
      'Duplicate message',
    ])
    expect(screen.getByRole('option', { name: 'Refuse with a reason' })).toBeInTheDocument()
  })

  it('gates each condition on its own extension, not on one flag for all of them', () => {
    renderForm({ extensions: ['envelope'] })

    expect(partOptions()).toContain('Envelope sender')
    expect(partOptions()).not.toContain('Spam score')
    expect(partOptions()).not.toContain('Duplicate message')
  })

  it('offers a weekday on `date` alone, and an hour only with the numeric comparison', async () => {
    const user = userEvent.setup()
    renderForm({ extensions: ['date'] })

    await user.selectOptions(partSelect(), 'currentDate')

    const parts = [...partSelect(1).querySelectorAll('option')].map((option) => option.textContent)
    expect(parts).toEqual(['Day of week'])
  })

  it('keeps an entry an existing rule already uses, whatever the server now advertises', async () => {
    // Otherwise opening an old rule shows a `<select>` with no matching option, and saving it
    // rewrites the rule into whatever happened to be first — the silent-rewrite failure ADR-023
    // exists to prevent.
    const rule: SieveRule = {
      id: 'r1',
      name: 'Spam',
      enabled: true,
      match: 'all',
      conditions: [{ kind: 'spam', operator: 'atLeast', score: 5 }],
      actions: [{ kind: 'reject', reason: 'no thanks' }],
      stop: false,
    }
    renderForm({ rule, extensions: [] })

    expect(partOptions()).toContain('Spam score')
    expect(screen.getByLabelText('Score (0–10)')).toHaveValue(5)
    expect(screen.getByLabelText('Reason')).toHaveValue('no thanks')
  })

  it('submits the new condition shape rather than a text approximation of it', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ extensions: ALL })

    await user.type(screen.getByLabelText('Name'), 'Junk')
    await user.selectOptions(partSelect(), 'spam')
    await user.click(screen.getByRole('button', { name: 'Save rule' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        conditions: [{ kind: 'spam', operator: 'atLeast', score: 5 }],
      }),
    )
  })
})

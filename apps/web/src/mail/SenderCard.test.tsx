import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { putAddressBooks, putContactCards, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { addressBook, contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { SenderCard } from './SenderCard'
import type { SenderIdentity } from './sender-contact'

// The photo hook needs session/blob plumbing not under test here (same stance as ContactsScreen.test).
vi.mock('../contacts/use-contact-photo', () => ({ useContactPhoto: () => undefined }))

let db: ReplicaDb
const dispatch = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve())

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  window.history.replaceState(null, '', '/mail/inbox/e1')
  await putAddressBooks(db, 'a', [addressBook('personal', { name: 'Personal', isDefault: true })])
})

afterEach(async () => {
  cleanup()
  setActiveEngine(null)
  await db.delete()
})

/** A trigger the popover anchors to and returns focus to, opened by a real click (as MessageView does). */
function Harness({
  from,
  mailboxId = 'inbox',
}: {
  from: SenderIdentity
  mailboxId?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <RouterProvider>
      <ToastProvider>
        <ReplicaProvider accountId="a" db={db}>
          <button
            ref={ref}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            trigger
          </button>
          {open && (
            <SenderCard
              from={from}
              accountId="a"
              mailboxId={mailboxId}
              anchorRef={ref}
              onClose={() => setOpen(false)}
            />
          )}
        </ReplicaProvider>
      </ToastProvider>
    </RouterProvider>
  )
}

async function open(
  from: SenderIdentity,
  mailboxId?: string,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(<Harness from={from} mailboxId={mailboxId} />)
  await user.click(screen.getByRole('button', { name: 'trigger' }))
  await screen.findByRole('dialog')
  return user
}

const alice: SenderIdentity = { name: 'Alice Anderson', email: 'alice@x.test' }

describe('SenderCard', () => {
  it('an unknown sender offers "Add to Contacts", creating the seed in the writable default book', async () => {
    const user = await open(alice)
    const add = await screen.findByRole('button', { name: 'Add to Contacts' })
    await user.click(add)

    await waitFor(() => expect(dispatch).toHaveBeenCalled())
    const intent = dispatch.mock.calls
      .map(
        (call) => call[0] as { kind: string; creationId?: string; card?: Record<string, unknown> },
      )
      .find((i) => i.kind === 'createContactCard')
    expect(intent).toBeDefined()
    expect(intent?.card).toMatchObject({
      '@type': 'Card',
      version: '1.0',
      kind: 'individual',
      name: { full: 'Alice Anderson' },
      emails: { e1: { '@type': 'EmailAddress', address: 'alice@x.test' } },
      addressBookIds: { personal: true },
    })
    // The server owns the uid; the id is forced to the outbox creation id, never guessed on the seed.
    expect(intent?.card?.uid).toBeUndefined()
    expect(intent?.card?.id).toBe(intent?.creationId)
  })

  it('a known sender offers "Edit Contact", navigating to the card in its book', async () => {
    await putContactCards(db, 'a', [
      contactCard('c1', {
        name: { full: 'Alice Anderson' },
        emails: { e1: { address: 'alice@x.test' } },
        addressBookIds: { personal: true },
      }),
    ])
    const user = await open(alice)
    const edit = await screen.findByRole('button', { name: 'Edit Contact' })
    await user.click(edit)
    expect(window.location.pathname).toBe('/contacts/personal/c1')
  })

  it('"Last conversation" navigates to a from: search over all folders', async () => {
    const user = await open(alice)
    await user.click(screen.getByRole('button', { name: 'Last conversation' }))
    const search = new URLSearchParams(window.location.search)
    expect(window.location.pathname).toBe('/mail/inbox')
    expect(search.get('q')).toBe('from:alice@x.test')
    expect(search.get('scope')).toBe('all')
  })

  it('opening moves focus into the popover; Escape closes it and restores focus to the trigger', async () => {
    const user = await open(alice)
    // Wait for the async cards to settle so the surface is stable before asserting.
    await screen.findByRole('button', { name: 'Add to Contacts' })
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }))
  })

  it('has no axe violations while open', async () => {
    await open(alice)
    await screen.findByRole('button', { name: 'Add to Contacts' })
    await expectNoA11yViolations()
  })
})

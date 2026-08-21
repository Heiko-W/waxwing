/**
 * The incoming-share card, once it has to describe more than one kind of thing (S-1 → S-2).
 *
 * Until now the strip could say one noun, because mail was the only rail with one. It now receives
 * `Calendar` and `AddressBook` notifications on the same channel (measured: the server sends one per
 * type), and the failure this file exists to prevent is the quiet one — a calendar share announced
 * as "shared the folder with you", which is not a rendering glitch but a false statement about what
 * somebody has given away.
 *
 * The second claim is about a button that must NOT be there. Following a calendar or address-book
 * share would mean opening a foreign account's rail, and neither screen can scope itself to one yet.
 * An Open that led back to the reader's own empty list is worse than no Open at all.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IncomingShares } from './IncomingShares'
import type { ShareAnnouncement } from './incoming'

function announcement(over: Partial<ShareAnnouncement> = {}): ShareAnnouncement {
  return {
    id: 'n1',
    accountId: 'd',
    objectId: 'a',
    objectType: 'Mailbox',
    change: 'granted',
    who: 'Carol Chen',
    created: '2026-08-21T15:51:08Z',
    ...over,
  }
}

function renderStrip(
  announcements: readonly ShareAnnouncement[],
  options: {
    name?: string | null
    onOpen?: ((announcement: ShareAnnouncement) => void) | undefined
    onDismiss?: (id: string) => void
  } = {},
) {
  return render(
    <IncomingShares
      announcements={announcements}
      nameOf={() => options.name ?? null}
      {...(options.onOpen === undefined ? {} : { onOpen: options.onOpen })}
      onDismiss={options.onDismiss ?? (() => {})}
    />,
  )
}

describe('naming what was shared', () => {
  it('says "folder" for a Mailbox', () => {
    renderStrip([announcement()], { name: 'Projekt' })
    expect(screen.getByText('Carol Chen shared the folder “Projekt” with you.')).toBeInTheDocument()
  })

  it('says "calendar" for a Calendar — not "folder"', () => {
    renderStrip([announcement({ objectType: 'Calendar' })], { name: 'Projekt' })
    expect(
      screen.getByText('Carol Chen shared the calendar “Projekt” with you.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/folder/i)).not.toBeInTheDocument()
  })

  it('says "contact list" for an AddressBook', () => {
    renderStrip([announcement({ objectType: 'AddressBook' })], { name: 'Team' })
    expect(
      screen.getByText('Carol Chen shared the contact list “Team” with you.'),
    ).toBeInTheDocument()
  })

  it('falls back to a wording that names nothing for a type it does not know', () => {
    // `FileNode` today — no rail subscribes the strip to it, and inventing a noun for whatever the
    // server sends next is how "folder" got onto a calendar in the first place.
    renderStrip([announcement({ objectType: 'FileNode' })], { name: 'Berichte' })
    expect(screen.getByText('Carol Chen shared “Berichte” with you.')).toBeInTheDocument()
  })
})

describe('when the caller cannot resolve a name', () => {
  it('still names the KIND for a calendar', () => {
    renderStrip([announcement({ objectType: 'Calendar' })])
    expect(screen.getByText('Carol Chen shared a calendar with you.')).toBeInTheDocument()
  })

  it('still names the KIND for an address book', () => {
    renderStrip([announcement({ objectType: 'AddressBook' })])
    expect(screen.getByText('Carol Chen shared a contact list with you.')).toBeInTheDocument()
  })

  it('leaves the mail wording exactly as it was', () => {
    renderStrip([announcement()])
    expect(screen.getByText('Carol Chen shared a mail folder with you.')).toBeInTheDocument()
  })
})

describe('a revoke', () => {
  it('needs no noun when the name is known — the sentence already works for every type', () => {
    renderStrip([announcement({ objectType: 'Calendar', change: 'revoked' })], { name: 'Projekt' })
    expect(screen.getByText('Carol Chen withdrew your access to “Projekt”.')).toBeInTheDocument()
  })

  it('names the kind when the name is not known', () => {
    renderStrip([announcement({ objectType: 'Calendar', change: 'revoked' })])
    expect(screen.getByText('Carol Chen withdrew your access to a calendar.')).toBeInTheDocument()
  })

  it('never offers Open, whatever the type', () => {
    renderStrip([announcement({ objectType: 'Calendar', change: 'revoked' })], {
      onOpen: () => {},
    })
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
  })
})

describe('the Open button', () => {
  it('is there when the caller can follow the share', async () => {
    const onOpen = vi.fn()
    renderStrip([announcement()], { onOpen })
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
  })

  /*
   * The calendar and contacts case. Not a styling preference: there is no route to a foreign
   * account's calendar or address book, so the button would land the reader back in their own.
   */
  it('is absent when the caller passes no `onOpen`', () => {
    renderStrip([announcement({ objectType: 'Calendar' })])
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
  })

  it('leaves Hide available even then, so the card can still be dealt with', async () => {
    const onDismiss = vi.fn()
    renderStrip([announcement({ objectType: 'AddressBook' })], { onDismiss })
    await userEvent.click(screen.getByRole('button', { name: 'Hide this notice' }))
    expect(onDismiss).toHaveBeenCalledWith('n1')
  })
})

describe('nothing to say', () => {
  it('renders nothing at all for an empty list', () => {
    const { container } = renderStrip([])
    expect(container).toBeEmptyDOMElement()
  })
})

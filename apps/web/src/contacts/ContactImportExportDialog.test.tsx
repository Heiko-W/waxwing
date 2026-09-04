import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ContactCard } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import type { AddressBookRow } from '../sync'
import { addressBook, contactCard } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import ContactImportExportDialog from './ContactImportExportDialog'
import type { CardLike } from './contact-fields'

const CRLF = '\r\n'
// Two importable cards (Alice, Bob) plus one unparsable line — a real skipped-line to surface.
const TWO_CARDS = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:urn:uuid:alice',
  'FN:Alice Anderson',
  'EMAIL:alice@example.test',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:urn:uuid:bob',
  'FN:Bob Baker',
  'THIS IS NOT A LINE',
  'EMAIL:bob@example.test',
  'END:VCARD',
  '',
].join(CRLF)

const BOOKS: AddressBookRow[] = [{ ...addressBook('book1', { name: 'Personal' }), accountId: 'a' }]

type Props = React.ComponentProps<typeof ContactImportExportDialog>

function renderDialog(overrides: Partial<Props> = {}) {
  const createCards = vi
    .fn<(cards: readonly ContactCard[]) => Promise<string[]>>()
    .mockImplementation(async (cards) => cards.map((_, i) => `created-${i}`))
  /** Every card handed to `createCards`, flattened — what the per-card assertions read. */
  const created = () => createCards.mock.calls.flatMap((call) => call[0])
  const onClose = vi.fn()
  const props: Props = {
    open: true,
    onClose,
    books: BOOKS,
    existingCards: [],
    exportCards: [],
    exportFilenameStem: 'contacts',
    allowImport: true,
    defaultBookId: 'book1',
    createCards,
    ...overrides,
  }
  render(<ContactImportExportDialog {...props} />)
  return { createCards, created, onClose }
}

function vcardFile(text = TWO_CARDS): File {
  return new File([text], 'contacts.vcf', { type: 'text/vcard' })
}

describe('ContactImportExportDialog — import', () => {
  it('parses a picked file and creates one card per contact in the target book', async () => {
    const user = userEvent.setup()
    const { createCards, created } = renderDialog()

    await user.upload(screen.getByLabelText('Choose a file (.vcf or .json)'), vcardFile())

    // The skipped line is surfaced, not hidden.
    expect(await screen.findByText('1 line could not be read')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    await waitFor(() => expect(created()).toHaveLength(2))
    // Two cards, ONE call: the block is the commit (N-04).
    expect(createCards).toHaveBeenCalledTimes(1)
    expect(created()[0]?.addressBookIds).toEqual({ book1: true })
    expect(await screen.findByText('2 contacts imported.')).toBeInTheDocument()
  })

  it('skips duplicates by default and lets "keep both" import them anyway', async () => {
    const user = userEvent.setup()
    const existing: CardLike[] = [
      { uid: 'x', emails: { e1: { '@type': 'EmailAddress', address: 'alice@example.test' } } },
    ]
    const { created } = renderDialog({ existingCards: existing })

    await user.upload(screen.getByLabelText('Choose a file (.vcf or .json)'), vcardFile())

    // Alice is a duplicate (email), Bob is new → default skip creates only Bob.
    expect(await screen.findByText('1 duplicate found')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Import 1 contact' })).toBeInTheDocument()

    await user.click(screen.getByLabelText('Import duplicates anyway (keep both)'))
    await user.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    await waitFor(() => expect(created()).toHaveLength(2))
  })

  /**
   * N-04 — a big import is dispatched in BLOCKS, not one card at a time.
   *
   * Every separate create was its own Dexie transaction, and every commit re-ran the shared
   * whole-table contact-card subscription (R-21). Measured on fake-indexeddb: 500 cards into a book
   * that already held 500 took 15.4 s with 500 reruns, and 450 ms with ten. The assertion here is
   * the SHAPE of the dispatch — the numbers are pinned where the commit happens
   * (`engine.test.ts`), because a wall-clock assertion in jsdom is a flaky test.
   */
  it('imports a large file in blocks, and still reports every card', async () => {
    const user = userEvent.setup()
    const many = [
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nEND:VCARD',
      ...Array.from(
        { length: 119 },
        (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:P${i}\r\nEMAIL:p${i}@example.test\r\nEND:VCARD`,
      ),
    ].join('\r\n')
    const { createCards, created } = renderDialog()

    await user.upload(
      screen.getByLabelText('Choose a file (.vcf or .json)'),
      new File([many], 'many.vcf'),
    )
    await user.click(await screen.findByRole('button', { name: 'Import 120 contacts' }))

    await waitFor(() => expect(created()).toHaveLength(120), { timeout: 5000 })
    // 120 cards ⇒ 50 + 50 + 20. Not 120 calls, and not one call of 120: the block size is what
    // keeps the progress bar moving and Cancel answerable.
    expect(createCards.mock.calls.map((call) => call[0].length)).toEqual([50, 50, 20])
    expect(await screen.findByText('120 contacts imported.')).toBeInTheDocument()
  })

  /**
   * An import that STOPS says so, with the two numbers that matter.
   *
   * `onConfirmImport` was a `try/finally` with no `catch`: a throw from the dispatch left an
   * unhandled rejection in the console and nothing at all on screen — the progress bar vanished,
   * no count, no explanation. That is the same defect R-55 fixed in the Download half of this very
   * dialog, and the block commit (N-04) raised the stake: what is lost on a throw is a block, not
   * a card, so the reader has even more reason to be told.
   *
   * The cards already written STAY written. `done` counts committed blocks only, so "X of Y" is a
   * fact about the address book rather than an estimate, and picking the file again really is a
   * way forward: every written card carries its source `uid`, so the second pass dedupes them out.
   */
  it('says how far a failed import got, instead of falling silent', async () => {
    const user = userEvent.setup()
    const many = Array.from(
      { length: 120 },
      (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:P${i}\r\nEMAIL:p${i}@example.test\r\nEND:VCARD`,
    ).join('\r\n')
    let calls = 0
    const createCards = vi.fn(async (cards: readonly ContactCard[]) => {
      calls += 1
      // The first block commits; the second throws, as a Dexie failure or a torn-down engine does.
      if (calls > 1) throw new Error('replica gone')
      return cards.map((_, i) => `created-${i}`)
    })
    renderDialog({ createCards })

    await user.upload(
      screen.getByLabelText('Choose a file (.vcf or .json)'),
      new File([many], 'many.vcf'),
    )
    await user.click(await screen.findByRole('button', { name: 'Import 120 contacts' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('50 of 120 contacts were imported before the import stopped.')
    // Not ALSO the success line — one outcome, one sentence.
    expect(screen.queryByText('120 contacts imported.')).not.toBeInTheDocument()
    expect(screen.queryByText('50 contacts imported.')).not.toBeInTheDocument()
    // The dialog is usable again: the file is spent, the picker is the way on, and no progress bar
    // is left spinning over an import that has stopped.
    expect(screen.getByLabelText('Choose a file (.vcf or .json)')).toBeEnabled()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Import / })).not.toBeInTheDocument()
  })

  it('clears a previous failure when the next file is picked', async () => {
    const user = userEvent.setup()
    const createCards = vi.fn(async () => {
      throw new Error('replica gone')
    })
    renderDialog({ createCards })

    await user.upload(screen.getByLabelText('Choose a file (.vcf or .json)'), vcardFile())
    await user.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('0 of 2 contacts were imported')

    await user.upload(screen.getByLabelText('Choose a file (.vcf or .json)'), vcardFile())
    await screen.findByRole('button', { name: 'Import 2 contacts' })
    // A stale failure over a fresh file is a lie about the file on screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a file that cannot be read', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.upload(
      screen.getByLabelText('Choose a file (.vcf or .json)'),
      new File(['{ not json'], 'contacts.json', { type: 'application/json' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read/)
  })
})

describe('ContactImportExportDialog — export', () => {
  it('serialises the selection and triggers a download', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const user = userEvent.setup()
      const exportCards = [
        contactCard('c1', {
          emails: { e1: { '@type': 'EmailAddress', address: 'a@x.test' } },
        }) as ContactCard,
      ]
      renderDialog({ allowImport: false, exportCards })

      await user.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() => expect(click).toHaveBeenCalledOnce())
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('names the failure instead of doing nothing visible', async () => {
    // `onExport` was a `try/finally` with no `catch`: a throw below it became an unhandled promise
    // rejection in the console, and the dialog stood there unchanged. Pressing Download did nothing.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        throw new Error('no object URLs here')
      },
      revokeObjectURL: vi.fn(),
    })
    try {
      const user = userEvent.setup()
      renderDialog({ allowImport: false, exportCards: [contactCard('c1') as ContactCard] })
      await user.click(screen.getByRole('button', { name: 'Download' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not be prepared/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says so when there is nothing to export', () => {
    renderDialog({ allowImport: false, exportCards: [] })
    expect(screen.getByText('There are no contacts to export.')).toBeInTheDocument()
  })
})

describe('ContactImportExportDialog — a11y', () => {
  it('has no axe violations', async () => {
    renderDialog()
    // The Dialog renders through a portal, so scan document.body, not the RTL container.
    await expectNoA11yViolations()
  })
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Identity } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { putIdentities, type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { useComposerStore } from './composer-store'
import { FromField } from './FromField'
import { SIGNATURE_ATTR } from './signature'

function identity(over: Partial<Identity> & Pick<Identity, 'id' | 'email'>): Identity {
  return {
    name: '',
    replyTo: null,
    bcc: null,
    textSignature: '',
    htmlSignature: '',
    mayDelete: false,
    ...over,
  }
}

const store = () => useComposerStore.getState()

/** Subscribe to the live draft so the seeding/swap re-renders FromField (the window does this). */
function Harness({ id }: { id: string }) {
  const draft = useComposerStore((state) => state.drafts.get(id))
  return draft === undefined ? null : <FromField draft={draft} />
}

function renderFrom(id: string, db: ReplicaDb) {
  return render(
    <ReplicaProvider accountId="a" db={db}>
      <Harness id={id} />
    </ReplicaProvider>,
  )
}

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
})
afterEach(async () => {
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
  await db.delete()
})

describe('FromField', () => {
  it('lists identities and seeds the default identity signature above the quote', async () => {
    await putIdentities(db, 'a', [
      identity({
        id: 'id-1',
        name: 'AAA',
        email: 'alice@x.test',
        htmlSignature: '<div>Sig One</div>',
      }),
      identity({
        id: 'id-2',
        name: 'ZZZ',
        email: 'alias@x.test',
        htmlSignature: '<div>Sig Two</div>',
      }),
    ])
    const id = store().openDraft({ body: '<p>my draft text</p>' })
    renderFrom(id, db)

    // The From selector shows both identities as "Name <email>".
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'AAA <alice@x.test>' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'ZZZ <alias@x.test>' })).toBeInTheDocument()

    // The default (first) identity's signature is seeded, without marking the draft dirty.
    await waitFor(() => expect(store().drafts.get(id)?.fromIdentityId).toBe('id-1'))
    expect(store().drafts.get(id)?.body).toContain(SIGNATURE_ATTR)
    expect(store().drafts.get(id)?.body).toContain('Sig One')
    expect(store().drafts.get(id)?.body).toContain('my draft text')
    expect(store().drafts.get(id)?.dirty).toBe(false)
  })

  it('swaps the signature when the identity changes, preserving the user text', async () => {
    await putIdentities(db, 'a', [
      identity({
        id: 'id-1',
        name: 'AAA',
        email: 'alice@x.test',
        htmlSignature: '<div>Sig One</div>',
      }),
      identity({
        id: 'id-2',
        name: 'ZZZ',
        email: 'alias@x.test',
        htmlSignature: '<div>Sig Two</div>',
      }),
    ])
    const id = store().openDraft({ body: '<p>my draft text</p>' })
    renderFrom(id, db)
    await waitFor(() => expect(store().drafts.get(id)?.fromIdentityId).toBe('id-1'))

    await userEvent.selectOptions(screen.getByRole('combobox'), 'id-2')
    await waitFor(() => expect(store().drafts.get(id)?.fromIdentityId).toBe('id-2'))
    const body = store().drafts.get(id)?.body ?? ''
    expect(body).toContain('Sig Two')
    expect(body).not.toContain('Sig One')
    expect(body).toContain('my draft text')
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })

  it('seeds the signature but shows no selector for a single identity', async () => {
    await putIdentities(db, 'a', [
      identity({
        id: 'only',
        name: 'Solo',
        email: 'solo@x.test',
        htmlSignature: '<div>Solo Sig</div>',
      }),
    ])
    const id = store().openDraft()
    renderFrom(id, db)
    await waitFor(() => expect(store().drafts.get(id)?.fromIdentityId).toBe('only'))
    expect(store().drafts.get(id)?.body).toContain('Solo Sig')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('honours the belowQuote signature placement (M3.7, FR-CMP-02)', async () => {
    await setPref(db, 'a', 'compose.signaturePlacement', 'belowQuote')
    await putIdentities(db, 'a', [
      identity({ id: 'i1', email: 'a@x.test', htmlSignature: '<p>Sig</p>' }),
    ])
    store().openDraft({ id: 'd-below', body: '<blockquote>quoted</blockquote>' })
    renderFrom('d-below', db)

    await waitFor(() => {
      const body = store().drafts.get('d-below')?.body ?? ''
      expect(body).toContain(SIGNATURE_ATTR)
      // Below the quote: the signature marker comes AFTER the quoted block.
      expect(body.indexOf('</blockquote>')).toBeLessThan(body.indexOf(SIGNATURE_ATTR))
    })
  })

  it('has no a11y violations', async () => {
    await putIdentities(db, 'a', [
      identity({ id: 'id-1', name: 'AAA', email: 'alice@x.test' }),
      identity({ id: 'id-2', name: 'ZZZ', email: 'alias@x.test' }),
    ])
    const id = store().openDraft()
    const { container } = renderFrom(id, db)
    await screen.findByRole('combobox')
    await expectNoA11yViolations(container)
  })
})

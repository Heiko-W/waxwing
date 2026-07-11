import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type OpenDraftInit, useComposerStore } from './composer-store'
import { RecipientFields } from './RecipientFields'
import type { RecipientSuggestionSource } from './recipient-suggestions'

const emptySource: RecipientSuggestionSource = { query: async () => [] }
const store = () => useComposerStore.getState()

beforeEach(() => useComposerStore.setState({ drafts: new Map(), focusedId: undefined }))
afterEach(() => useComposerStore.setState({ drafts: new Map(), focusedId: undefined }))

function Harness({ id }: { id: string }) {
  const draft = useComposerStore((state) => state.drafts.get(id))
  return draft ? <RecipientFields draft={draft} suggestionSource={emptySource} /> : null
}

function renderFields(init?: OpenDraftInit): string {
  const id = store().openDraft(init)
  render(<Harness id={id} />)
  return id
}

describe('RecipientFields', () => {
  it('reveals the Cc field via its toggle', async () => {
    renderFields()
    expect(screen.queryByText('Cc')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show Cc field' }))
    expect(screen.getByText('Cc')).toBeInTheDocument()
  })

  it('auto-shows Cc when a reply seeded it', () => {
    renderFields({ cc: [{ name: null, email: 'c@x.com' }] })
    expect(screen.getByText('Cc')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Cc field' })).not.toBeInTheDocument()
  })

  it('offers a "did you mean" correction and applies it to the last To address', async () => {
    const id = renderFields({ to: [{ name: null, email: 'user@gmial.com' }] })
    expect(screen.getByText(/Did you mean user@gmail\.com\?/)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use user@gmail.com' }))
    expect(store().drafts.get(id)?.to).toEqual([{ name: null, email: 'user@gmail.com' }])
  })

  it('commits a typed recipient into the store and marks the draft dirty', async () => {
    const id = renderFields()
    const to = screen.getAllByRole('combobox')[0] as HTMLElement
    await userEvent.setup().type(to, 'a@x.com{Enter}')
    expect(store().drafts.get(id)?.to).toEqual([{ name: null, email: 'a@x.com' }])
    expect(store().drafts.get(id)?.dirty).toBe(true)
  })
})

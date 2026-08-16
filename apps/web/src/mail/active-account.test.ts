import { afterEach, describe, expect, it } from 'vitest'
import {
  resetMailScopedStores,
  resolveActiveAccount,
  useActiveAccountStore,
} from './active-account'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { type ReadingHandlers, useReadingStore } from './reading-store'

const ACCOUNTS = [{ id: 'acctP' }, { id: 'acctS' }] as const

afterEach(() => {
  useActiveAccountStore.getState().reset()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
})

describe('resolveActiveAccount', () => {
  it('falls back to the primary when nothing is stored', () => {
    expect(resolveActiveAccount(null, ACCOUNTS, 'acctP')).toBe('acctP')
  })

  it('uses the stored account when it is still granted', () => {
    expect(resolveActiveAccount('acctS', ACCOUNTS, 'acctP')).toBe('acctS')
  })

  it('falls back to the primary when the stored account is no longer granted (stale singleton)', () => {
    expect(resolveActiveAccount('gone', ACCOUNTS, 'acctP')).toBe('acctP')
  })
})

describe('resetMailScopedStores', () => {
  it('clears the list window/selection and the open message handlers', () => {
    useListStore.setState({
      windowKey: 'k',
      ids: ['e1'],
      selection: { selected: new Set(['e1']), anchor: 'e1', base: new Set() },
      sourceMailboxId: 'a',
    })
    useReadingStore.setState({
      handlers: { emailId: 'e1', mailboxId: 'a' } as unknown as ReadingHandlers,
    })

    resetMailScopedStores()

    expect(useListStore.getState().windowKey).toBe('')
    expect(useListStore.getState().ids).toHaveLength(0)
    expect(useListStore.getState().selection.selected.size).toBe(0)
    expect(useReadingStore.getState().handlers).toBeNull()
  })
})

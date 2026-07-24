import { renderHook } from '@testing-library/react'
import type { ContactCard } from '@waxwing/jmap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActiveEngine } from '../sync/engine'
import { contactCard } from '../sync/test-utils'
import { useContactActions } from './use-contact-actions'

afterEach(() => setActiveEngine(null))

function fakeEngine() {
  const dispatch = vi.fn().mockResolvedValue(undefined)
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  return dispatch
}

describe('useContactActions', () => {
  it('dispatches a createContactCard intent for create', async () => {
    const dispatch = fakeEngine()
    const { result } = renderHook(() => useContactActions())
    await result.current.create(contactCard('c1') as ContactCard)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'createContactCard' })
  })

  it('dispatches an updateContactCard intent carrying the patch', () => {
    const dispatch = fakeEngine()
    const { result } = renderHook(() => useContactActions())
    result.current.update('c1', { name: { '@type': 'Name', full: 'X' } })
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'updateContactCard',
      id: 'c1',
      patch: { name: { '@type': 'Name', full: 'X' } },
    })
  })

  it('dispatches a deleteContactCard intent for remove', () => {
    const dispatch = fakeEngine()
    const { result } = renderHook(() => useContactActions())
    result.current.remove('c1')
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'deleteContactCard', id: 'c1' })
  })

  it('is a safe no-op with no running engine', async () => {
    const { result } = renderHook(() => useContactActions())
    await expect(result.current.create(contactCard('c1') as ContactCard)).resolves.toBe('c1')
    expect(() => result.current.remove('c1')).not.toThrow()
  })
})

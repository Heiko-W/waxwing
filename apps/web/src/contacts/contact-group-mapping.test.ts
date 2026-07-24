import type { ContactCard } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  createGroupCard,
  diffGroupPatch,
  groupMemberUids,
  groupName,
  groupToDraft,
  isGroupCard,
} from './contact-group-mapping'

let counter = 0
const newId = (): string => `id-${counter++}`

function group(over: Partial<ContactCard> = {}): ContactCard {
  return {
    '@type': 'Card',
    version: '1.0',
    uid: 'g-uid',
    id: 'g1',
    addressBookIds: { book1: true },
    kind: 'group',
    ...over,
  }
}

describe('createGroupCard', () => {
  it('builds a kind:"group" card with a full name and a members set from the picked uids', () => {
    counter = 0
    const card = createGroupCard({ name: 'Team', memberUids: ['u1', 'u2'] }, 'book1', newId)
    expect(card.kind).toBe('group')
    expect(card['@type']).toBe('Card')
    expect(card.name).toEqual({ '@type': 'Name', full: 'Team' })
    expect(card.members).toEqual({ u1: true, u2: true })
    expect(card.addressBookIds).toEqual({ book1: true })
    // The stable JSContact uid is minted first; the JMAP id is a separate placeholder.
    expect(card.uid).toBe('id-0')
  })

  it('omits members entirely for a group created with none', () => {
    counter = 0
    const card = createGroupCard({ name: 'Empty', memberUids: [] }, 'book1', newId)
    expect(card.members).toBeUndefined()
  })

  it('trims the name and drops it when blank', () => {
    counter = 0
    const named = createGroupCard({ name: '  Padded  ', memberUids: [] }, 'book1', newId)
    expect(named.name).toEqual({ '@type': 'Name', full: 'Padded' })
    counter = 0
    const blank = createGroupCard({ name: '   ', memberUids: [] }, 'book1', newId)
    expect(blank.name).toBeUndefined()
  })
})

describe('diffGroupPatch', () => {
  it('emits a single-key name patch for a rename', () => {
    const original = group({ name: { '@type': 'Name', full: 'Team' }, members: { u1: true } })
    const patch = diffGroupPatch(original, { name: 'Squad', memberUids: ['u1'] })
    expect(Object.keys(patch)).toEqual(['name'])
    expect(patch.name).toEqual({ '@type': 'Name', full: 'Squad' })
  })

  it('emits a single-key members patch when a member is added', () => {
    const original = group({ name: { full: 'Team' }, members: { u1: true } })
    const patch = diffGroupPatch(original, { name: 'Team', memberUids: ['u1', 'u2'] })
    expect(Object.keys(patch)).toEqual(['members'])
    expect(patch.members).toEqual({ u1: true, u2: true })
  })

  it('emits a members patch when a member is removed', () => {
    const original = group({ name: { full: 'Team' }, members: { u1: true, u2: true } })
    const patch = diffGroupPatch(original, { name: 'Team', memberUids: ['u1'] })
    expect(patch).toEqual({ members: { u1: true } })
  })

  it('removes members with null when the last one is taken out', () => {
    const original = group({ name: { full: 'Team' }, members: { u1: true } })
    const patch = diffGroupPatch(original, { name: 'Team', memberUids: [] })
    expect(patch).toEqual({ members: null })
  })

  it('is empty when nothing changed', () => {
    const original = group({ name: { full: 'Team' }, members: { u1: true } })
    expect(diffGroupPatch(original, { name: 'Team', memberUids: ['u1'] })).toEqual({})
  })

  it('leaves unmapped properties (uid, addressBookIds, vCardProps) out of the patch', () => {
    const original = group({
      name: { full: 'Team' },
      members: { u1: true },
      vCardProps: [['x-foo', {}, 'text', 'bar']],
    })
    const patch = diffGroupPatch(original, { name: 'Team', memberUids: ['u1', 'u2'] })
    expect(Object.keys(patch)).toEqual(['members'])
  })
})

describe('helpers', () => {
  it('groupToDraft reads the name and member uids in order', () => {
    const card = group({ name: { full: 'Team' }, members: { u1: true, u2: true } })
    expect(groupToDraft(card)).toEqual({ name: 'Team', memberUids: ['u1', 'u2'] })
  })

  it('isGroupCard / groupMemberUids / groupName', () => {
    const card = group({ name: { full: 'Team' }, members: { u1: true } })
    expect(isGroupCard(card)).toBe(true)
    expect(isGroupCard({ ...card, kind: 'individual' })).toBe(false)
    expect(groupMemberUids(card)).toEqual(['u1'])
    expect(groupName(card)).toBe('Team')
  })
})

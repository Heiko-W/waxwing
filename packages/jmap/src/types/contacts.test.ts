import { describe, expect, it } from 'vitest'
import { bearer } from '../auth'
import { Capabilities, capabilityForMethod, usingForMethods } from '../capabilities'
import { JmapClient } from '../client'
import { Methods } from '../methods'
import { getContactsCapability } from '../session'
import { at, jmapPostMock, makeSession } from '../test-support'
import type {
  AddressBook,
  AddressBookSetRequest,
  ContactCard,
  ContactCardFilterCondition,
  ContactCardMedia,
  ContactsCapability,
} from './contacts'
import type { Invocation } from './core'

describe('Contacts method registry (RFC 9610)', () => {
  it('binds each method key to its wire name', () => {
    expect(Methods.addressBookGet.name).toBe('AddressBook/get')
    expect(Methods.addressBookChanges.name).toBe('AddressBook/changes')
    expect(Methods.addressBookSet.name).toBe('AddressBook/set')
    expect(Methods.contactCardGet.name).toBe('ContactCard/get')
    expect(Methods.contactCardChanges.name).toBe('ContactCard/changes')
    expect(Methods.contactCardQuery.name).toBe('ContactCard/query')
    expect(Methods.contactCardQueryChanges.name).toBe('ContactCard/queryChanges')
    expect(Methods.contactCardSet.name).toBe('ContactCard/set')
  })

  it('maps every AddressBook / ContactCard method to the contacts capability', () => {
    for (const name of [
      'AddressBook/get',
      'AddressBook/changes',
      'AddressBook/set',
      'ContactCard/get',
      'ContactCard/changes',
      'ContactCard/query',
      'ContactCard/queryChanges',
      'ContactCard/set',
    ]) {
      expect(capabilityForMethod(name)).toBe(Capabilities.contacts)
    }
  })

  it('resolves the `using` set to core + contacts for a mixed batch', () => {
    const using = usingForMethods([Methods.contactCardQuery.name, Methods.addressBookGet.name])
    expect(using).toContain(Capabilities.core)
    expect(using).toContain('urn:ietf:params:jmap:contacts')
    expect(using).toEqual([...using].sort())
  })
})

describe('ContactCard/query → ContactCard/get back-reference (typed invoke)', () => {
  it('chains in one round-trip, auto-adds the contacts capability and infers ContactCard[]', async () => {
    const ab = 'ab-personal'
    const cards = [
      {
        '@type': 'Card',
        version: '1.0',
        id: 'card-1',
        uid: 'urn:uuid:11111111-1111-1111-1111-111111111111',
        addressBookIds: { [ab]: true },
        name: { full: 'Ada Lovelace' },
        emails: { e1: { address: 'ada@waxwing.test' } },
        // The server externalised the photo: a blobId stands in for a data: URI.
        media: { photo1: { '@type': 'Media', kind: 'photo', blobId: 'blob-photo-1' } },
      },
    ]

    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's0',
      methodResponses: body.methodCalls.map(([name, rawArgs, id]): Invocation => {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        if (name === 'ContactCard/query') {
          return [
            name,
            {
              accountId: args.accountId,
              queryState: 'q1',
              canCalculateChanges: true,
              position: 0,
              ids: ['card-1'],
              total: 1,
            },
            id,
          ]
        }
        if (name === 'ContactCard/get') {
          return [name, { accountId: args.accountId, state: 'g1', list: cards, notFound: [] }, id]
        }
        return [name, args, id]
      }),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const query = builder.invoke(Methods.contactCardQuery, {
      accountId: 'a',
      filter: { inAddressBook: ab, text: 'lovelace' },
      sort: [{ property: 'name/surname', isAscending: true }],
    })
    const get = builder.invoke(Methods.contactCardGet, {
      accountId: 'a',
      '#ids': query.ref('/ids'),
      properties: ['id', 'uid', 'name', 'emails', 'media'],
    })
    const result = await builder.send()

    expect(calls).toHaveLength(1)
    const sent = at(calls, 0).body.methodCalls
    expect(at(sent, 0)[0]).toBe('ContactCard/query')
    expect(at(sent, 1)[0]).toBe('ContactCard/get')
    expect(at(sent, 1)[1]).toMatchObject({
      '#ids': { resultOf: query.callId, name: 'ContactCard/query', path: '/ids' },
    })
    expect(at(calls, 0).body.using).toContain('urn:ietf:params:jmap:contacts')

    const queryResult = result.get(query)
    expect(queryResult.ids).toEqual(['card-1'])

    const card = at(result.get(get).list, 0)
    // JMAP id and JSContact uid are distinct identities.
    expect(card.id).toBe('card-1')
    expect(card.uid).toBe('urn:uuid:11111111-1111-1111-1111-111111111111')
    expect(card.addressBookIds).toEqual({ [ab]: true })
    expect(card.media?.photo1?.blobId).toBe('blob-photo-1')
    expect(card.media?.photo1?.uri).toBeUndefined()
  })
})

describe('AddressBook/get (typed invoke)', () => {
  it('parses an address book with description, default flag and rights', async () => {
    const books = [
      {
        id: 'ab-personal',
        name: 'Personal',
        description: null,
        sortOrder: 0,
        isDefault: true,
        isSubscribed: true,
        myRights: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
      },
    ]
    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's0',
      methodResponses: body.methodCalls.map(([name, rawArgs, id]): Invocation => {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        if (name === 'AddressBook/get') {
          return [name, { accountId: args.accountId, state: 'ab1', list: books, notFound: [] }, id]
        }
        return [name, args, id]
      }),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const handle = builder.invoke(Methods.addressBookGet, { accountId: 'a', ids: null })
    const response = (await builder.send()).get(handle)

    expect(at(calls, 0).body.using).toContain('urn:ietf:params:jmap:contacts')
    const book = at(response.list, 0)
    expect(book.isDefault).toBe(true)
    expect(book.description).toBeNull()
    expect(book.myRights.mayWrite).toBe(true)
    expect(book.myRights.mayDelete).toBe(false)
  })
})

describe('getContactsCapability (RFC 9610 §1.5)', () => {
  it('reads the limits from the ACCOUNT capability', () => {
    const session = makeSession()
    session.accounts.a = {
      ...at(Object.values(session.accounts), 0),
      accountCapabilities: {
        'urn:ietf:params:jmap:contacts': {
          maxAddressBooksPerCard: 1,
          mayCreateAddressBook: true,
        },
      },
    }
    expect(getContactsCapability(session, 'a')?.mayCreateAddressBook).toBe(true)
    expect(getContactsCapability(session, 'a')?.maxAddressBooksPerCard).toBe(1)
  })

  it('returns null for an unknown account or a missing capability', () => {
    const session = makeSession() // the fixture account has accountCapabilities: {}
    expect(getContactsCapability(session, 'nope')).toBeNull()
    expect(getContactsCapability(session, 'a')).toBeNull()
  })

  it('returns null for a malformed capability rather than a bad object', () => {
    const session = makeSession()
    session.accounts.a = {
      ...at(Object.values(session.accounts), 0),
      accountCapabilities: { 'urn:ietf:params:jmap:contacts': { maxAddressBooksPerCard: 1 } },
    }
    expect(getContactsCapability(session, 'a')).toBeNull()
  })
})

// ── Type-level assertions (no `expectTypeOf` in this repo — use typed literals) ─────────────────

describe('Contacts wire-type shapes (type-level)', () => {
  it('a ContactCard is a JSContact Card plus the JMAP identity fields', () => {
    const card: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'urn:uuid:22222222-2222-2222-2222-222222222222',
      id: 'card-2',
      addressBookIds: { 'ab-work': true },
      name: { full: 'Grace Hopper' },
      // Both media shapes are valid: a plain data/URI photo and a blob-backed one.
      media: {
        withUri: { '@type': 'Media', kind: 'logo', uri: 'https://waxwing.test/logo.png' },
        withBlob: { '@type': 'Media', kind: 'photo', blobId: 'blob-2' },
      },
      // vCardProps rides through untouched — the round-trip preservation guarantee.
      vCardProps: [['x-vendor', {}, 'text', 'kept']],
    }
    expect(card.id).toBe('card-2')
    expect(card.uid).not.toBe(card.id)
    expect(card.media?.withBlob?.blobId).toBe('blob-2')

    const media: ContactCardMedia = { '@type': 'Media', kind: 'photo', blobId: 'b' }
    expect(media.uri).toBeUndefined()
  })

  it('a ContactCardFilterCondition accepts the slashed property keys', () => {
    const filter: ContactCardFilterCondition = {
      inAddressBook: 'ab-work',
      'name/given': 'Grace',
      'name/surname': 'Hopper',
      text: 'compiler',
    }
    expect(filter['name/given']).toBe('Grace')
  })

  it('an AddressBookSetRequest carries the RFC 9610 extras', () => {
    const set: AddressBookSetRequest = {
      accountId: 'a',
      create: { new1: { name: 'Team', description: null, sortOrder: 10, isSubscribed: true } },
      onDestroyRemoveContents: true,
      onSuccessSetIsDefault: '#new1',
    }
    expect(set.onDestroyRemoveContents).toBe(true)
    expect(set.onSuccessSetIsDefault).toBe('#new1')
  })

  it('an AddressBook and a ContactsCapability model their nullable fields', () => {
    const book: AddressBook = {
      id: 'ab-1',
      name: 'Personal',
      description: null,
      sortOrder: 0,
      isDefault: false,
      isSubscribed: true,
      myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
    }
    const cap: ContactsCapability = { maxAddressBooksPerCard: null, mayCreateAddressBook: false }
    expect(book.description).toBeNull()
    expect(cap.maxAddressBooksPerCard).toBeNull()
  })
})

import type { ContactCard } from '@waxwing/jmap'
import type { Address } from '@waxwing/jscontact'
import { describe, expect, it } from 'vitest'
import {
  type AddressEntry,
  type ContactFormModel,
  cardToForm,
  diffCardPatch,
  emptyFormModel,
  formToCard,
} from './contact-card-mapping'

/** A deterministic id source so a new map key is predictable in assertions. */
function idSource(): () => string {
  let n = 0
  return () => `gen-${n++}`
}

/**
 * A richly-populated card that exercises every branch: keyed maps with `pref`, features vs. contexts,
 * a `full`-only address, a birthday alongside a to-be-preserved wedding anniversary, a photo alongside
 * a to-be-preserved logo, and top-level properties the form never touches (`nicknames`, `keywords`,
 * `vCardProps`, plus an unknown vendor property).
 */
function richCard(): ContactCard {
  return {
    '@type': 'Card',
    version: '1.0',
    uid: 'urn:uuid:card-1',
    id: 'server-1',
    addressBookIds: { book1: true },
    kind: 'individual',
    name: {
      '@type': 'Name',
      full: 'Dr. Alice Q. Anderson',
      components: [
        { '@type': 'NameComponent', kind: 'title', value: 'Dr.' },
        { '@type': 'NameComponent', kind: 'given', value: 'Alice' },
        { '@type': 'NameComponent', kind: 'given2', value: 'Q.' },
        { '@type': 'NameComponent', kind: 'surname', value: 'Anderson' },
        { '@type': 'NameComponent', kind: 'credential', value: 'PhD' },
      ],
    },
    nicknames: { nk1: { '@type': 'Nickname', name: 'Ali' } },
    emails: {
      e1: {
        '@type': 'EmailAddress',
        address: 'alice@work.test',
        contexts: { work: true },
        pref: 1,
      },
      e2: { '@type': 'EmailAddress', address: 'alice@home.test', contexts: { private: true } },
    },
    phones: {
      p1: { '@type': 'Phone', number: '+49 30 1', features: { mobile: true }, label: 'primary' },
      p2: { '@type': 'Phone', number: '+49 30 2', contexts: { work: true } },
    },
    addresses: {
      a1: {
        '@type': 'Address',
        components: [
          { '@type': 'AddressComponent', kind: 'name', value: 'Main Street 1' },
          { '@type': 'AddressComponent', kind: 'locality', value: 'Berlin' },
          { '@type': 'AddressComponent', kind: 'postcode', value: '10115' },
        ],
        contexts: { work: true },
        countryCode: 'DE',
      },
      a2: { '@type': 'Address', full: 'PO Box 90210\nBeverly Hills' },
    },
    organizations: {
      o1: { '@type': 'Organization', name: 'Acme', units: [{ '@type': 'OrgUnit', name: 'R&D' }] },
    },
    titles: { t1: { '@type': 'Title', name: 'Engineer', kind: 'title' } },
    anniversaries: {
      an1: {
        '@type': 'Anniversary',
        kind: 'birth',
        date: { '@type': 'PartialDate', year: 1990, month: 4, day: 4 },
      },
      an2: {
        '@type': 'Anniversary',
        kind: 'wedding',
        date: { '@type': 'PartialDate', year: 2015, month: 6, day: 20 },
      },
    },
    notes: { n1: { '@type': 'Note', note: 'Met at conference' } },
    media: {
      m1: { '@type': 'Media', kind: 'photo', blobId: 'blob-1', mediaType: 'image/png' },
      m2: { '@type': 'Media', kind: 'logo', uri: 'https://example.test/logo.svg' },
    },
    keywords: { vip: true },
    vCardProps: [['x-vendor-thing', {}, 'text', 'keep me']],
  }
}

describe('contact-card-mapping round trip', () => {
  it('reproduces the card exactly when nothing is edited (keys, unknown props, vCardProps)', () => {
    const card = richCard()
    const back = formToCard(cardToForm(card), card, idSource())
    expect(back).toEqual(card)
  })

  it('yields an empty patch for an untouched card', () => {
    const card = richCard()
    const back = formToCard(cardToForm(card), card, idSource())
    expect(diffCardPatch(card, back)).toEqual({})
  })

  it('preserves the exact map keys and pref order of the communication collections', () => {
    const card = richCard()
    const form = cardToForm(card)
    expect(form.emails.map((e) => e.key)).toEqual(['e1', 'e2'])
    expect(form.phones.map((p) => p.key)).toEqual(['p1', 'p2'])
    expect(form.emails[0]?.type).toBe('work')
    expect(form.phones[0]?.type).toBe('mobile')
  })
})

describe('contact-card-mapping single-field edits', () => {
  it('emits ONLY the changed top-level property, reusing the entry key and its untouched fields', () => {
    const card = richCard()
    const form = cardToForm(card)
    const edited: ContactFormModel = {
      ...form,
      emails: form.emails.map((entry, index) =>
        index === 0 ? { ...entry, address: 'alice@new.test' } : entry,
      ),
    }
    const back = formToCard(edited, card, idSource())
    const patch = diffCardPatch(card, back)

    expect(Object.keys(patch)).toEqual(['emails'])
    // Whole-map replace, but with the SAME keys — e1 kept its context + pref, only the address moved.
    expect(patch.emails).toEqual({
      e1: { '@type': 'EmailAddress', address: 'alice@new.test', contexts: { work: true }, pref: 1 },
      e2: { '@type': 'EmailAddress', address: 'alice@home.test', contexts: { private: true } },
    })
  })

  it('changing a name component patches only `name` and drops the now-stale full name', () => {
    const card = richCard()
    const form = cardToForm(card)
    const edited: ContactFormModel = { ...form, name: { ...form.name, given: 'Alicia' } }
    const patch = diffCardPatch(card, formToCard(edited, card, idSource()))
    expect(Object.keys(patch)).toEqual(['name'])
    const name = patch.name as { full?: string; components: { kind: string; value: string }[] }
    expect(name.full).toBeUndefined()
    expect(name.components).toContainEqual({
      '@type': 'NameComponent',
      kind: 'given',
      value: 'Alicia',
    })
    // A non-editable component kind survives the rebuild.
    expect(name.components).toContainEqual({
      '@type': 'NameComponent',
      kind: 'credential',
      value: 'PhD',
    })
  })

  it('editing the job title leaves the organization untouched', () => {
    const card = richCard()
    const form = cardToForm(card)
    const edited: ContactFormModel = { ...form, title: 'Principal Engineer' }
    const patch = diffCardPatch(card, formToCard(edited, card, idSource()))
    expect(Object.keys(patch)).toEqual(['titles'])
    expect(patch.titles).toEqual({
      t1: { '@type': 'Title', name: 'Principal Engineer', kind: 'title' },
    })
  })
})

describe('contact-card-mapping map-key stability', () => {
  it('keeps existing keys and mints a fresh one only for a genuinely new row', () => {
    const card = richCard()
    const form = cardToForm(card)
    const newId = idSource()
    const edited: ContactFormModel = {
      ...form,
      emails: [...form.emails, { key: newId(), type: 'work', address: 'alice@third.test' }],
    }
    const back = formToCard(edited, card, newId)
    expect(Object.keys(back.emails ?? {})).toEqual(['e1', 'e2', 'gen-0'])
  })

  it('reuses the existing birthday key when the birthday changes and keeps other anniversaries', () => {
    const card = richCard()
    const form = cardToForm(card)
    expect(form.birthday).toBe('1990-04-04')
    const edited: ContactFormModel = { ...form, birthday: '1991-05-05' }
    const back = formToCard(edited, card, idSource())
    expect(back.anniversaries).toEqual({
      an1: {
        '@type': 'Anniversary',
        kind: 'birth',
        date: { '@type': 'PartialDate', year: 1991, month: 5, day: 5 },
      },
      an2: {
        '@type': 'Anniversary',
        kind: 'wedding',
        date: { '@type': 'PartialDate', year: 2015, month: 6, day: 20 },
      },
    })
  })
})

describe('contact-card-mapping photo', () => {
  it('replaces the photo blob under the same media key and keeps the logo', () => {
    const card = richCard()
    const form = cardToForm(card)
    expect(form.photo?.key).toBe('m1')
    expect(form.photo?.blobId).toBe('blob-1')
    const edited: ContactFormModel = {
      ...form,
      photo: { key: 'm1', blobId: 'blob-2', mediaType: 'image/jpeg' },
    }
    const back = formToCard(edited, card, idSource())
    expect(back.media).toEqual({
      m1: { '@type': 'Media', kind: 'photo', blobId: 'blob-2', mediaType: 'image/jpeg' },
      m2: { '@type': 'Media', kind: 'logo', uri: 'https://example.test/logo.svg' },
    })
  })

  it('removing the photo keeps the preserved logo and patches only media', () => {
    const card = richCard()
    const form = cardToForm(card)
    const back = formToCard({ ...form, photo: null }, card, idSource())
    const patch = diffCardPatch(card, back)
    expect(Object.keys(patch)).toEqual(['media'])
    expect(patch.media).toEqual({
      m2: { '@type': 'Media', kind: 'logo', uri: 'https://example.test/logo.svg' },
    })
  })
})

/**
 * An address carrying EVERY entry-level property RFC 9553 §2.5.1 defines, so the edit path can be
 * checked field by field rather than on the two the bug report happened to name. Nothing here is
 * reachable from the form except the five components and the type — which is the point: the module's
 * contract is that the rest rides through an edit untouched.
 */
function fullAddress(): Address {
  return {
    '@type': 'Address',
    components: [
      { '@type': 'AddressComponent', kind: 'name', value: 'Main Street 1' },
      { '@type': 'AddressComponent', kind: 'locality', value: 'Berlin' },
      { '@type': 'AddressComponent', kind: 'region', value: 'BE' },
      { '@type': 'AddressComponent', kind: 'postcode', value: '10115' },
      { '@type': 'AddressComponent', kind: 'country', value: 'Germany' },
    ],
    full: 'Main Street 1\n10115 Berlin\nGermany',
    countryCode: 'DE',
    coordinates: 'geo:52.5,13.4',
    timeZone: 'Europe/Berlin',
    contexts: { work: true },
    pref: 1,
    isOrdered: true,
  }
}

function cardWithAddress(address: Address): ContactCard {
  return {
    '@type': 'Card',
    version: '1.0',
    uid: 'urn:uuid:addr',
    id: 'server-addr',
    addressBookIds: { book1: true },
    kind: 'individual',
    addresses: { a1: address },
  }
}

function editAddress(
  card: ContactCard,
  partial: Partial<AddressEntry>,
): Record<string, Address> | undefined {
  const form = cardToForm(card)
  const entry = form.addresses[0]
  if (entry === undefined) throw new Error('the fixture card has no address to edit')
  const edited: ContactFormModel = { ...form, addresses: [{ ...entry, ...partial }] }
  return formToCard(edited, card, idSource()).addresses as Record<string, Address> | undefined
}

describe('contact-card-mapping addresses (N4 / N12)', () => {
  it('changing the street keeps every property the form does not surface', () => {
    const card = cardWithAddress(fullAddress())
    const address = editAddress(card, { street: 'Side Street 2' })?.a1
    if (address === undefined) throw new Error('the address was dropped')

    // Field by field, not just the two the report named — the failure was a whole-object replace,
    // so a spot check on `full` and `countryCode` would have passed on the next such regression.
    expect(address.countryCode).toBe('DE')
    expect(address.coordinates).toBe('geo:52.5,13.4')
    expect(address.timeZone).toBe('Europe/Berlin')
    expect(address.pref).toBe(1)
    expect(address.isOrdered).toBe(true)
    expect(address.contexts).toEqual({ work: true })
    expect(address['@type']).toBe('Address')
    expect(address.components).toContainEqual({
      '@type': 'AddressComponent',
      kind: 'name',
      value: 'Side Street 2',
    })
    // The one property that must NOT survive: `full` is the same address pre-formatted, and the
    // detail view prefers it — kept, it would show the street the user just replaced.
    expect(address.full).toBeUndefined()
  })

  it('changing only the type keeps the formatted `full` and every other property', () => {
    const card = cardWithAddress(fullAddress())
    const address = editAddress(card, { type: 'private' })?.a1
    expect(address?.contexts).toEqual({ private: true })
    expect(address?.full).toBe('Main Street 1\n10115 Berlin\nGermany')
    expect(address?.countryCode).toBe('DE')
    expect(address?.timeZone).toBe('Europe/Berlin')
  })

  it('emptying every field of an existing address removes it instead of sending an empty object', () => {
    const card = cardWithAddress({
      '@type': 'Address',
      components: [{ '@type': 'AddressComponent', kind: 'name', value: 'Main Street 1' }],
      contexts: { work: true },
    })
    const cleared = editAddress(card, {
      street: '',
      locality: '',
      region: '',
      postcode: '',
      country: '',
    })
    expect(cleared).toBeUndefined()
    // …and the patch says "remove", rather than replacing the entry with an empty object.
    const { addresses: _dropped, ...withoutAddresses } = card
    expect(diffCardPatch(card, withoutAddresses)).toEqual({ addresses: null })
  })

  it('keeps a `full`-only address when its (always empty) component fields are "cleared"', () => {
    // Its content never lived in those five fields, so emptying them says nothing about it — and
    // the form offers no other way to see or keep it.
    const card = cardWithAddress({ '@type': 'Address', full: 'PO Box 90210\nBeverly Hills' })
    const kept = editAddress(card, { type: 'private' })
    expect(kept?.a1?.full).toBe('PO Box 90210\nBeverly Hills')
    expect(kept?.a1?.contexts).toEqual({ private: true })
  })
})

describe('contact-card-mapping type vs. free-text label (N7)', () => {
  it('retires the stale label when the type changes, so the picker matches what is shown', () => {
    const card: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'urn:uuid:label',
      id: 'server-label',
      addressBookIds: { book1: true },
      kind: 'individual',
      emails: {
        e1: {
          '@type': 'EmailAddress',
          address: 'buero@example.com',
          contexts: { work: true },
          pref: 1,
          label: 'Büro',
        },
      },
    }
    const form = cardToForm(card)
    const edited: ContactFormModel = {
      ...form,
      emails: form.emails.map((entry) => ({ ...entry, type: 'private' })),
    }
    const email = formToCard(edited, card, idSource()).emails?.e1
    expect(email?.contexts).toEqual({ private: true })
    expect(email?.label).toBeUndefined()
    // Everything else about the entry is untouched.
    expect(email?.address).toBe('buero@example.com')
    expect(email?.pref).toBe(1)
  })

  it('keeps the label when the type is not touched', () => {
    const card: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'urn:uuid:label2',
      id: 'server-label2',
      addressBookIds: { book1: true },
      kind: 'individual',
      emails: {
        e1: {
          '@type': 'EmailAddress',
          address: 'a@b.test',
          contexts: { work: true },
          label: 'Büro',
        },
      },
    }
    const form = cardToForm(card)
    const edited: ContactFormModel = {
      ...form,
      emails: form.emails.map((entry) => ({ ...entry, address: 'c@d.test' })),
    }
    expect(formToCard(edited, card, idSource()).emails?.e1?.label).toBe('Büro')
  })
})

describe('contact-card-mapping trimming (N11)', () => {
  it('stores phone numbers and notes without their padding', () => {
    const newId = idSource()
    const seed: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'urn:uuid:trim',
      id: 'placeholder',
      addressBookIds: { book1: true },
      kind: 'individual',
    }
    const form: ContactFormModel = {
      ...emptyFormModel(),
      emails: [{ key: newId(), type: '', address: '  spaced@example.test  ' }],
      phones: [{ key: newId(), type: '', number: '  +49 123 456  ' }],
      notes: [{ key: newId(), text: '   Note with an edge   ' }],
    }
    const card = formToCard(form, seed, newId)
    expect(Object.values(card.phones ?? {})[0]?.number).toBe('+49 123 456')
    expect(Object.values(card.notes ?? {})[0]?.note).toBe('Note with an edge')
    expect(Object.values(card.emails ?? {})[0]?.address).toBe('spaced@example.test')
  })
})

describe('contact-card-mapping create', () => {
  it('builds a card body from an empty form plus a seed, minting a key for each filled row', () => {
    const seed: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'urn:uuid:new',
      id: 'placeholder',
      addressBookIds: { book1: true },
      kind: 'individual',
    }
    const newId = idSource()
    const form: ContactFormModel = {
      ...emptyFormModel(),
      name: { prefix: '', given: 'Bob', given2: '', surname: 'Brown', suffix: '' },
      emails: [{ key: newId(), type: 'work', address: 'bob@work.test' }],
    }
    const card = formToCard(form, seed, newId)
    expect(card.addressBookIds).toEqual({ book1: true })
    expect(card.name?.components).toEqual([
      { '@type': 'NameComponent', kind: 'given', value: 'Bob' },
      { '@type': 'NameComponent', kind: 'surname', value: 'Brown' },
    ])
    expect(card.emails).toEqual({
      'gen-0': { '@type': 'EmailAddress', address: 'bob@work.test', contexts: { work: true } },
    })
    // Nothing the form did not fill is present.
    expect(card.phones).toBeUndefined()
    expect(card.notes).toBeUndefined()
  })
})

/**
 * Websites and instant messaging (A-5 of the JMAP gap analysis).
 *
 * `links` was fetched and preserved but had no form field, and `onlineServices` was not modelled at
 * any level — it survived only as an opaque `vCardProps` entry, which a client can carry but never
 * show or edit.
 */
describe('links and onlineServices', () => {
  const card = (): ContactCard => ({
    '@type': 'Card',
    version: '1.0',
    uid: 'u1',
    id: 's1',
    addressBookIds: { book1: true },
    links: {
      l1: { '@type': 'Link', uri: 'https://anna.test', kind: 'contact', pref: 1 },
    },
    onlineServices: {
      s1: {
        '@type': 'OnlineService',
        service: 'Matrix',
        uri: 'matrix:u/anna:example.test',
        contexts: { work: true },
      },
      s2: { '@type': 'OnlineService', service: 'Signal', user: 'anna.42' },
    },
  })

  it('reads both into the form, taking whichever of uri/user the account is stored as', () => {
    const form = cardToForm(card())
    expect(form.links).toEqual([
      { key: 'l1', uri: 'https://anna.test', original: card().links?.l1 },
    ])
    expect(form.onlineServices.map((entry) => [entry.service, entry.account])).toEqual([
      ['Matrix', 'matrix:u/anna:example.test'],
      ['Signal', 'anna.42'],
    ])
  })

  it('round-trips unchanged — an untouched card produces an EMPTY patch', () => {
    const original = card()
    const next = formToCard(cardToForm(original), original, idSource())
    expect(next.links).toEqual(original.links)
    expect(next.onlineServices).toEqual(original.onlineServices)
    expect(diffCardPatch(original, next)).toEqual({})
  })

  it('preserves the entry properties the form does not surface', () => {
    // `kind`/`pref` on the link and `contexts` on the service are not on screen; an edit of the
    // address itself must not be the moment they disappear.
    const original = card()
    const form = cardToForm(original)
    const edited: ContactFormModel = {
      ...form,
      links: [{ ...(form.links[0] as (typeof form.links)[number]), uri: 'https://anna.test/neu' }],
    }
    const next = formToCard(edited, original, idSource())
    expect(next.links?.l1).toEqual({
      '@type': 'Link',
      uri: 'https://anna.test/neu',
      kind: 'contact',
      pref: 1,
    })
    expect(Object.keys(diffCardPatch(original, next))).toEqual(['links'])
  })

  it('writes a URI-shaped account as `uri` and anything else as `user`', () => {
    /*
     * The split is not cosmetic: a Matrix handle put in `uri` becomes a link the browser cannot
     * follow, and a `matrix:` URI put in `user` stops being one anything can dial.
     */
    const blank = emptyFormModel()
    const seed: ContactCard = {
      '@type': 'Card',
      version: '1.0',
      uid: 'u',
      id: 'i',
      addressBookIds: { b: true },
    }
    const next = formToCard(
      {
        ...blank,
        onlineServices: [
          { key: 'k1', service: 'Matrix', account: 'matrix:u/anna:example.test' },
          { key: 'k2', service: 'Matrix', account: '@anna:example.test' },
        ],
      },
      seed,
      idSource(),
    )
    expect(next.onlineServices?.k1).toEqual({
      '@type': 'OnlineService',
      service: 'Matrix',
      uri: 'matrix:u/anna:example.test',
    })
    expect(next.onlineServices?.k2).toEqual({
      '@type': 'OnlineService',
      service: 'Matrix',
      user: '@anna:example.test',
    })
  })

  it('switching an account from a handle to a URI leaves no stale twin behind', () => {
    const original = card()
    const form = cardToForm(original)
    const signal = form.onlineServices[1] as (typeof form.onlineServices)[number]
    const next = formToCard(
      { ...form, onlineServices: [signal ? { ...signal, account: 'sgnl://anna.42' } : signal] },
      original,
      idSource(),
    )
    // `user` is gone, not left beside the new `uri`.
    expect(next.onlineServices?.s2).toEqual({
      '@type': 'OnlineService',
      service: 'Signal',
      uri: 'sgnl://anna.42',
    })
  })

  it('drops a row with no account, and removes the whole property when the last one goes', () => {
    const original = card()
    const form = cardToForm(original)
    const next = formToCard(
      { ...form, links: [], onlineServices: [{ key: 'k', service: 'Matrix', account: '   ' }] },
      original,
      idSource(),
    )
    expect(next.links).toBeUndefined()
    expect(next.onlineServices).toBeUndefined()
    expect(diffCardPatch(original, next)).toEqual({ links: null, onlineServices: null })
  })
})

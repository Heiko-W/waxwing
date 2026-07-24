import type { ContactCard } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
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

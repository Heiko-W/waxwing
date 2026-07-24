import { describe, expect, it } from 'vitest'
import {
  CONTACTS_PATH,
  contactsPath,
  deriveBase,
  mailPath,
  matchRoute,
  settingsPath,
  toHref,
  toPath,
} from './route'

const loc = (pathname: string, search = ''): { pathname: string; search: string } => ({
  pathname,
  search,
})

describe('deriveBase', () => {
  it('returns an empty string for a root base', () => {
    expect(deriveBase('https://host/')).toBe('')
  })

  it('strips the trailing slash from a mount prefix', () => {
    expect(deriveBase('https://host/deploy/mail/')).toBe('/deploy/mail')
  })

  it('accepts a base href without a trailing slash', () => {
    expect(deriveBase('https://host/mail')).toBe('/mail')
  })

  it('falls through for a non-URL string', () => {
    expect(deriveBase('/mail/')).toBe('/mail')
  })
})

describe('toHref / toPath', () => {
  it('round-trips under an empty base', () => {
    expect(toHref('', '/contacts')).toBe('/contacts')
    expect(toPath('', '/contacts')).toBe('/contacts')
  })

  it('prefixes and strips a mount base', () => {
    expect(toHref('/mail', '/contacts')).toBe('/mail/contacts')
    expect(toPath('/mail', '/mail/contacts')).toBe('/contacts')
    expect(toPath('/mail', '/mail')).toBe('/')
  })

  it('returns a foreign pathname unchanged', () => {
    expect(toPath('/mail', '/other')).toBe('/other')
  })
})

describe('matchRoute (empty base)', () => {
  it('maps the root to the mail area', () => {
    const match = matchRoute('', loc('/'))
    expect(match.id).toBe('mail')
    expect(match.params.mailboxId).toBeUndefined()
    expect(match.params.emailId).toBeUndefined()
  })

  it('maps /mail', () => {
    expect(matchRoute('', loc('/mail')).id).toBe('mail')
  })

  it('extracts the mailbox and email params', () => {
    const one = matchRoute('', loc('/mail/inbox'))
    expect(one.params.mailboxId).toBe('inbox')
    expect(one.params.emailId).toBeUndefined()

    const two = matchRoute('', loc('/mail/inbox/42'))
    expect(two.params.mailboxId).toBe('inbox')
    expect(two.params.emailId).toBe('42')
  })

  it('maps contacts and settings (with a splat rest)', () => {
    expect(matchRoute('', loc('/contacts')).id).toBe('contacts')

    const bare = matchRoute('', loc('/contacts'))
    expect(bare.params.bookId).toBeUndefined()
    expect(bare.params.cardId).toBeUndefined()

    const book = matchRoute('', loc('/contacts/book1'))
    expect(book.id).toBe('contacts')
    expect(book.params.bookId).toBe('book1')
    expect(book.params.cardId).toBeUndefined()

    const card = matchRoute('', loc('/contacts/book1/c42'))
    expect(card.id).toBe('contacts')
    expect(card.params.bookId).toBe('book1')
    expect(card.params.cardId).toBe('c42')

    const settings = matchRoute('', loc('/settings'))
    expect(settings.id).toBe('settings')
    expect(settings.rest).toBe('')

    const sub = matchRoute('', loc('/settings/identities'))
    expect(sub.id).toBe('settings')
    expect(sub.rest).toBe('identities')
  })

  it('maps unknown paths to notFound', () => {
    expect(matchRoute('', loc('/bogus')).id).toBe('notFound')
  })

  it('passes search through without affecting matching', () => {
    const match = matchRoute('', loc('/mail', '?code=x&state=y'))
    expect(match.id).toBe('mail')
    expect(match.search.get('code')).toBe('x')
    expect(match.search.get('state')).toBe('y')
  })
})

describe('matchRoute (mount prefix)', () => {
  it('resolves a prefixed pathname', () => {
    const match = matchRoute('/deploy/mail', loc('/deploy/mail/contacts'))
    expect(match.id).toBe('contacts')
  })
})

describe('path builders', () => {
  it('builds mail paths', () => {
    expect(mailPath()).toBe('/mail')
    expect(mailPath('inbox')).toBe('/mail/inbox')
    expect(mailPath('inbox', '42')).toBe('/mail/inbox/42')
  })

  it('builds settings paths', () => {
    expect(settingsPath()).toBe('/settings')
    expect(settingsPath('identities')).toBe('/settings/identities')
  })

  it('exposes the contacts path', () => {
    expect(CONTACTS_PATH).toBe('/contacts')
  })

  it('builds contacts paths', () => {
    expect(contactsPath()).toBe('/contacts')
    expect(contactsPath('book1')).toBe('/contacts/book1')
    expect(contactsPath('book1', 'c42')).toBe('/contacts/book1/c42')
    // A card without a book has no addressable list to hang off, so the book segment wins.
    expect(contactsPath(undefined, 'c42')).toBe('/contacts')
  })
})

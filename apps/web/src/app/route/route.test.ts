import { describe, expect, it } from 'vitest'
import { notificationTargetPath } from '../../notify/click-route'
import { carryAccount } from './RouterProvider'
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

describe('mailPath — account qualification (B37)', () => {
  it('omits the account entirely when none is named', () => {
    // Every existing link keeps its exact shape and its meaning ("my own account"), so the
    // single-account path is byte-for-byte unchanged.
    expect(mailPath('inbox')).toBe('/mail/inbox')
    expect(mailPath('inbox', 'e1')).toBe('/mail/inbox/e1')
    expect(mailPath()).toBe('/mail')
  })

  it('qualifies the route when a delegated account is named', () => {
    // Without this, `/mail/a/e1` reloaded resolves against the user's OWN account — where `a` is
    // very likely a real but different mailbox, so the pane shows the wrong mail and looks right.
    expect(mailPath('a', undefined, 'acctS')).toBe('/mail/a?account=acctS')
    expect(mailPath('a', 'e1', 'acctS')).toBe('/mail/a/e1?account=acctS')
  })

  it('encodes an account id that needs it', () => {
    expect(mailPath('a', undefined, 'x/y z')).toBe('/mail/a?account=x%2Fy%20z')
  })
})

describe('carryAccount — the parameter survives a navigation (B37)', () => {
  it('carries the current account onto a mail route that does not name one', () => {
    // Losing it on the first click would undo the whole fix: most call sites build their own query
    // string, so this is done once in the router rather than remembered N times.
    expect(carryAccount('/mail/a/e1', '?account=acctS')).toBe('/mail/a/e1?account=acctS')
  })

  it('merges with a query the caller already built', () => {
    const carried = new URLSearchParams(
      carryAccount('/mail/a?q=hi', '?account=acctS').split('?')[1],
    )
    expect(carried.get('q')).toBe('hi')
    expect(carried.get('account')).toBe('acctS')
  })

  it('lets an EXPLICIT account win over the current one', () => {
    expect(carryAccount('/mail/a?account=other', '?account=acctS')).toBe('/mail/a?account=other')
  })

  it('does not leak the account out of the mail area', () => {
    // Settings and contacts are the user's own by definition.
    expect(carryAccount('/settings', '?account=acctS')).toBe('/settings')
    expect(carryAccount('/contacts', '?account=acctS')).toBe('/contacts')
  })

  it('is a no-op when no account is in play', () => {
    expect(carryAccount('/mail/a/e1', '')).toBe('/mail/a/e1')
  })

  /**
   * The seam this function is most dangerous at. A notification click arrives through the same
   * `navigate()` as any in-app link, but it comes from OUTSIDE the current route's frame of
   * reference: the banner names the account the mail arrived in, which need not be the one the user
   * is reading. Unqualified, the primary account's message id `e1` would be looked up in the shared
   * account `acctS`, where an id that short very likely exists as well — wrong mail, right-looking
   * URL. `notificationTargetPath` therefore qualifies unconditionally, and this pins the two halves
   * together, in both directions.
   */
  it('cannot hijack a notification target — it names its own account (F3)', () => {
    const readingShared = '?account=acctS'
    const primaryBanner = { kind: 'mail', accountId: 'p1', mailboxId: 'a', emailId: 'e1' } as const
    expect(carryAccount(notificationTargetPath(primaryBanner), readingShared)).toBe(
      '/mail/a/e1?account=p1',
    )
    const sharedBanner = { ...primaryBanner, accountId: 'acctS' }
    expect(carryAccount(notificationTargetPath(sharedBanner), '')).toBe('/mail/a/e1?account=acctS')
  })
})

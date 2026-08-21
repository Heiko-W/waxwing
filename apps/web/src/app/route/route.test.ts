import { describe, expect, it } from 'vitest'
import { notificationTargetPath } from '../../notify/click-route'
import { carryAccount } from './RouterProvider'
import {
  atMailRoot,
  CONTACTS_ALL_BOOKS,
  CONTACTS_PATH,
  contactsPath,
  deriveBase,
  isReadingHistoryEntry,
  mailFullPath,
  mailHrefKeepingQuery,
  mailPath,
  matchRoute,
  READING_HISTORY_MARK,
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

  /**
   * The rule the on-screen Back button broke while the `u` chord kept it: `?q=` and `?label=` are
   * what the list is SHOWING, and dropping them snaps it back to the plain folder, changing the
   * window key and resetting focus and selection mid-triage. Two implementations of one idea is how
   * they came to disagree; there is one now, and this is it.
   */
  it('keeps the query string when returning to the list', () => {
    const search = new URLSearchParams('q=report&account=b')
    expect(mailHrefKeepingQuery(search, 'inbox')).toBe('/mail/inbox?q=report&account=b')
    expect(mailHrefKeepingQuery(search, 'inbox', '42')).toBe('/mail/inbox/42?q=report&account=b')
  })

  it('adds no stray separator when there is no query', () => {
    expect(mailHrefKeepingQuery(new URLSearchParams(), 'inbox')).toBe('/mail/inbox')
    expect(mailHrefKeepingQuery(new URLSearchParams())).toBe('/mail')
  })

  /**
   * The marker that lets Back tell "I pushed this" from "the user arrived here directly" — the
   * difference between popping the entry and pushing a third one on top of it.
   */
  it('recognises only its own reading history entry', () => {
    expect(isReadingHistoryEntry({ waxwing: READING_HISTORY_MARK })).toBe(true)
    expect(isReadingHistoryEntry(null)).toBe(false)
    expect(isReadingHistoryEntry({ waxwing: 'something-else' })).toBe(false)
    expect(isReadingHistoryEntry('waxwing:reading')).toBe(false)
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
  })

  it('addresses a card in the all-books scope rather than dropping it', () => {
    // The regression this pins: `contactsPath(undefined, 'c42')` used to return `/contacts`, so
    // every row in "All Contacts" navigated to the page it was already on and nothing opened.
    expect(contactsPath(undefined, 'c42')).toBe(`/contacts/${CONTACTS_ALL_BOOKS}/c42`)
  })

  it('reads the all-books segment back as "no book"', () => {
    // Round trip: what `contactsPath` writes, `matchRoute` must resolve to the same pair the caller
    // had — otherwise the rail would highlight a book named `~all` and the list would be empty.
    const match = matchRoute('', loc(contactsPath(undefined, 'c42')))
    expect(match.id).toBe('contacts')
    expect(match.params.bookId).toBeUndefined()
    expect(match.params.cardId).toBe('c42')
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

describe('atMailRoot — the guard on the "/mail resolves to the Inbox" redirect', () => {
  /*
   * The redirect fires when the replica finishes syncing, not when the screen opens, so by then the
   * reader may already be somewhere else — and `MailScreen` asks THIS about `window.location`
   * rather than about its own render, which is a sync behind. See the effect's note.
   */
  it('says yes for the bare mail root, with or without a trailing slash', () => {
    expect(atMailRoot('/mail')).toBe(true)
    expect(atMailRoot('/mail/')).toBe(true)
  })

  it('says yes under a mount prefix, which is where the app actually ships (FR-DEP-02)', () => {
    // Stalwart serves the app under a path prefix and rewrites `<base href>`; an equality check
    // against '/mail' would disable the Inbox default on every hosted deployment.
    expect(atMailRoot('/webmail/mail')).toBe(true)
  })

  it('says no once a folder is named, and no for every other screen', () => {
    expect(atMailRoot('/mail/inbox')).toBe(false)
    expect(atMailRoot('/mail/inbox/e1')).toBe(false)
    // The whole point: these are the destinations the redirect used to overwrite.
    expect(atMailRoot('/files')).toBe(false)
    expect(atMailRoot('/settings')).toBe(false)
    expect(atMailRoot('/contacts')).toBe(false)
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

describe('the full-screen flag', () => {
  it('hangs off the mail route, and keeps the account with it', () => {
    expect(mailFullPath('inbox', 'e1')).toBe('/mail/inbox/e1?full=1')
    // The account must survive: `carryAccount` only forwards `?account=` to `/mail` paths, so a
    // route of its own would drop a delegated account and open the wrong mailbox's message.
    expect(mailFullPath('inbox', 'e1', 'acctB')).toBe('/mail/inbox/e1?account=acctB&full=1')
  })

  it('does not follow the reader back to the list', () => {
    // `q`, `label` and `account` describe the LIST and are carried; `full` describes the message
    // view. Carried back it would produce a full-screen list — a state with no exit and no name.
    const search = new URLSearchParams('q=hi&account=acctB&full=1')
    expect(mailHrefKeepingQuery(search, 'inbox')).toBe('/mail/inbox?q=hi&account=acctB')
    // …and the caller's own params are not mutated on the way.
    expect(search.get('full')).toBe('1')
  })
})

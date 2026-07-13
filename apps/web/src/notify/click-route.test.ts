import { describe, expect, it } from 'vitest'
import {
  isAppClient,
  isMailNotificationData,
  isNotifyClickMessage,
  NOTIFY_CLICK,
  notificationTargetHref,
  notificationTargetPath,
  routeBase,
} from './click-route'

const ROOT_WORKER = 'https://mail.example.com/sw.js'
const MOUNT_WORKER = 'https://mail.example.com/mail/sw.js'

const mailData = {
  kind: 'mail' as const,
  accountId: 'acc-1',
  mailboxId: 'inbox',
  emailId: '42',
}

describe('routeBase', () => {
  it('maps the deployment root onto the router base', () => {
    expect(routeBase('/')).toBe('')
    expect(routeBase('/mail/')).toBe('/mail')
    expect(routeBase('/webmail/')).toBe('/webmail')
  })
})

describe('notificationTargetPath', () => {
  it('opens the message', () => {
    expect(notificationTargetPath(mailData)).toBe('/mail/inbox/42')
  })

  it('opens the folder when there is no message (a summary)', () => {
    expect(notificationTargetPath({ ...mailData, kind: 'summary', emailId: null })).toBe(
      '/mail/inbox',
    )
  })

  it('falls back to the mail home when there is not even a folder', () => {
    expect(notificationTargetPath({ ...mailData, mailboxId: null, emailId: null })).toBe('/mail')
  })

  it('NEVER throws on malformed data — the shade outlives our schema', () => {
    // `data` comes back through structured clone from a notification that may have survived a browser
    // restart and a deploy. A shape we no longer recognise must still open the app, not kill the
    // click handler and leave the user tapping a dead banner.
    for (const bad of [
      undefined,
      null,
      'nope',
      42,
      {},
      { kind: 'mail' },
      { kind: 'other', accountId: 'a', mailboxId: null, emailId: null },
    ]) {
      expect(notificationTargetPath(bad), JSON.stringify(bad)).toBe('/mail')
    }
  })
})

describe('notificationTargetHref', () => {
  it('at the origin root', () => {
    expect(notificationTargetHref('/', mailData)).toBe('/mail/inbox/42')
  })

  it('under a /mail/ mount the prefix and the app’s own mail area BOTH appear — and must', () => {
    // They are different coordinate spaces: `/mail/` is where Stalwart serves the app, `/mail` is the
    // app's mail route. A "tidy-up" that collapses them 404s.
    expect(notificationTargetHref('/mail/', mailData)).toBe('/mail/mail/inbox/42')
    expect(notificationTargetHref('/mail/', { ...mailData, mailboxId: null, emailId: null })).toBe(
      '/mail/mail',
    )
  })

  it('under an arbitrary subdirectory mount', () => {
    expect(notificationTargetHref('/webmail/', mailData)).toBe('/webmail/mail/inbox/42')
  })
})

describe('isAppClient', () => {
  it('accepts our own pages at the root', () => {
    expect(isAppClient('https://mail.example.com/', ROOT_WORKER)).toBe(true)
    expect(isAppClient('https://mail.example.com/mail/inbox/42', ROOT_WORKER)).toBe(true)
  })

  it('accepts our own pages under a mount', () => {
    expect(isAppClient('https://mail.example.com/mail/', MOUNT_WORKER)).toBe(true)
    expect(isAppClient('https://mail.example.com/mail', MOUNT_WORKER)).toBe(true)
    expect(isAppClient('https://mail.example.com/mail/mail/inbox/42', MOUNT_WORKER)).toBe(true)
  })

  it('rejects a page of some OTHER app on the same origin', () => {
    // Stalwart serves its admin portal from the same origin. Focusing it and posting it a mail route
    // would be, at best, baffling.
    expect(isAppClient('https://mail.example.com/admin/', MOUNT_WORKER)).toBe(false)
    expect(isAppClient('https://mail.example.com/', MOUNT_WORKER)).toBe(false)
  })

  it('…and rejects them AT THE ROOT DEPLOYMENT too, where "under the root" filters nothing', () => {
    // The recommended deployment is same-origin with the JMAP server, and there the root is `/`: an
    // "is it under the root?" test is `startsWith('/')`, which every page on the host satisfies. So the
    // path must also resolve to a route this app actually serves. Without that, a click on a banner
    // would focus Stalwart's own sign-in page — whichever same-origin tab happened to be first — post
    // it a route it does not understand, and return, having opened nothing.
    expect(isAppClient('https://mail.example.com/login', ROOT_WORKER)).toBe(false)
    expect(isAppClient('https://mail.example.com/admin/users', ROOT_WORKER)).toBe(false)
    expect(isAppClient('https://mail.example.com/jmap', ROOT_WORKER)).toBe(false)
    // …while our own routes still pass, at the root and under a mount alike.
    expect(isAppClient('https://mail.example.com/settings', ROOT_WORKER)).toBe(true)
    expect(isAppClient('https://mail.example.com/contacts', ROOT_WORKER)).toBe(true)
    expect(isAppClient('https://mail.example.com/mail/admin', MOUNT_WORKER)).toBe(false)
  })

  it('rejects a foreign origin and an unparseable url', () => {
    expect(isAppClient('https://evil.example.net/mail/', MOUNT_WORKER)).toBe(false)
    expect(isAppClient('not a url', ROOT_WORKER)).toBe(false)
  })
})

describe('the message guards', () => {
  it('accept what the worker actually posts', () => {
    expect(isNotifyClickMessage({ type: NOTIFY_CLICK, path: '/mail/inbox/42' })).toBe(true)
    expect(isMailNotificationData(mailData)).toBe(true)
    expect(isMailNotificationData({ ...mailData, kind: 'summary', emailId: null })).toBe(true)
  })

  it('reject anything else — the page listens on a channel any script can post to', () => {
    for (const bad of [
      undefined,
      null,
      'nope',
      {},
      { type: NOTIFY_CLICK },
      { type: 'OTHER', path: '/x' },
      { type: NOTIFY_CLICK, path: 42 },
    ]) {
      expect(isNotifyClickMessage(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const bad of [
      { kind: 'mail' },
      { ...mailData, accountId: 42 },
      { ...mailData, mailboxId: 7 },
    ]) {
      expect(isMailNotificationData(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

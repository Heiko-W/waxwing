import { describe, expect, it } from 'vitest'
import type { EmailEnvelopeInput } from '../sync/db'
import {
  buildMailNotification,
  buildSummaryNotification,
  coerceNotificationPrefs,
  DEFAULT_NOTIFICATION_PREFS,
  inQuietHours,
  localMinutesOfDay,
  minutesToTimeValue,
  type NotificationPrefs,
  type NotificationRenderContext,
  notifyMailboxId,
  selectNotifiable,
  shouldNotify,
  timeValueToMinutes,
} from './notify-model'

const INBOX = 'mb-inbox'
const ARCHIVE = 'mb-archive'
const SINCE = Date.parse('2026-07-13T09:00:00Z')

function email(overrides: Partial<EmailEnvelopeInput> = {}): EmailEnvelopeInput {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { [INBOX]: true },
    keywords: {},
    size: 1234,
    receivedAt: '2026-07-13T10:00:00Z', // after SINCE
    sentAt: null,
    from: [{ name: 'Alice Smith', email: 'alice@example.de' }],
    to: null,
    cc: null,
    replyTo: null,
    subject: 'Quarterly report',
    messageId: null,
    inReplyTo: null,
    references: null,
    preview: 'The numbers you asked for are attached and they are not good.',
    hasAttachment: false,
    ...overrides,
  }
}

const PREFS: NotificationPrefs = {
  enabled: true,
  mailboxIds: [INBOX],
  quietHours: null,
  preview: true,
  sound: true,
}

const BASE = { prefs: PREFS, permission: 'granted' as const, minutesOfDay: 12 * 60, sinceMs: SINCE }

// -------------------------------------------------------------------------------------------------

describe('inQuietHours', () => {
  it('a same-day window is `from` inclusive and `to` exclusive', () => {
    const range = { fromMinutes: 9 * 60, toMinutes: 17 * 60 }
    expect(inQuietHours(9 * 60 - 1, range)).toBe(false)
    expect(inQuietHours(9 * 60, range)).toBe(true) // from: inclusive
    expect(inQuietHours(16 * 60 + 59, range)).toBe(true)
    expect(inQuietHours(17 * 60, range)).toBe(false) // to: exclusive
  })

  it('a window that CROSSES MIDNIGHT is quiet on both sides of it', () => {
    const night = { fromMinutes: 22 * 60, toMinutes: 7 * 60 }
    expect(inQuietHours(23 * 60, night)).toBe(true) // 23:00 — before midnight
    expect(inQuietHours(3 * 60, night)).toBe(true) // 03:00 — after midnight
    expect(inQuietHours(6 * 60 + 59, night)).toBe(true)
    expect(inQuietHours(7 * 60, night)).toBe(false) // the window ends
    expect(inQuietHours(12 * 60, night)).toBe(false) // noon is loud
  })

  it('from === to is an EMPTY window — never quiet, not always quiet', () => {
    // "always quiet" is what the master switch is for; a zero-length range means the user has not
    // actually chosen a window, and silently muting them forever would be the worst possible reading.
    const empty = { fromMinutes: 9 * 60, toMinutes: 9 * 60 }
    expect(inQuietHours(9 * 60, empty)).toBe(false)
    expect(inQuietHours(0, empty)).toBe(false)
    expect(inQuietHours(23 * 60 + 59, empty)).toBe(false)
  })
})

describe('localMinutesOfDay / time-value round trip', () => {
  it('reads local wall-clock minutes', () => {
    const noon = new Date(2026, 6, 13, 12, 34)
    expect(localMinutesOfDay(noon.getTime())).toBe(12 * 60 + 34)
  })

  it('round-trips a <input type="time"> value', () => {
    for (const minutes of [0, 7 * 60, 22 * 60, 23 * 60 + 59]) {
      expect(timeValueToMinutes(minutesToTimeValue(minutes))).toBe(minutes)
    }
    expect(minutesToTimeValue(22 * 60)).toBe('22:00')
    expect(minutesToTimeValue(7 * 60 + 5)).toBe('07:05')
  })

  it('rejects anything the time input cannot have produced (it can be CLEARED)', () => {
    for (const bad of ['', 'nonsense', '24:00', '12:60', '7:00']) {
      expect(timeValueToMinutes(bad), bad).toBeNull()
    }
  })
})

describe('shouldNotify', () => {
  it('notifies for new, unread mail in an enabled folder', () => {
    expect(shouldNotify({ ...BASE, email: email() })).toBe(true)
  })

  it('never without permission', () => {
    expect(shouldNotify({ ...BASE, permission: 'default', email: email() })).toBe(false)
    expect(shouldNotify({ ...BASE, permission: 'denied', email: email() })).toBe(false)
    expect(shouldNotify({ ...BASE, permission: 'unsupported', email: email() })).toBe(false)
  })

  it('never when the master switch is off', () => {
    expect(shouldNotify({ ...BASE, prefs: { ...PREFS, enabled: false }, email: email() })).toBe(
      false,
    )
  })

  it('never inside the quiet window — including one that crosses midnight', () => {
    const prefs = { ...PREFS, quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 } }
    expect(shouldNotify({ ...BASE, prefs, minutesOfDay: 3 * 60, email: email() })).toBe(false)
    expect(shouldNotify({ ...BASE, prefs, minutesOfDay: 12 * 60, email: email() })).toBe(true)
  })

  it('never for our OWN draft save', () => {
    // Email/changes.created fires for drafts and sends too — they create Emails in Drafts/Sent.
    const draft = email({ keywords: { $draft: true }, mailboxIds: { [INBOX]: true } })
    expect(shouldNotify({ ...BASE, email: draft })).toBe(false)
  })

  it('never for mail already read on another device', () => {
    expect(shouldNotify({ ...BASE, email: email({ keywords: { $seen: true } }) })).toBe(false)
  })

  it('never for mail that is not strictly newer than the floor', () => {
    expect(shouldNotify({ ...BASE, email: email({ receivedAt: '2026-07-13T08:00:00Z' }) })).toBe(
      false,
    )
    // exactly at the floor: not STRICTLY newer
    expect(shouldNotify({ ...BASE, email: email({ receivedAt: '2026-07-13T09:00:00Z' }) })).toBe(
      false,
    )
  })

  it('never for an UNPARSEABLE receivedAt — an email we cannot date is not provably new', () => {
    expect(shouldNotify({ ...BASE, email: email({ receivedAt: 'not a date' }) })).toBe(false)
    expect(shouldNotify({ ...BASE, email: email({ receivedAt: '' }) })).toBe(false)
  })

  it('never for a folder the user did not enable', () => {
    const archived = email({ mailboxIds: { [ARCHIVE]: true } })
    expect(shouldNotify({ ...BASE, email: archived })).toBe(false)
    // …and an empty folder list means nothing notifies, unambiguously.
    expect(shouldNotify({ ...BASE, prefs: { ...PREFS, mailboxIds: [] }, email: email() })).toBe(
      false,
    )
  })

  it('survives an envelope with no `keywords` / `mailboxIds` at all', () => {
    // What arrives here is the RAW `Email/get` result — the created ids are filtered out of the port's
    // list, not out of a coerced row — and `db.ts`'s `toEmailRow` already declines to trust the server
    // on exactly these two fields. A TypeError thrown in here is caught by the engine, which would
    // silently lose the WHOLE pass's notifications, the well-formed ones included.
    const malformed = {
      ...email(),
      keywords: undefined,
      mailboxIds: undefined,
    } as unknown as EmailEnvelopeInput

    expect(() => shouldNotify({ ...BASE, email: malformed })).not.toThrow()
    expect(shouldNotify({ ...BASE, email: malformed })).toBe(false)
    expect(notifyMailboxId(malformed, PREFS)).toBeNull()
    // …and one bad envelope does not take the good ones down with it.
    expect(selectNotifiable([malformed, email()], BASE).map((e) => e.id)).toEqual(['e1'])
  })
})

describe('selectNotifiable', () => {
  it('keeps only the notifiable ones, oldest first', () => {
    const list = [
      email({ id: 'new-2', receivedAt: '2026-07-13T12:00:00Z' }),
      email({ id: 'seen', keywords: { $seen: true } }),
      email({ id: 'new-1', receivedAt: '2026-07-13T11:00:00Z' }),
      email({ id: 'elsewhere', mailboxIds: { [ARCHIVE]: true } }),
      email({ id: 'old', receivedAt: '2026-07-13T08:00:00Z' }),
    ]
    expect(selectNotifiable(list, BASE).map((e) => e.id)).toEqual(['new-1', 'new-2'])
  })

  it('is empty when nothing qualifies', () => {
    expect(selectNotifiable([email({ keywords: { $seen: true } })], BASE)).toEqual([])
    expect(selectNotifiable([], BASE)).toEqual([])
  })
})

describe('notifyMailboxId', () => {
  it('is the first ENABLED folder the email is actually in', () => {
    const prefs = { ...PREFS, mailboxIds: [ARCHIVE, INBOX] }
    expect(notifyMailboxId(email({ mailboxIds: { [INBOX]: true } }), prefs)).toBe(INBOX)
    expect(notifyMailboxId(email({ mailboxIds: { 'mb-other': true } }), prefs)).toBeNull()
  })
})

// -------------------------------------------------------------------------------------------------

const RENDER: NotificationRenderContext = {
  accountId: 'acc-1',
  productName: 'Postfach', // never "Waxwing": a hoster rebrands it (FR-THEME-02)
  preview: true,
  sound: true,
  iconUrl: 'https://host/branding/icon-192.png',
  badgeUrl: 'https://host/branding/icon-192.png',
  t: (key, vars) => (vars?.count === undefined ? key : `${key}:${String(vars.count)}`),
}

describe('buildMailNotification', () => {
  it('with preview ON: sender in the title, subject in the body', () => {
    const content = buildMailNotification(email(), INBOX, RENDER)
    expect(content.title).toBe('Alice Smith')
    expect(content.options.body).toBe('Quarterly report')
  })

  it('falls back to the address, then to "unknown sender"', () => {
    const noName = email({ from: [{ name: null, email: 'bob@example.de' }] })
    expect(buildMailNotification(noName, INBOX, RENDER).title).toBe('bob@example.de')
    expect(buildMailNotification(email({ from: null }), INBOX, RENDER).title).toBe(
      'notify.message.unknownSender',
    )
    expect(buildMailNotification(email({ subject: null }), INBOX, RENDER).options.body).toBe(
      'notify.message.noSubject',
    )
  })

  it('with preview OFF: NOTHING from the message appears anywhere — the privacy regression test', () => {
    // A notification lands on a lock screen and on a shared display. If this ever regresses, the
    // "show sender and subject" toggle is a lie, and it is a lie about the one thing it promises.
    //
    // Asserted over the WHOLE object, not just title+body: `NotificationOptions` has plenty of other
    // renderable fields (`image`, `actions`, and `data` survives into the OS shade), and an earlier
    // version of this test inspected two of them while its comment claimed to cover all.
    const content = buildMailNotification(email(), INBOX, { ...RENDER, preview: false })
    const everything = JSON.stringify(content)
    expect(everything).not.toContain('Alice Smith')
    expect(everything).not.toContain('alice@example.de')
    expect(everything).not.toContain('Quarterly report')
    // …and not the body snippet either, which we never show even WITH preview on.
    expect(everything).not.toContain('not good')
    expect(content.title).toBe('Postfach')
    expect(content.options.body).toBe('notify.body.generic')
  })

  it('…and the snippet never appears even with preview ON — only the subject does', () => {
    const content = buildMailNotification(email(), INBOX, RENDER)
    expect(JSON.stringify(content)).not.toContain('not good')
    expect(content.options.body).toBe('Quarterly report')
  })

  it('never leaks content into `data` — it lives on in the OS shade', () => {
    const content = buildMailNotification(email(), INBOX, RENDER)
    expect(content.options.data).toEqual({
      kind: 'mail',
      accountId: 'acc-1',
      mailboxId: INBOX,
      emailId: 'e1',
    })
  })

  it('is silent exactly when the sound preference is off, and tags per message', () => {
    expect(buildMailNotification(email(), INBOX, RENDER).options.silent).toBe(false)
    expect(buildMailNotification(email(), INBOX, { ...RENDER, sound: false }).options.silent).toBe(
      true,
    )
    expect(buildMailNotification(email(), INBOX, RENDER).options.tag).toBe('waxwing:acc-1:mail:e1')
    // Per-message tags are why N arrivals raise N banners instead of replacing one another.
    expect(buildMailNotification(email({ id: 'e2' }), INBOX, RENDER).options.tag).toBe(
      'waxwing:acc-1:mail:e2',
    )
  })

  it('never sets renotify on a per-message banner (Chrome TypeErrors on renotify without a tag)', () => {
    expect(buildMailNotification(email(), INBOX, RENDER).options.renotify).toBeUndefined()
  })

  it('carries the arrival time, and omits it when the date is unparseable', () => {
    expect(buildMailNotification(email(), INBOX, RENDER).options.timestamp).toBe(
      Date.parse('2026-07-13T10:00:00Z'),
    )
    expect(
      buildMailNotification(email({ receivedAt: 'garbage' }), INBOX, RENDER).options.timestamp,
    ).toBeUndefined()
  })
})

describe('buildSummaryNotification', () => {
  it('counts, targets the folder, and names no message', () => {
    const content = buildSummaryNotification(12, INBOX, RENDER)
    expect(content.title).toBe('Postfach')
    expect(content.options.body).toBe('notify.body.count:12')
    expect(content.options.tag).toBe('waxwing:acc-1:summary')
    expect(content.options.data).toEqual({
      kind: 'summary',
      accountId: 'acc-1',
      mailboxId: INBOX,
      emailId: null,
    })
  })

  it('re-alerts when it replaces a previous summary — but never `renotify` together with `silent`', () => {
    // Same tag ⇒ the new summary REPLACES the old one; without renotify the user would be left with a
    // stale count they never saw change. Chrome rejects renotify+silent, so sound off drops it.
    expect(buildSummaryNotification(5, INBOX, RENDER).options.renotify).toBe(true)
    const muted = buildSummaryNotification(5, INBOX, { ...RENDER, sound: false })
    expect(muted.options.renotify).toBeUndefined()
    expect(muted.options.silent).toBe(true)
  })
})

describe('coerceNotificationPrefs', () => {
  it('a missing or unusable row reads as the defaults — never as "notify everything"', () => {
    for (const bad of [undefined, null, 'nope', 42, []]) {
      expect(coerceNotificationPrefs(bad)).toEqual(DEFAULT_NOTIFICATION_PREFS)
    }
    expect(DEFAULT_NOTIFICATION_PREFS.enabled).toBe(false)
    expect(DEFAULT_NOTIFICATION_PREFS.mailboxIds).toEqual([])
  })

  it('keeps what it can and drops what it cannot', () => {
    const coerced = coerceNotificationPrefs({
      enabled: true,
      mailboxIds: [INBOX, 42, null, ARCHIVE],
      quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
      preview: false,
      sound: false,
    })
    expect(coerced).toEqual({
      enabled: true,
      mailboxIds: [INBOX, ARCHIVE],
      quietHours: { fromMinutes: 1320, toMinutes: 420 },
      preview: false,
      sound: false,
    })
  })

  it('drops a malformed quiet window rather than muting the user forever', () => {
    for (const bad of [
      {},
      { fromMinutes: 1 },
      { fromMinutes: -1, toMinutes: 5 },
      { fromMinutes: 0, toMinutes: 1440 },
    ]) {
      expect(
        coerceNotificationPrefs({ quietHours: bad }).quietHours,
        JSON.stringify(bad),
      ).toBeNull()
    }
  })

  it('treats an UNSET preview/sound as on, not off', () => {
    const coerced = coerceNotificationPrefs({ enabled: true })
    expect(coerced.preview).toBe(true)
    expect(coerced.sound).toBe(true)
  })
})

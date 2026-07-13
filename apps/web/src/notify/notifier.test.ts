/**
 * The notifier's impure edge (M3.6). Everything it decides is `notify-model`'s (tested there); what
 * is asserted here is the wiring: which prefs it reads, when it reaches for a registration, what it
 * does when there is none, and that one refused banner cannot take the rest down.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplicaDb } from '../sync/db'
import { setPref } from '../sync/repo'
import { email, freshDb } from '../sync/test-utils'
import { createMailNotifier } from './notifier'
import { NOTIFY_PREF_KEY, type NotificationPrefs } from './notify-model'
import type { NotificationPermissionState } from './permission'
import type { ShowNotificationRegistration } from './registration'

const ACC = 'acc'
const INBOX = 'mb-inbox'
const SINCE = Date.parse('2026-07-13T09:00:00Z')
const NOW = Date.parse('2026-07-13T12:00:00Z')

const PREFS: NotificationPrefs = {
  enabled: true,
  mailboxIds: [INBOX],
  quietHours: null,
  preview: true,
  sound: true,
}

let db: ReplicaDb

function fakeRegistration() {
  const shown: Array<{ title: string; options: NotificationOptions | undefined }> = []
  const registration: ShowNotificationRegistration = {
    showNotification: async (title, options) => {
      shown.push({ title, options })
    },
    getNotifications: async () => [],
  }
  return { registration, shown }
}

/** A new arrival in the inbox, dated after the floor. */
function arrival(id: string, receivedAt = '2026-07-13T10:00:00Z') {
  return email(id, {
    mailboxIds: { [INBOX]: true },
    keywords: {},
    receivedAt,
    subject: `Subject ${id}`,
  })
}

function notifier(
  over: {
    registration?: () => Promise<ShowNotificationRegistration | null>
    permission?: () => NotificationPermissionState
  } = {},
) {
  return createMailNotifier({
    db,
    accountId: ACC,
    productName: 'Postfach',
    permission: over.permission ?? (() => 'granted'),
    registration: over.registration ?? (async () => fakeRegistration().registration),
    translate: (key, vars) => (vars?.count === undefined ? key : `${key}:${String(vars.count)}`),
    assetUrl: (file) => `https://host/${file}`,
  })
}

beforeEach(async () => {
  db = freshDb()
  await setPref(db, ACC, NOTIFY_PREF_KEY, PREFS)
})

describe('createMailNotifier', () => {
  it('raises one banner per new message', async () => {
    const { registration, shown } = fakeRegistration()
    await notifier({ registration: async () => registration })([arrival('e1'), arrival('e2')], {
      now: NOW,
      sinceMs: SINCE,
    })
    expect(shown).toHaveLength(2)
    expect(shown.map((s) => s.options?.tag)).toEqual(['waxwing:acc:mail:e1', 'waxwing:acc:mail:e2'])
  })

  it('collapses a BURST into a single summary — a wall of banners is worse than none', async () => {
    const { registration, shown } = fakeRegistration()
    const burst = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => arrival(id))
    await notifier({ registration: async () => registration })(burst, { now: NOW, sinceMs: SINCE })
    expect(shown).toHaveLength(1)
    expect(shown[0]?.options?.tag).toBe('waxwing:acc:summary')
    expect(shown[0]?.options?.body).toBe('notify.body.count:5')
  })

  it('shows nothing when the master switch is off', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, { ...PREFS, enabled: false })
    const { registration, shown } = fakeRegistration()
    await notifier({ registration: async () => registration })([arrival('e1')], {
      now: NOW,
      sinceMs: SINCE,
    })
    expect(shown).toEqual([])
  })

  it('shows nothing without permission, whatever the prefs say', async () => {
    const { registration, shown } = fakeRegistration()
    await notifier({ registration: async () => registration, permission: () => 'denied' })(
      [arrival('e1')],
      { now: NOW, sinceMs: SINCE },
    )
    expect(shown).toEqual([])
  })

  it('shows nothing inside the quiet window', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, {
      ...PREFS,
      quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
    })
    const { registration, shown } = fakeRegistration()
    const threeAmLocal = new Date(2026, 6, 13, 3, 0).getTime()
    await notifier({ registration: async () => registration })([arrival('e1')], {
      now: threeAmLocal,
      sinceMs: SINCE,
    })
    expect(shown).toEqual([])
  })

  it('reads the PREVIEW preference from the replica, and honours it', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, { ...PREFS, preview: false })
    const { registration, shown } = fakeRegistration()
    await notifier({ registration: async () => registration })([arrival('e1')], {
      now: NOW,
      sinceMs: SINCE,
    })
    expect(shown[0]?.title).toBe('Postfach')
    expect(shown[0]?.options?.body).toBe('notify.body.generic')
  })

  it('shows nothing — and NEVER constructs a Notification — when there is no registration', async () => {
    // `new Notification()` throws `TypeError: Illegal constructor` on Android Chrome. A "graceful"
    // fallback to it would be a crash on the single most important platform for this feature.
    const constructed = vi.fn()
    vi.stubGlobal('Notification', constructed)
    await notifier({ registration: async () => null })([arrival('e1')], {
      now: NOW,
      sinceMs: SINCE,
    })
    expect(constructed).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never waits on a registration for an account that would not notify anyway', async () => {
    // Resolving `serviceWorker.ready` before the predicate would make a muted account pay that await
    // on every single sync pass, forever.
    await setPref(db, ACC, NOTIFY_PREF_KEY, { ...PREFS, enabled: false })
    const registration = vi.fn(async () => fakeRegistration().registration)
    await notifier({ registration })([arrival('e1')], { now: NOW, sinceMs: SINCE })
    expect(registration).not.toHaveBeenCalled()
  })

  it('one refused banner does not take the others down, and never rejects', async () => {
    const shown: string[] = []
    const registration: ShowNotificationRegistration = {
      showNotification: async (_title, options) => {
        if (options?.tag === 'waxwing:acc:mail:e2') throw new TypeError('notification refused')
        shown.push(String(options?.tag))
      },
      getNotifications: async () => [],
    }
    await expect(
      notifier({ registration: async () => registration })(
        [arrival('e1'), arrival('e2'), arrival('e3')],
        { now: NOW, sinceMs: SINCE },
      ),
    ).resolves.toBeUndefined()
    expect(shown).toEqual(['waxwing:acc:mail:e1', 'waxwing:acc:mail:e3'])
  })

  it('does nothing at all for an empty pass', async () => {
    const registration = vi.fn(async () => fakeRegistration().registration)
    await notifier({ registration })([], { now: NOW, sinceMs: SINCE })
    expect(registration).not.toHaveBeenCalled()
  })
})

/**
 * The burst budget is measured over a rolling WINDOW, not per pass — and that is the whole point.
 *
 * The engine runs one sync pass per `StateChange`, so a mailing-list flood arrives as twenty passes of
 * ONE created id each. A per-pass cap never evaluates true even once, and the user gets twenty banners:
 * the exact storm the cap is named for is the one a per-pass cap cannot see.
 */
describe('createMailNotifier — the rolling burst budget', () => {
  it('lets exactly NOTIFY_BURST_CAP through, then collapses — the boundary, explicitly', async () => {
    const three = fakeRegistration()
    await notifier({ registration: async () => three.registration })(
      ['a1', 'a2', 'a3'].map((id) => arrival(id)),
      { now: NOW, sinceMs: SINCE },
    )
    expect(three.shown).toHaveLength(3) // 3 == cap → still individual banners

    const four = fakeRegistration()
    await notifier({ registration: async () => four.registration })(
      ['b1', 'b2', 'b3', 'b4'].map((id) => arrival(id)),
      { now: NOW, sinceMs: SINCE },
    )
    expect(four.shown).toHaveLength(1) // 4 > cap → one summary
    expect(four.shown[0]?.options?.tag).toBe('waxwing:acc:summary')
  })

  it('a slow flood — one message per pass — collapses once the budget is spent', async () => {
    const { registration, shown } = fakeRegistration()
    const notify = notifier({ registration: async () => registration })

    // Twenty passes, one arrival each, two seconds apart: all well inside the 60 s window.
    for (let i = 0; i < 20; i++) {
      await notify([arrival(`m${i}`)], { now: NOW + i * 2_000, sinceMs: SINCE })
    }

    const individual = shown.filter((s) => s.options?.tag !== 'waxwing:acc:summary')
    expect(individual).toHaveLength(3) // the budget, and not one banner more
    // Everything after it is the summary being replaced, and it counts UP rather than resetting.
    const summaries = shown.filter((s) => s.options?.tag === 'waxwing:acc:summary')
    expect(summaries).toHaveLength(17)
    expect(summaries.at(-1)?.options?.body).toBe('notify.body.count:20')
  })

  it('the summary ACCUMULATES across replacements — 5 then 4 reads 9, not 4', async () => {
    // One tag, so each summary replaces the last. Counting only the latest pass would tell the user
    // four messages arrived when nine did.
    const { registration, shown } = fakeRegistration()
    const notify = notifier({ registration: async () => registration })

    await notify(
      ['a', 'b', 'c', 'd', 'e'].map((id) => arrival(id)),
      { now: NOW, sinceMs: SINCE },
    )
    await notify(
      ['f', 'g', 'h', 'i'].map((id) => arrival(id)),
      { now: NOW + 5_000, sinceMs: SINCE },
    )

    expect(shown).toHaveLength(2)
    expect(shown[0]?.options?.body).toBe('notify.body.count:5')
    expect(shown[1]?.options?.body).toBe('notify.body.count:9')
  })

  it('the budget returns once the window has passed', async () => {
    const { registration, shown } = fakeRegistration()
    const notify = notifier({ registration: async () => registration })

    await notify(
      ['a', 'b', 'c', 'd'].map((id) => arrival(id)),
      { now: NOW, sinceMs: SINCE },
    )
    expect(shown).toHaveLength(1) // summary — budget spent

    // Two minutes later the window is empty again, so a single arrival is worth its own banner and the
    // running total has been forgotten.
    await notify([arrival('later', '2026-07-13T10:30:00Z')], {
      now: NOW + 120_000,
      sinceMs: SINCE,
    })
    expect(shown).toHaveLength(2)
    expect(shown[1]?.options?.tag).toBe('waxwing:acc:mail:later')
  })
})

describe('createMailNotifier — the registration lookup', () => {
  it('negative-caches a missing registration instead of paying the timeout every pass', async () => {
    // `getNotificationRegistration()` races `serviceWorker.ready`, which NEVER settles when nothing is
    // registered — a 404 on sw.js after a bad deploy. The notify call is awaited inside the sync pass,
    // and `stop()` awaits the pass, so an un-cached miss would tax every pass AND every sign-out.
    const registration = vi.fn(async () => null)
    const notify = notifier({ registration })

    await notify([arrival('e1')], { now: NOW, sinceMs: SINCE })
    await notify([arrival('e2')], { now: NOW + 1_000, sinceMs: SINCE })
    await notify([arrival('e3')], { now: NOW + 30_000, sinceMs: SINCE })
    expect(registration).toHaveBeenCalledTimes(1)

    // …but it is a cache, not a verdict: past the retry window we look again.
    await notify([arrival('e4')], { now: NOW + 61_000, sinceMs: SINCE })
    expect(registration).toHaveBeenCalledTimes(2)
  })

  it('a registration, once found, is never looked up again', async () => {
    const { registration: found } = fakeRegistration()
    const lookup = vi.fn(async () => found)
    const notify = notifier({ registration: lookup })

    await notify([arrival('e1')], { now: NOW, sinceMs: SINCE })
    await notify([arrival('e2')], { now: NOW + 1_000, sinceMs: SINCE })
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

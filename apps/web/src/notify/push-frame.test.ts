/**
 * The push-frame classifier (M4.0). Its inputs come off the wire from a server we do not control,
 * through the browser's push decryption, so every test here is really the same question asked in a
 * different shape: *does a payload we did not expect stay quiet instead of throwing?* A throw inside
 * the `push` handler is a notification that never appears, with nothing on screen to say so.
 */

import { EMAIL_DELIVERY_TYPE, EMAIL_PUSH_TYPE } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  classifyPushFrame,
  EMAIL_DELIVERY,
  EMAIL_PUSH,
  isPushVerificationMessage,
  PUSH_VERIFICATION,
  type PushBannerDecision,
  type PushBannerStrings,
  parsePushFrame,
  pushBannerContent,
  shouldRaisePushBanner,
} from './push-frame'
import { inQuietHours } from './quiet-hours'

/**
 * The duplication guard promised in the module header.
 *
 * `push-frame.ts` cannot import the canonical constant: a value import from `@waxwing/jmap` would
 * drag the SSE and WebSocket transports into the service worker's typecheck (where `EventSource`
 * does not exist) and into `sw.js`. This test lives in the APP program, which may import both — so
 * the day the wire name changes on one side, this goes red instead of the worker silently listening
 * for a type nobody sends.
 */
it('agrees with @waxwing/jmap about the delivery type name', () => {
  expect(EMAIL_DELIVERY).toBe(EMAIL_DELIVERY_TYPE)
})

it('agrees with @waxwing/jmap about the EmailPush type name', () => {
  expect(EMAIL_PUSH).toBe(EMAIL_PUSH_TYPE)
})

describe('classifyPushFrame — a StateChange', () => {
  const stateChange = (changed: unknown) => ({ '@type': 'StateChange', changed })

  it('is a delivery when any account reports EmailDelivery', () => {
    // The exact frame captured from Stalwart v0.16.14 while bob submitted to alice.
    const frame = classifyPushFrame(
      stateChange({ b: { Thread: 'sae', Mailbox: 'sae', EmailDelivery: 'sae', Email: 'sae' } }),
    )
    expect(frame).toEqual({ kind: 'delivery', accountIds: ['b'] })
  })

  /**
   * The distinction the whole contentless design rests on. `Email` moves when someone reads a
   * message on their phone; buzzing for that would make the feature worse than nothing, and no
   * amount of client-side cleverness could tell the difference from a bare state string.
   */
  it('is NOT a delivery when only Email changed', () => {
    expect(classifyPushFrame(stateChange({ b: { Email: 'sae', Thread: 'sae' } }))).toEqual({
      kind: 'stateChange',
    })
  })

  it('collects every account that reported a delivery — a subscription spans credentials', () => {
    const frame = classifyPushFrame(
      stateChange({ a: { Email: 'x' }, b: { EmailDelivery: 'y' }, c: { EmailDelivery: 'z' } }),
    )
    expect(frame).toEqual({ kind: 'delivery', accountIds: ['b', 'c'] })
  })

  it('survives a changed map that is not a map of maps', () => {
    for (const changed of [null, 'nope', 42, [], { b: 'not-an-object' }, { b: null }]) {
      expect(classifyPushFrame(stateChange(changed))).toEqual({ kind: 'stateChange' })
    }
  })

  it('reads EmailDelivery as a KEY, not as a value anywhere in the object', () => {
    // A server whose state string happens to spell the type name must not be read as a delivery.
    expect(classifyPushFrame(stateChange({ b: { Email: 'EmailDelivery' } }))).toEqual({
      kind: 'stateChange',
    })
  })

  it('is not fooled by a prototype-borne key', () => {
    // `Object.hasOwn`, not `in`: `{}.EmailDelivery` is undefined but `'EmailDelivery' in {}` would be
    // true if anything ever polluted Object.prototype. Belt and braces on attacker-adjacent JSON.
    const changed = Object.create({ EmailDelivery: 'inherited' }) as Record<string, unknown>
    changed.Email = 'sae'
    expect(classifyPushFrame(stateChange({ b: changed }))).toEqual({ kind: 'stateChange' })
  })
})

describe('classifyPushFrame — a PushVerification', () => {
  it('carries the id and the code through', () => {
    expect(
      classifyPushFrame({
        '@type': 'PushVerification',
        pushSubscriptionId: 'sub-1',
        verificationCode: 'code-1',
      }),
    ).toEqual({ kind: 'verification', pushSubscriptionId: 'sub-1', verificationCode: 'code-1' })
  })

  /**
   * An empty code written back is indistinguishable from never having verified — the subscription
   * would sit silent forever with the app believing the handshake completed. Refusing it here means
   * the next start re-subscribes instead.
   */
  it('rejects an empty or missing code rather than writing nothing back', () => {
    for (const bad of [
      { pushSubscriptionId: 'sub-1', verificationCode: '' },
      { pushSubscriptionId: '', verificationCode: 'code-1' },
      { pushSubscriptionId: 'sub-1' },
      { verificationCode: 'code-1' },
      { pushSubscriptionId: 1, verificationCode: 'code-1' },
    ]) {
      expect(classifyPushFrame({ '@type': 'PushVerification', ...bad })).toEqual({
        kind: 'unknown',
      })
    }
  })
})

describe('classifyPushFrame — everything else', () => {
  it('is unknown, never a throw', () => {
    for (const value of [null, undefined, 0, '', 'text', [], {}, { '@type': 'Response' }]) {
      expect(classifyPushFrame(value)).toEqual({ kind: 'unknown' })
    }
  })
})

describe('parsePushFrame', () => {
  it('treats an empty push as unknown — some services send one to keep an endpoint warm', () => {
    for (const value of [null, undefined, '']) {
      expect(parsePushFrame(value)).toEqual({ kind: 'unknown' })
    }
  })

  it('does not throw on a payload that is not JSON', () => {
    expect(parsePushFrame('{ not json')).toEqual({ kind: 'unknown' })
    expect(parsePushFrame('<html>')).toEqual({ kind: 'unknown' })
  })

  it('parses a real delivery frame end to end', () => {
    const text = JSON.stringify({
      '@type': 'StateChange',
      changed: { b: { EmailDelivery: 'sae' } },
    })
    expect(parsePushFrame(text)).toEqual({ kind: 'delivery', accountIds: ['b'] })
  })
})

describe('shouldRaisePushBanner', () => {
  const delivery = { kind: 'delivery', accountIds: ['b'] } as const
  const input = (over: Partial<Parameters<typeof shouldRaisePushBanner>[0]> = {}) => ({
    frame: delivery as Parameters<typeof shouldRaisePushBanner>[0]['frame'],
    hasState: true,
    hasVisibleClient: false,
    quietHours: null,
    minutesOfDay: 12 * 60,
    ...over,
  })

  it('raises a banner for a delivery with nothing in the way', () => {
    expect(shouldRaisePushBanner(input())).toEqual({ show: true })
  })

  it('stays silent for anything that is not a delivery', () => {
    for (const frame of [
      { kind: 'stateChange' } as const,
      { kind: 'unknown' } as const,
      { kind: 'verification', pushSubscriptionId: 'a', verificationCode: 'b' } as const,
    ]) {
      expect(shouldRaisePushBanner(input({ frame }))).toEqual({
        show: false,
        because: 'notADelivery',
      })
    }
  })

  /**
   * No handover record means no translated text. Inventing one — a hardcoded "New mail" — is exactly
   * what the store exists to prevent, and it would ship an English string to a German user.
   */
  it('stays silent when the page left no state to render from', () => {
    expect(shouldRaisePushBanner(input({ hasState: false }))).toEqual({
      show: false,
      because: 'noState',
    })
  })

  /**
   * The live channel has already raised the RICHER banner, with sender and subject. Two banners for
   * one message is worse than one — the most deliberate of the four cases in which the worker accepts
   * a push and shows nothing, having promised `userVisibleOnly: true` (see the next test for the set).
   */
  it('stays silent while a window of ours is visible', () => {
    expect(shouldRaisePushBanner(input({ hasVisibleClient: true }))).toEqual({
      show: false,
      because: 'visible',
    })
  })

  /**
   * The set of silences, stated rather than implied. `sw.ts` returns without `showNotification` for
   * every `show: false`, so the `userVisibleOnly: true` promise is broken in FOUR ways, not one —
   * and a comment claiming otherwise (this file used to) makes the next reader believe quiet hours
   * pop something. They do not, by design: the only measured point is the B29 hand-check
   * (Chrome/FCM, 2026-07-24), where quiet hours suppressed the banner with no generic
   * "updated in the background" notice. If that ever has to change, `silent: true` is NOT the fix —
   * it still pops on macOS and Windows.
   */
  it('accepts the push and shows NOTHING in every one of the four cases', () => {
    // Keyed by the reason and typed as a TOTAL Record, so the set is exhaustive by construction: a
    // fifth `because` added to `PushBannerDecision` fails to compile here until it is given a case.
    type SilentReason = Extract<PushBannerDecision, { show: false }>['because']
    const cases: Record<SilentReason, Parameters<typeof input>[0]> = {
      notADelivery: { frame: { kind: 'stateChange' } },
      noState: { hasState: false },
      quietHours: { quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 }, minutesOfDay: 3 * 60 },
      visible: { hasVisibleClient: true },
    }
    for (const [because, over] of Object.entries(cases)) {
      expect(shouldRaisePushBanner(input(over)), because).toEqual({ show: false, because })
    }
  })

  it('applies quiet hours, including a window that crosses midnight', () => {
    const night = { fromMinutes: 22 * 60, toMinutes: 7 * 60 }
    for (const minutesOfDay of [22 * 60, 23 * 60, 0, 3 * 60, 6 * 60 + 59]) {
      expect(shouldRaisePushBanner(input({ quietHours: night, minutesOfDay }))).toEqual({
        show: false,
        because: 'quietHours',
      })
    }
    for (const minutesOfDay of [7 * 60, 12 * 60, 21 * 60 + 59]) {
      expect(shouldRaisePushBanner(input({ quietHours: night, minutesOfDay }))).toEqual({
        show: true,
      })
    }
  })

  it('treats an empty quiet window as OFF, never as always-quiet', () => {
    const empty = { fromMinutes: 9 * 60, toMinutes: 9 * 60 }
    expect(shouldRaisePushBanner(input({ quietHours: empty, minutesOfDay: 9 * 60 }))).toEqual({
      show: true,
    })
  })

  /**
   * The single most valuable assertion in this file. `quiet-hours.ts` is DOM-free precisely so the
   * worker and the live channel share ONE copy of the midnight-crossing rule; if someone ever
   * "simplifies" this by inlining a second one, the two paths drift and the symptom is quiet hours
   * that work with the app open and fail with it closed — at 3 a.m., where nobody is watching.
   */
  it('agrees with the live channel about every minute of the day, both orientations', () => {
    for (const range of [
      { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
      { fromMinutes: 9 * 60, toMinutes: 17 * 60 },
      { fromMinutes: 0, toMinutes: 1 },
      { fromMinutes: 1439, toMinutes: 0 },
    ]) {
      for (let minutesOfDay = 0; minutesOfDay < 1440; minutesOfDay++) {
        const quiet = inQuietHours(minutesOfDay, range)
        const decision = shouldRaisePushBanner(input({ quietHours: range, minutesOfDay }))
        expect(decision.show).toBe(!quiet)
      }
    }
  })

  /**
   * Order: a visible window wins over quiet hours. During quiet hours with the app open it is the
   * LIVE channel that decided to stay silent, and this path must not second-guess it in either
   * direction — the reported reason is what pins which rule fired.
   */
  it('reports `visible` rather than `quietHours` when both apply', () => {
    expect(
      shouldRaisePushBanner(
        input({
          hasVisibleClient: true,
          quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
          minutesOfDay: 23 * 60,
        }),
      ),
    ).toEqual({ show: false, because: 'visible' })
  })

  it('reports `noState` before anything else — there is nothing to show either way', () => {
    expect(shouldRaisePushBanner(input({ hasState: false, hasVisibleClient: true }))).toEqual({
      show: false,
      because: 'noState',
    })
  })
})

describe('isPushVerificationMessage', () => {
  it('accepts what the worker posts and rejects everything else', () => {
    expect(
      isPushVerificationMessage({
        type: PUSH_VERIFICATION,
        pushSubscriptionId: 'a',
        verificationCode: 'b',
      }),
    ).toBe(true)
    for (const bad of [
      null,
      'PUSH_VERIFICATION',
      { type: 'NOTIFY_CLICK', path: '/mail' },
      { type: PUSH_VERIFICATION, pushSubscriptionId: 'a' },
      { type: PUSH_VERIFICATION, pushSubscriptionId: 1, verificationCode: 'b' },
    ]) {
      expect(isPushVerificationMessage(bad)).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------------------------
// draft-ietf-jmap-emailpush-03 — the push that carries the mail (ADR-017 amendment, 2026-08-21)
// -----------------------------------------------------------------------------------------------

/**
 * The payload captured verbatim at the push endpoint from Stalwart v0.16.18 on 2026-08-21
 * (`docs/jmap-gap-2026-08-21/berichte/E-emailpush.md`). Not a shape invented here: everything below
 * asserts against what a real server actually sent.
 */
const MEASURED_EMAIL_PUSH = {
  '@type': 'EmailPush',
  accountId: 'b',
  emails: [
    {
      from: [{ name: 'Bob Beispiel', email: 'bob@waxwing.test' }],
      subject: 'Rechnung 2026-08 faellig',
      preview: 'Hallo Alice, anbei die Rechnung fuer August. Bitte bis Ende der Woche pruefen.',
      receivedAt: '2026-08-21T16:16:25Z',
    },
  ],
  state: 'sae',
}

describe('classifyPushFrame — an EmailPush', () => {
  /**
   * **THE regression this whole work package could produce, and the reason it is the first test.**
   *
   * A server that has an `emailPush` config for an account sends an `EmailPush` for a delivery and
   * does NOT also send the `StateChange` — measured, `push.rs:332`, and confirmed on the wire with
   * `types: ["Email","EmailDelivery","Mailbox","Thread"]` still set. So from the moment Waxwing
   * configures the property, every `StateChange` that used to arrive on this channel stops arriving.
   * Anything downstream that keys off `kind === 'delivery'` — the banner today, a sync wake-up
   * tomorrow — must therefore see the two frames as the SAME outcome, naming the SAME account.
   *
   * Written as an equality between the two shapes rather than as two separate assertions, because
   * the failure mode being guarded against is precisely a divergence: a `kind: 'emailPush'` of its
   * own would pass any test that only looked at the new frame.
   */
  it('is the SAME delivery, for the same account, as the StateChange it replaced', () => {
    const viaStateChange = classifyPushFrame({
      '@type': 'StateChange',
      changed: { b: { Thread: 'sae', Mailbox: 'sae', EmailDelivery: 'sae', Email: 'sae' } },
    })
    const viaEmailPush = classifyPushFrame(MEASURED_EMAIL_PUSH)

    expect(viaStateChange.kind).toBe('delivery')
    expect(viaEmailPush.kind).toBe('delivery')
    // The account is what a sync wake-up would act on, and it must survive the transport change.
    expect(viaEmailPush.kind === 'delivery' ? viaEmailPush.accountIds : null).toEqual(
      viaStateChange.kind === 'delivery' ? viaStateChange.accountIds : undefined,
    )
  })

  it('carries the change id, which is what a Foo/changes call would resume from', () => {
    const frame = classifyPushFrame(MEASURED_EMAIL_PUSH)
    expect(frame.kind === 'delivery' ? frame.state : null).toBe('sae')
  })

  it('reads sender, subject, preview and arrival out of the measured payload', () => {
    const frame = classifyPushFrame(MEASURED_EMAIL_PUSH)
    expect(frame.kind === 'delivery' ? frame.messages : null).toEqual([
      {
        sender: 'Bob Beispiel',
        subject: 'Rechnung 2026-08 faellig',
        preview: 'Hallo Alice, anbei die Rechnung fuer August. Bitte bis Ende der Woche pruefen.',
        receivedAt: Date.parse('2026-08-21T16:16:25Z'),
      },
    ])
  })

  it('falls back to the address when the sender has no display name', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ from: [{ name: null, email: 'bob@waxwing.test' }], subject: 'Hi' }],
      state: 's',
    })
    expect(frame.kind === 'delivery' ? frame.messages?.[0]?.sender : null).toBe('bob@waxwing.test')
  })

  /**
   * A folded `Subject:` header arrives with embedded CRLF and leading spaces. Left alone it renders
   * as a blank gap in the banner — and `body` is the one field where a newline is load-bearing
   * (it separates subject from preview), so a stray one would look like a missing subject.
   */
  it('collapses the whitespace a header may legitimately carry', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ subject: '  Quarterly\r\n figures\t ', preview: '\n\nHi there\n' }],
      state: 's',
    })
    expect(frame.kind === 'delivery' ? frame.messages?.[0] : null).toMatchObject({
      subject: 'Quarterly figures',
      preview: 'Hi there',
    })
  })

  /**
   * Nothing here comes from us: it is a server we do not control, decrypted by the browser and
   * handed to a worker that may not throw. Every one of these must classify without an exception,
   * and every one of them must still be a DELIVERY — the `@type` alone says mail arrived, and
   * `userVisibleOnly: true` was promised at subscribe time.
   */
  it('survives every malformed shape and still counts as a delivery', () => {
    for (const bad of [
      { '@type': 'EmailPush' },
      { '@type': 'EmailPush', accountId: 7, emails: 'nope', state: null },
      { '@type': 'EmailPush', accountId: '', emails: [null, 3, 'x'], state: '' },
      { '@type': 'EmailPush', accountId: 'b', emails: [{ from: 'bob', subject: 42 }] },
      { '@type': 'EmailPush', accountId: 'b', emails: [{ from: [], receivedAt: 'not-a-date' }] },
    ]) {
      const frame = classifyPushFrame(bad)
      expect(frame.kind).toBe('delivery')
    }
  })

  it('names no account rather than inventing one when accountId is unusable', () => {
    const frame = classifyPushFrame({ '@type': 'EmailPush', emails: [], state: 's' })
    expect(frame).toEqual({ kind: 'delivery', accountIds: [], messages: [], state: 's' })
  })

  it('parses the measured payload end to end, as it arrives from event.data.text()', () => {
    const frame = parsePushFrame(JSON.stringify(MEASURED_EMAIL_PUSH))
    expect(frame.kind).toBe('delivery')
    expect(frame.kind === 'delivery' ? frame.messages?.[0]?.subject : null).toBe(
      'Rechnung 2026-08 faellig',
    )
  })

  /** A StateChange says nothing about any message, and must not pretend to by carrying `[]`. */
  it('leaves `messages` ABSENT for a StateChange, not empty', () => {
    const frame = classifyPushFrame({
      '@type': 'StateChange',
      changed: { b: { EmailDelivery: 'sae' } },
    })
    expect(frame.kind === 'delivery' && 'messages' in frame).toBe(false)
  })
})

describe('pushBannerContent', () => {
  const strings = (over: Partial<PushBannerStrings> = {}): PushBannerStrings => ({
    title: 'Waxwing',
    body: 'New message',
    unknownSender: 'Unknown sender',
    noSubject: '(no subject)',
    preview: true,
    ...over,
  })

  /**
   * The shape Apple's Mail uses: sender on the title line (bold on every platform), subject next,
   * preview after it. No count, no product name, no ornament — a notification is read in half a
   * second, and every element that is not one of those three costs one that is.
   */
  it('puts the sender in the title and the subject above the preview', () => {
    const frame = classifyPushFrame(MEASURED_EMAIL_PUSH)
    expect(pushBannerContent(frame, strings())).toEqual({
      title: 'Bob Beispiel',
      body: 'Rechnung 2026-08 faellig\nHallo Alice, anbei die Rechnung fuer August. Bitte bis Ende der Woche pruefen.',
      timestamp: Date.parse('2026-08-21T16:16:25Z'),
    })
  })

  /**
   * **The privacy toggle, enforced a second time — at the last possible moment.**
   *
   * With it off no `emailPush` config is sent, so this frame should not exist at all. It can:
   * the server-side config is only rewritten on the app's next start, so a content push can be in
   * flight when the user flips the switch. The push is delivered either way; the banner is ours.
   */
  it('shows nothing from the message when the preview toggle is off', () => {
    const frame = classifyPushFrame(MEASURED_EMAIL_PUSH)
    const content = pushBannerContent(frame, strings({ preview: false }))
    expect(content).toEqual({ title: 'Waxwing', body: 'New message', timestamp: null })
    expect(JSON.stringify(content)).not.toContain('Bob')
    expect(JSON.stringify(content)).not.toContain('Rechnung')
  })

  it('falls back to the contentless wording for a StateChange delivery', () => {
    const frame = classifyPushFrame({
      '@type': 'StateChange',
      changed: { b: { EmailDelivery: 'sae' } },
    })
    expect(pushBannerContent(frame, strings())).toEqual({
      title: 'Waxwing',
      body: 'New message',
      timestamp: null,
    })
  })

  /**
   * The 4096-byte budget is the server's and it truncates on its own, so a push can arrive with one
   * half of the pair missing. Whichever half survives is still worth showing, and the gap beside it
   * gets a translated placeholder — never an empty line, and never an English literal, because the
   * page put both strings in the handover record for exactly this.
   */
  it('names the missing half in the user’s language and shows the half that arrived', () => {
    const noSubject = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [
        { from: [{ name: 'Bob Beispiel', email: 'b@x' }], receivedAt: '2026-08-21T16:16:25Z' },
      ],
      state: 's',
    })
    expect(pushBannerContent(noSubject, strings())).toEqual({
      title: 'Bob Beispiel',
      body: '(no subject)',
      timestamp: Date.parse('2026-08-21T16:16:25Z'),
    })

    const noSender = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ subject: 'Quarterly figures' }],
      state: 's',
    })
    expect(pushBannerContent(noSender, strings())).toEqual({
      title: 'Unknown sender',
      body: 'Quarterly figures',
      timestamp: null,
    })
  })

  /**
   * Nothing showable at all — a push truncated past the point of usefulness, or one asking for
   * properties this banner does not read. "Unknown sender / (no subject)" would be an alarming way
   * of saying less than "New message" does; the generic wording is both calmer and more informative.
   */
  it('falls back to the contentless wording when a message carries none of the three', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ receivedAt: '2026-08-21T16:16:25Z', id: 'uaaa' }],
      state: 's',
    })
    expect(pushBannerContent(frame, strings())).toEqual({
      title: 'Waxwing',
      body: 'New message',
      timestamp: null,
    })
  })

  it('omits the preview line entirely when the server sent none', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ from: [{ name: 'Bob', email: 'b@x' }], subject: 'Hi' }],
      state: 's',
    })
    expect(pushBannerContent(frame, strings()).body).toBe('Hi')
  })

  /**
   * Stalwart bundles arrivals inside its `push_throttle` window, so `emails` can hold several. One
   * banner replaces the last (they share a tag), so the newest is the one worth showing — the choice
   * iOS makes, and the only one that does not leave a stale name on the lock screen.
   */
  it('shows the NEWEST message when the server bundled several into one push', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [
        {
          from: [{ name: 'Old', email: 'o@x' }],
          subject: 'First',
          receivedAt: '2026-08-21T10:00:00Z',
        },
        {
          from: [{ name: 'New', email: 'n@x' }],
          subject: 'Second',
          receivedAt: '2026-08-21T11:00:00Z',
        },
        {
          from: [{ name: 'Mid', email: 'm@x' }],
          subject: 'Third',
          receivedAt: '2026-08-21T10:30:00Z',
        },
      ],
      state: 's',
    })
    expect(pushBannerContent(frame, strings())).toMatchObject({ title: 'New', body: 'Second' })
  })

  it('falls back to the contentless wording when a bundle carried nothing usable', () => {
    const frame = classifyPushFrame({
      '@type': 'EmailPush',
      accountId: 'b',
      emails: [{ receivedAt: '2026-08-21T10:00:00Z', id: 'x' }, {}],
      state: 's',
    })
    // Every entry is empty of the three things a banner can show, so there is nothing to say.
    expect(pushBannerContent(frame, strings())).toEqual({
      title: 'Waxwing',
      body: 'New message',
      timestamp: null,
    })
  })

  it('says the generic thing for a verification or an unknown frame', () => {
    for (const frame of [
      { kind: 'unknown' } as const,
      { kind: 'stateChange' } as const,
      { kind: 'verification', pushSubscriptionId: 'a', verificationCode: 'b' } as const,
    ]) {
      expect(pushBannerContent(frame, strings())).toEqual({
        title: 'Waxwing',
        body: 'New message',
        timestamp: null,
      })
    }
  })
})

/**
 * Participants and RSVP (K-3 / K-10, FR-CAL-01).
 *
 * Two assertions carry this file, and both come from a measurement rather than a specification.
 *
 * **The server adds a participant the client did not write.** Create an event with one attendee and
 * read it back: there are two, the second under a UUID key with the organiser's address,
 * `roles: {owner: true}` and nothing else. If the client also listed the organiser, that address is
 * now in the map twice. Verbatim from the probe against v0.16.18 on 21.08.2026:
 *
 * ```jsonc
 * "participants": {
 *   "p1": { "calendarAddress":"mailto:kx2@waxwing.test", "name":"KX2",
 *           "participationStatus":"needs-action", "expectReply":true },
 *   "8e90f0e6-2ad7-5633-aad2-cbbc6357c67c": {
 *           "calendarAddress":"mailto:kx1@waxwing.test", "roles":{"owner":true} } }
 * ```
 *
 * **RSVP is one pointer and one field.** `"participants/<key>/participationStatus"` is answered
 * `updated`, and everything else on that participant survives. Writing the whole map to change one
 * word would re-send every participant as this client models them — dropping the delegate, the
 * `kind` or the `scheduleAgent` of somebody it does not.
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  findSelf,
  newParticipantRow,
  normaliseAddress,
  ownAddresses,
  participantsFromEvent,
  participantsToPatch,
  rsvpPatch,
} from './event-participants'

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: 'e1', calendarIds: { c1: true }, start: '2026-10-01T10:00:00', ...over }) as CalendarEvent

describe('normaliseAddress', () => {
  it('strips the scheme and the case, and nothing else', () => {
    expect(normaliseAddress('mailto:KX1@Waxwing.Test')).toBe('kx1@waxwing.test')
    expect(normaliseAddress('kx1@waxwing.test')).toBe('kx1@waxwing.test')
  })

  it('answers empty for anything unusable, and empty never matches', () => {
    // An address the client cannot read must not accidentally equal the reader's own — which is
    // what would decide whether the RSVP bar appears on somebody else's invitation.
    expect(normaliseAddress(undefined)).toBe('')
    expect(normaliseAddress('  ')).toBe('')
    expect(findSelf([], [''])).toBeNull()
  })
})

describe('participantsFromEvent', () => {
  it('FOLDS the organiser entry the server adds beside the one the client wrote', () => {
    /*
     * The measurement, replayed. Without the fold the organiser stands on the list twice: once with
     * a name and a status, once as a bare address — and the reader has no way to tell that those are
     * one person.
     */
    const rows = participantsFromEvent(
      event({
        organizerCalendarAddress: 'mailto:kx1@waxwing.test',
        participants: {
          o: {
            '@type': 'Participant',
            name: 'Karla',
            calendarAddress: 'mailto:kx1@waxwing.test',
            roles: { attendee: true },
            participationStatus: 'accepted',
          },
          '8e90f0e6-2ad7-5633-aad2-cbbc6357c67c': {
            '@type': 'Participant',
            calendarAddress: 'mailto:kx1@waxwing.test',
            roles: { owner: true },
          },
        },
      }),
    )

    expect(rows).toHaveLength(1)
    // Both halves survive: the client's entry had the name and the answer, the server's had the
    // role that says whose meeting it is.
    expect(rows[0]?.name).toBe('Karla')
    expect(rows[0]?.participationStatus).toBe('accepted')
    expect(rows[0]?.roles).toEqual({ owner: true, attendee: true })
    expect(rows[0]?.isOrganizer).toBe(true)
  })

  it('folds across a difference in case and scheme, because an address is an address', () => {
    const rows = participantsFromEvent(
      event({
        participants: {
          a: { '@type': 'Participant', calendarAddress: 'mailto:Bob@Waxwing.Test', name: 'Bob' },
          b: { '@type': 'Participant', calendarAddress: 'mailto:bob@waxwing.test', roles: { owner: true } },
        },
      }),
    )
    expect(rows).toHaveLength(1)
  })

  it('keeps the key that carries the STATUS, so an RSVP lands on the right record', () => {
    // The server's added entry has no `participationStatus`; the client's has. An answer written to
    // the wrong key is a status on a participant record the server treats as somebody else.
    const rows = participantsFromEvent(
      event({
        participants: {
          '8e90f0e6-2ad7-5633-aad2-cbbc6357c67c': {
            '@type': 'Participant',
            calendarAddress: 'mailto:kx1@waxwing.test',
            roles: { owner: true },
          },
          mine: {
            '@type': 'Participant',
            calendarAddress: 'mailto:kx1@waxwing.test',
            participationStatus: 'needs-action',
          },
        },
      }),
    )
    expect(rows[0]?.key).toBe('mine')
  })

  it('puts the organiser first and is stable whatever the map order was', () => {
    // JSON does not promise key order, so a list sorted by nothing reshuffles between two reads of
    // the same event — which reads as the list having changed.
    const rows = participantsFromEvent(
      event({
        organizerCalendarAddress: 'mailto:chair@waxwing.test',
        participants: {
          z: { '@type': 'Participant', calendarAddress: 'mailto:zoe@waxwing.test', name: 'Zoe' },
          a: { '@type': 'Participant', calendarAddress: 'mailto:ann@waxwing.test', name: 'Ann' },
          c: { '@type': 'Participant', calendarAddress: 'mailto:chair@waxwing.test', name: 'Chris' },
        },
      }),
    )
    expect(rows.map((row) => row.name)).toEqual(['Chris', 'Ann', 'Zoe'])
  })

  it('shows a participant with no readable address instead of merging them all into one', () => {
    // Two nameless entries with no address are two people, not one. Keying the fallback on the map
    // key rather than on the empty address is what keeps them apart.
    const rows = participantsFromEvent(
      event({
        participants: {
          a: { '@type': 'Participant', name: 'Erste' },
          b: { '@type': 'Participant', name: 'Zweite' },
        },
      }),
    )
    expect(rows).toHaveLength(2)
  })

  it('carries members it does not model through to the patch, byte for byte', () => {
    // Same stance `event-alerts.ts` takes on an alarm it cannot read. A delegate this editor has no
    // row for is not ours to discard because we have no row for it.
    const rows = participantsFromEvent(
      event({
        participants: {
          p: {
            '@type': 'Participant',
            calendarAddress: 'mailto:bob@waxwing.test',
            sentBy: 'mailto:assistant@waxwing.test',
            kind: 'individual',
            expectReply: true,
          },
        },
      }),
    )
    const patch = participantsToPatch(rows)
    expect(patch.p?.sentBy).toBe('mailto:assistant@waxwing.test')
    expect((patch.p as Record<string, unknown>).kind).toBe('individual')
  })
})

describe('participantsToPatch', () => {
  it('asks for a reply from everyone who is not the organiser', () => {
    // An invitation nobody is expected to answer is a notification with extra steps — and
    // `expectReply` is what makes the server ask.
    const patch = participantsToPatch([
      newParticipantRow('bob@waxwing.test'),
      { ...newParticipantRow('chair@waxwing.test'), isOrganizer: true },
    ])
    expect(patch.pbobwaxwingtest?.expectReply).toBe(true)
    expect(patch.pchairwaxwingtest?.expectReply).toBeUndefined()
  })
})

describe('newParticipantRow', () => {
  it('derives the key from the address, so the same person twice is one entry', () => {
    expect(newParticipantRow('Bob@Waxwing.Test').key).toBe(newParticipantRow('bob@waxwing.test').key)
  })

  it('produces a key with no `/` in it', () => {
    // The key ends up in a JSON pointer (`participants/<key>/participationStatus`); a `/` in it
    // would address something else entirely and the server would answer about a path we did not
    // mean.
    expect(newParticipantRow('a.b+c/d@waxwing.test').key).not.toContain('/')
  })
})

describe('rsvpPatch', () => {
  it('names ONE pointer and ONE field', () => {
    /*
     * The load-bearing assertion of K-3. The alternative — reading `participants`, changing one
     * value and writing the map back — passes any test that only checks the resulting status, and
     * silently drops every member of every other participant that this client does not model.
     */
    const patch = rsvpPatch('p1', 'accepted')
    expect(Object.keys(patch)).toEqual(['participants/p1/participationStatus'])
    expect(patch['participants/p1/participationStatus']).toBe('accepted')
    expect(patch).not.toHaveProperty('participants')
  })
})

describe('ownAddresses and findSelf (K-10)', () => {
  it('reads the account’s own addresses from the identities', () => {
    expect(
      ownAddresses([
        { id: 'a', name: 'kx1', calendarAddress: 'mailto:kx1@waxwing.test', isDefault: true },
        { id: 'b', calendarAddress: 'mailto:KX1+alias@waxwing.test' },
        { id: 'c' },
      ]),
    ).toEqual(['kx1@waxwing.test', 'kx1+alias@waxwing.test'])
  })

  it('finds which participant is me — the one thing the RSVP bar depends on', () => {
    /*
     * Why K-10 is a prerequisite rather than a nicety: with five participants there is no way to
     * tell whose answer bar this is without the account's own addresses, and guessing from the login
     * name is wrong for every account with an alias. The session's calendar capability was expected
     * to carry a `calendarAddress` and would have been the cheap route — measured on v0.16.18, it
     * carries only the limits.
     */
    const rows = participantsFromEvent(
      event({
        participants: {
          a: { '@type': 'Participant', calendarAddress: 'mailto:zoe@waxwing.test' },
          b: { '@type': 'Participant', calendarAddress: 'mailto:kx1@waxwing.test' },
        },
      }),
    )
    expect(findSelf(rows, ['kx1@waxwing.test'])?.address).toBe('kx1@waxwing.test')
    expect(findSelf(rows, ['nobody@waxwing.test'])).toBeNull()
  })
})

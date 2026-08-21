/**
 * Participants on an event, and answering an invitation (K-3 / K-10, FR-CAL-01).
 *
 * Three measured facts shape everything in this file. All three were probed against Stalwart
 * v0.16.18 on 21.08.2026 with two throwaway accounts.
 *
 * **1. The server adds a participant the client did not write.** Create an event with one attendee
 * and an `organizerCalendarAddress`, read it back, and there are TWO participants: the attendee, and
 * a second one under a UUID key carrying the organiser's address, `roles: {owner: true}` and nothing
 * else — no name, no `participationStatus`. If the client also listed the organiser itself, that
 * address is now in the map twice under two different keys. Rendering the map as it arrives puts the
 * organiser on the screen twice, once with a name and once as a bare address. So the list is
 * **de-duplicated by calendar address** on the way in, and the two halves are merged rather than one
 * being dropped: the client's entry has the name, the server's has the `owner` role, and the screen
 * needs both.
 *
 * **2. RSVP is a pointer patch on ONE field.** `"participants/<key>/participationStatus":
 * "accepted"` is answered `updated`, and reading the event back shows only that field changed —
 * the participant's name, roles and `expectReply` survive untouched. That matters more than it
 * sounds: writing the whole `participants` map back to change one word would re-send every other
 * participant as the client last understood them, which is how a client silently drops the role or
 * the delegate of somebody it does not model.
 *
 * **3. An identity is not something a client invents.** `ParticipantIdentity/set create` with an
 * address the account does not own is refused — `"Calendar address not configured for this
 * account."` — and `isDefault` cannot be written in `create` or `update`. K-10 is therefore a READ:
 * the identities say which addresses on an event are *me*, which is the question RSVP needs
 * answered. See `ParticipantIdentity` in `@waxwing/jmap` for the full list of refusals.
 *
 * **What is out of reach, so nobody looks for it.** `CalendarEvent/participantReply` does not exist
 * (`unknownMethod`). Answering an invitation from an organiser on ANOTHER server would mean this
 * client building an iTIP REPLY mail and submitting it itself. Everything here works because the
 * organiser's copy of the event is on the same server as the reply: the patch IS the answer.
 */

import type {
  CalendarEvent,
  Participant,
  ParticipantIdentity,
  ParticipationStatus,
} from '@waxwing/jmap'

/**
 * The most participants one event may carry.
 *
 * Read from the account capability where the session offers it (`maxParticipantsPerEvent`, measured
 * `20` on v0.16.18) and only defaulted here. A limit guessed high enough to be safe would be a limit
 * that never fires; a limit guessed low would refuse an event the server would have taken.
 */
export const DEFAULT_MAX_PARTICIPANTS = 20

/**
 * One participant, as the screen shows them — a LIST entry, not the map JSCalendar stores.
 *
 * `key` is the map key the event actually uses, and it is carried through precisely so an RSVP can
 * name it in a pointer patch. Everything else is for drawing.
 */
export interface ParticipantRow {
  /** The key in `event.participants`. The only thing a write may address. */
  readonly key: string
  /** `mailto:someone@example.test`, exactly as the server spells it. */
  readonly calendarAddress: string
  /** Lower-cased, `mailto:` removed — the identity used for comparison and de-duplication. */
  readonly address: string
  readonly name: string
  readonly roles: Readonly<Record<string, boolean>>
  readonly participationStatus: ParticipationStatus | null
  /** Set for the participant carrying `roles.owner`, or the event's `organizerCalendarAddress`. */
  readonly isOrganizer: boolean
  /** Everything not modelled above, carried back byte for byte on a write. */
  readonly rest: Readonly<Record<string, unknown>>
}

/** The statuses the answer bar offers, in the order it offers them. */
export const RSVP_STATUSES: readonly ParticipationStatus[] = ['accepted', 'tentative', 'declined']

/**
 * The comparable form of a calendar address: no scheme, no case.
 *
 * Only the `mailto:` scheme is unwrapped, and only from the front. JSCalendar permits other URIs
 * and a `Participant` may carry one; comparing those as opaque lower-cased strings is right for
 * everything except a server that varies the case of a non-mailto path, which is a trade this
 * function makes knowingly and cheaply.
 *
 * `''` for anything that is not a usable string, and `''` never matches anything — an address the
 * client cannot read must not accidentally equal the reader's own.
 */
export function normaliseAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  const lower = trimmed.toLowerCase()
  return lower.startsWith('mailto:') ? lower.slice('mailto:'.length) : lower
}

/** Does this participant carry the organiser role? */
function hasOwnerRole(roles: unknown): boolean {
  return (
    typeof roles === 'object' && roles !== null && (roles as Record<string, unknown>).owner === true
  )
}

const MODELLED_KEYS = new Set(['@type', 'name', 'calendarAddress', 'roles', 'participationStatus'])

/**
 * Reads an event's `participants` map into a de-duplicated, ordered list.
 *
 * **De-duplication is by address, and it MERGES.** Two entries for one address are one person seen
 * twice; taking either one alone loses whatever the other carried. The rules, in the order they
 * decide:
 *
 *  - the surviving `key` is the first entry's, UNLESS the first has no `participationStatus` and a
 *    later one does. That exception is the whole point: the server's added organiser entry has no
 *    status, and an RSVP patch must land on the key that does — or it writes a status onto a
 *    participant record the server considers a different one.
 *  - `name`, `participationStatus` and unmodelled members fill gaps and never overwrite.
 *  - `roles` are UNIONED, so the client's `attendee` and the server's `owner` both survive.
 *
 * The organiser sorts first (Apple's order, and the one people read as "whose meeting is this"),
 * everything else by name then address, so the list does not reshuffle between two reads of a map
 * whose key order JSON does not promise.
 */
export function participantsFromEvent(event: CalendarEvent): ParticipantRow[] {
  const participants = event.participants
  if (participants === undefined || participants === null || typeof participants !== 'object') {
    return []
  }
  const organizer = normaliseAddress(event.organizerCalendarAddress)

  /** address → the row so far. Insertion order is the map's, which is the JSON document's. */
  const byAddress = new Map<string, ParticipantRow>()
  for (const [key, value] of Object.entries(participants)) {
    if (value === null || typeof value !== 'object') continue
    const participant = value as Participant & Record<string, unknown>
    const calendarAddress =
      typeof participant.calendarAddress === 'string' ? participant.calendarAddress : ''
    const address = normaliseAddress(calendarAddress)
    // A participant with no readable address cannot be merged with anything and cannot be answered
    // for; it is still shown, under its own key, so the reader sees that somebody is there.
    const identity = address === '' ? `key:${key}` : address
    const rest: Record<string, unknown> = {}
    for (const [member, memberValue] of Object.entries(participant)) {
      if (!MODELLED_KEYS.has(member)) rest[member] = memberValue
    }
    const row: ParticipantRow = {
      key,
      calendarAddress,
      address,
      name: typeof participant.name === 'string' ? participant.name : '',
      roles:
        hasOwnerRole(participant.roles) || typeof participant.roles === 'object'
          ? ((participant.roles ?? {}) as Record<string, boolean>)
          : {},
      participationStatus: readStatus(participant.participationStatus),
      isOrganizer: hasOwnerRole(participant.roles) || (address !== '' && address === organizer),
      rest,
    }
    const existing = byAddress.get(identity)
    byAddress.set(identity, existing === undefined ? row : mergeRows(existing, row))
  }

  return [...byAddress.values()].sort(compareRows)
}

function readStatus(value: unknown): ParticipationStatus | null {
  return value === 'accepted' ||
    value === 'declined' ||
    value === 'tentative' ||
    value === 'needs-action'
    ? value
    : null
}

/** Folds a duplicate entry into the one already held. See {@link participantsFromEvent}. */
function mergeRows(first: ParticipantRow, second: ParticipantRow): ParticipantRow {
  return {
    // The key follows the status, because the status is the field an RSVP writes.
    key:
      first.participationStatus === null && second.participationStatus !== null
        ? second.key
        : first.key,
    calendarAddress: first.calendarAddress === '' ? second.calendarAddress : first.calendarAddress,
    address: first.address === '' ? second.address : first.address,
    name: first.name === '' ? second.name : first.name,
    roles: { ...second.roles, ...first.roles },
    participationStatus: first.participationStatus ?? second.participationStatus,
    isOrganizer: first.isOrganizer || second.isOrganizer,
    rest: { ...second.rest, ...first.rest },
  }
}

function compareRows(a: ParticipantRow, b: ParticipantRow): number {
  if (a.isOrganizer !== b.isOrganizer) return a.isOrganizer ? -1 : 1
  const byName = (a.name || a.address).localeCompare(b.name || b.address)
  return byName !== 0 ? byName : a.address.localeCompare(b.address)
}

/**
 * The `participants` map a create or an update writes.
 *
 * Unmodelled members go back under their own names, for the same reason `event-alerts.ts` carries
 * an alert it cannot read: a delegate (`sentBy`), a `kind`, a `scheduleAgent` that another client
 * set is not ours to discard because our editor has no row for it.
 *
 * `expectReply` is set on everyone who is not the organiser and is not carrying one already — it is
 * what makes the server ask for an answer, and an invitation nobody is expected to answer is a
 * notification with extra steps.
 */
export function participantsToPatch(rows: readonly ParticipantRow[]): Record<string, Participant> {
  const map: Record<string, Participant> = {}
  for (const row of rows) {
    const participant: Participant & Record<string, unknown> = {
      ...row.rest,
      '@type': 'Participant',
      calendarAddress: row.calendarAddress,
    }
    if (row.name !== '') participant.name = row.name
    if (Object.keys(row.roles).length > 0) participant.roles = row.roles
    if (row.participationStatus !== null) participant.participationStatus = row.participationStatus
    if (!row.isOrganizer && participant.expectReply === undefined) participant.expectReply = true
    map[row.key] = participant
  }
  return map
}

/**
 * A new attendee row, ready to be added to the list.
 *
 * The key is derived from the address rather than counted, so adding the same person twice produces
 * the same key and therefore one entry — the map does the de-duplication for us, and it does it the
 * same way on a reload. Non-alphanumeric characters are replaced because a JSCalendar map key ends
 * up in a JSON pointer (`participants/<key>/participationStatus`), where a `/` in the key would
 * silently address something else.
 */
export function newParticipantRow(calendarAddress: string, name = ''): ParticipantRow {
  const address = normaliseAddress(calendarAddress)
  return {
    key: `p${address.replace(/[^a-z0-9]/g, '')}`,
    calendarAddress: calendarAddress.startsWith('mailto:')
      ? calendarAddress
      : `mailto:${calendarAddress.trim()}`,
    address,
    name,
    roles: { attendee: true },
    participationStatus: 'needs-action',
    isOrganizer: false,
    rest: {},
  }
}

/** The addresses this account may act as, from `ParticipantIdentity/get`. */
export function ownAddresses(identities: readonly ParticipantIdentity[]): string[] {
  const seen = new Set<string>()
  for (const identity of identities) {
    const address = normaliseAddress(identity.calendarAddress)
    if (address !== '') seen.add(address)
  }
  return [...seen]
}

/**
 * The row that is *me*, or `null`.
 *
 * This is the entire reason K-10 is a prerequisite for RSVP: without knowing the account's own
 * calendar addresses there is no way to tell which of five participants the answer bar belongs to,
 * and guessing from the login name is wrong for every account with an alias.
 *
 * The session's calendar capability was expected to carry a `calendarAddress` and would have been
 * the cheap way to the same answer — measured on v0.16.18, it does not: the account capability holds
 * only the limits (`maxParticipantsPerEvent`, `maxExpandedQueryDuration`, …). `ParticipantIdentity`
 * is the only source, which is what makes the extra round trip worth taking.
 */
export function findSelf(
  rows: readonly ParticipantRow[],
  addresses: readonly string[],
): ParticipantRow | null {
  const mine = new Set(addresses.map(normaliseAddress).filter((entry) => entry !== ''))
  return rows.find((row) => row.address !== '' && mine.has(row.address)) ?? null
}

/**
 * The one-field patch that answers an invitation.
 *
 * A pointer, not a map: see the file header. Exported separately from the client so the shape can be
 * asserted in a unit test without a transport — the failure this guards against (writing the whole
 * `participants` map to change one word) is invisible in any test that only checks the result.
 */
export function rsvpPatch(key: string, status: ParticipationStatus): Record<string, unknown> {
  return { [`participants/${key}/participationStatus`]: status }
}

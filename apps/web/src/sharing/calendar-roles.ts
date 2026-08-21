/**
 * What the roles mean for a calendar (S-2) — and the one type in this client that needs **four**.
 *
 * The eight keys below are the eight Stalwart v0.16.18 was measured to accept inside
 * `Calendar/set … shareWith` (`docs/jmap-gap-2026-08-21/berichte/D-sharing-pim.md` §1.2), and they
 * are the draft's set as well — the two agree here, which they do not for a mail folder. A key this
 * server does not know is refused **per object** with `invalidProperties: 'Invalid permission "…"'`,
 * so the list being right is what keeps a grant from failing; it is written out in full rather than
 * spread from a partial so that adding one is a visible edit.
 *
 * ## Why "availability only" is a role and not a checkbox
 *
 * `mayReadFreeBusy` on its own says: *they may see that I am busy, never what I am doing.* That is
 * not a weaker "View" — a viewer reads every title — it is a different promise, and it is the one
 * people actually want to give a whole department. iCloud and Google both name it; leaving it out
 * would mean the only way to let a colleague schedule around you is to let them read your diary.
 *
 * It is the FIRST entry in {@link SPEC.order}, so it is the picker's default: the least a share can
 * grant is the right thing to have preselected when someone is about to click Add.
 *
 * **`Principal/getAvailability` does not need it** (S-6) — measured, free/busy is answerable across
 * accounts with no share at all. This role is for the calendar being *in the grantee's own client*
 * as a greyed-out layer, which is a different thing from a client asking a question about a person.
 *
 * ## Where the other seven land
 *
 * - **View** adds `mayReadItems`: the titles, times and details of the events.
 * - **Edit** adds the four writing rights. `mayWriteAll` and `mayWriteOwn` go together on purpose —
 *   "own" alone would be a grant whose meaning ("events where the grantee is the organiser") no
 *   short label carries honestly, and a role list is only useful while every entry can be said in a
 *   sentence. `mayUpdatePrivate` (alerts and colour on someone else's event) and `mayRSVP` (answer
 *   an invitation) are what make a shared calendar usable rather than merely writable.
 * - **Manage** adds `mayShare` — the right that hands out rights, with no notification to the owner
 *   when it is used — and `mayDelete`.
 *
 * `mayDelete` in Manage is the **conservative** placement, and it is a placement rather than a
 * measurement: whether it destroys the calendar or only its events is listed as open in the gap
 * analysis, and a client that guessed "container" and was wrong would have put "delete every event
 * in here" inside a role called Edit. Measuring it is one `Calendar/set destroy` against a shared
 * calendar; until then it sits with the other irreversible right.
 */

import type { CalendarRights, Id } from '@waxwing/jmap'
import { makeRoleModel, type RoleSpec, type ShareRole } from './roles'

/** The all-false grant. Its keys are the eight the server accepts — see the module note. */
const NONE: CalendarRights = {
  mayReadFreeBusy: false,
  mayReadItems: false,
  mayWriteAll: false,
  mayWriteOwn: false,
  mayUpdatePrivate: false,
  mayRSVP: false,
  mayShare: false,
  mayDelete: false,
}

/** The four a calendar offers, least to most. `freeBusy` first: it is the safest thing to give. */
export const CALENDAR_SHARE_ROLES = [
  'freeBusy',
  'viewer',
  'editor',
  'manager',
] as const satisfies readonly ShareRole[]

/** The roles a calendar offers, as a type. */
export type CalendarShareRole = (typeof CALENDAR_SHARE_ROLES)[number]

const SPEC: RoleSpec<CalendarRights, CalendarShareRole> = {
  none: NONE,
  order: CALENDAR_SHARE_ROLES,
  roles: {
    /**
     * Availability only — `mayReadFreeBusy` and NOTHING else.
     *
     * The seven `false`s are the whole point of the role and the reason it is written out rather
     * than spread: any one of them turning true would leak the contents of the diary, which is
     * exactly what this grant promises not to do.
     */
    freeBusy: { ...NONE, mayReadFreeBusy: true },
    /** Read the events. Free/busy comes with it — you cannot read a diary without seeing it is full. */
    viewer: { ...NONE, mayReadFreeBusy: true, mayReadItems: true },
    /** Work the calendar: create, change, answer invitations, set your own alerts on it. */
    editor: {
      ...NONE,
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
    },
    /** Everything Edit grants, plus the calendar itself — and the right to hand it on. */
    manager: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
  },
}

export const calendarRoles = makeRoleModel(SPEC)

/** The eight permission keys this server accepts, for anything that checks its own literal. */
export const CALENDAR_RIGHT_KEYS = Object.keys(NONE) as readonly (keyof CalendarRights)[]

/**
 * Whether this calendar can be shared at all.
 *
 * `myRights.mayShare` is the server's answer for the CURRENT user. A calendar someone shared WITH
 * the user comes back with `mayShare: false` (measured: the grantee's `myRights` mirrors the grant),
 * and `shareWith` itself is `null` for them — only the owner ever sees it. So an affordance drawn
 * without this check would open a dialog listing nobody, over a calendar the user cannot share.
 *
 * `myRights` is optional on the type and `=== true` is what reads an absent value as "no".
 */
export function mayShareCalendar(rights: Partial<CalendarRights> | null | undefined): boolean {
  return rights?.mayShare === true
}

/** A grant map as the wire wants it: every principal carrying all eight keys. */
export type CalendarShareWith = Record<Id, CalendarRights>

// Types for the JS fixture control, so a TypeScript spec can name the container and reach the few
// helpers it is allowed to use — rather than duplicating a port or re-implementing a grant.
//
// Deliberately PARTIAL: `up`, `down` and `provision` are the setup/teardown files' business and are
// NOT declared here, so a spec cannot accidentally take the fixture down mid-run.

export const HOST_PORT: number
/** The container as the TEST PROCESS reaches it, which is not the origin the browser uses. */
export const BASE_URL: string
export const DOMAIN: string
export const PASSWORD: string

/** One test account, as `ACCOUNTS` lists them. */
export interface FixtureAccount {
  readonly name: string
  readonly login: string
  readonly password: string
  readonly description: string
}

export const ACCOUNTS: readonly FixtureAccount[]

/** How much a share grants. `ro` withholds `maySetSeen`; neither grants `mayShare` or `maySubmit`. */
export type ShareAccess = 'ro' | 'rw'

/**
 * Grant (or re-grant) one owner's inbox to one grantee.
 *
 * Re-granting with a DIFFERENT access is what mints a fresh `ShareNotification`: `shareWith` is a
 * full replacement, so re-writing the same rights is a no-op the server does not report.
 */
export function shareInbox(
  owner: string,
  grantee: string,
  access: ShareAccess,
): Promise<{ ownerAccountId: string; inboxId: string; granteePrincipal: string }>

/** Destroy every outstanding `ShareNotification` on one account. Returns how many. */
export function clearShareNotifications(name: string): Promise<number>

/** Unshare every mailbox of every test account — the sweep a UI-granted share needs. */
export function revokeAllShares(): Promise<void>

/**
 * Create (or reuse) a folder in `owner`'s file storage and share it read-only with `grantee` (S-4).
 *
 * Its own grant, not a variant of {@link shareInbox}: measured on v0.16.18, a mail share does not
 * make `FileNode/get` answer and a file share does not make `Mailbox/get` answer — which is the
 * fact the S-4 suite exists to assert.
 */
export function shareFileFolder(
  owner: string,
  grantee: string,
  name: string,
): Promise<{ ownerAccountId: string; nodeId: string | undefined; granteePrincipal: string }>

/**
 * Destroy every file node of every test account.
 *
 * DESTROYS rather than unshares: revoking the last file share leaves the account answering an empty
 * list rather than `forbidden` for a while (measured), which would keep a "Shared with me" section
 * on screen into the next suite.
 */
export function clearFileNodes(): Promise<void>

/**
 * Re-establish the fixed delegation set (`DELEGATIONS`) — the two grants `shared.setup.mjs` makes.
 *
 * Declared here, unlike `up`/`down`/`provision`, because a spec legitimately needs it: the shared
 * suite's own cleanups are broader than the state they are cleaning. `revokeAllShares()` sweeps
 * every account including these two, and the S-1 tests mint their notification by re-granting `rw`,
 * which only counts as a change if the grant is back at `ro` first. Both are a restore, not a new
 * fixture: idempotent, and exactly the pairs the setup wrote.
 */
export function ensureDelegations(): Promise<
  ReadonlyArray<{
    owner: string
    grantee: string
    access: ShareAccess
    ownerAccountId: string
    inboxId: string
  }>
>

/** How much a calendar share grants (S-2). `freeBusy` is `mayReadFreeBusy` and nothing else. */
export type CalendarShareRole = 'freeBusy' | 'viewer'

/**
 * Share one owner's DEFAULT calendar with one grantee.
 *
 * Its own grant, not a variant of {@link shareInbox}: measured on v0.16.18, a mail delegation does
 * not make `Calendar/get` answer for the grantee and this one does not make `Mailbox/get` answer.
 */
export function shareCalendar(
  owner: string,
  grantee: string,
  role?: CalendarShareRole,
): Promise<{ ownerAccountId: string; calendarId: string; granteePrincipal: string }>

/** How much an address-book share grants (S-2). */
export type AddressBookShareRole = 'viewer' | 'editor'

/** Share one owner's DEFAULT address book with one grantee. Same reasoning as {@link shareCalendar}. */
export function shareAddressBook(
  owner: string,
  grantee: string,
  role?: AddressBookShareRole,
): Promise<{ ownerAccountId: string; bookId: string; granteePrincipal: string }>

/**
 * Put one timed event in an owner's default calendar (S-6).
 *
 * `start` is a LOCAL JSCalendar date-time (`2026-08-25T10:00:00`) in `Europe/Berlin`; an offset is
 * refused. Without an event `Principal/getAvailability` answers an empty list, which on screen is
 * indistinguishable from the method not working at all.
 */
export function addBusyEvent(
  owner: string,
  event: { start: string; duration?: string; title?: string },
): Promise<{ ownerAccountId: string; calendarId: string; eventId: string | undefined }>

/** Destroy every calendar event of every test account. */
export function clearCalendarEvents(): Promise<void>

/**
 * Unshare every calendar and address book of every test account (S-2).
 *
 * The companion to {@link revokeAllShares}, which sweeps mailboxes only — and just as necessary: one
 * shared calendar puts the owner's whole account into the grantee's session with every capability.
 */
export function revokeAllPimShares(): Promise<void>

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

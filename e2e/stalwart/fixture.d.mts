// Types for the JS fixture control so the TypeScript specs can import it under Bundler resolution.
//
// Deliberately PARTIAL: only what a spec is allowed to reach for. `up`, `down` and `provision` are
// the setup/teardown files' business and are not declared here, so a test cannot accidentally take
// the fixture down mid-run.

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

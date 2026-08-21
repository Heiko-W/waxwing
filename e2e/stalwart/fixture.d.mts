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

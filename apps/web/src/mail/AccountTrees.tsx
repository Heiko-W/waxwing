/**
 * The account-grouped folder rail (M4.4 Etappe 3) — the mail sidebar's top section.
 *
 * PASS-THROUGH: with no delegated/shared account this renders EXACTLY today's single {@link FolderTree}
 * — no header, no grouping, no extra landmark — so the single-account sidebar is byte-for-byte the
 * pre-M4.4 one and the FolderTree tests stand unchanged.
 *
 * GROUPED: with ≥1 shared account it lists the user's OWN tree first, then one labelled section per
 * shared account — every account a sibling, the way Apple Mail shows them. Each section is a named
 * `region` (`aria-label` = the account name) and wraps its {@link FolderTree} in that account's OWN
 * `ReplicaProvider`, so the tree's live mailboxes and its `myRights`-gated actions resolve against the
 * right account (`useReplica().accountId`). Picking a mailbox switches the active account — which the
 * list/reading panes follow — and navigates; the switch resets the per-account list/reading stores
 * first, or a colliding `windowKey` would keep the previous account's selection (see
 * {@link resetMailScopedStores}).
 */

import type { Id, MailAccount } from '@waxwing/jmap'
import { Lock } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { mailPath, useNavigate, useRoute } from '../app/route'
import { IncomingShares } from '../sharing/IncomingShares'
import type { ShareAnnouncement } from '../sharing/incoming'
import { useIncomingShares } from '../sharing/use-incoming-shares'
import { type ReplicaDb, ReplicaProvider, useReplica, useReplicaQuery } from '../sync'
import { Badge } from '../ui'
import { resetMailScopedStores, useActiveAccountId, useActiveAccountStore } from './active-account'
import { FolderTree } from './FolderTree'
import { folderDisplayName } from './folder-tree'
import styles from './folder-tree.module.css'
import { SavedSearchList } from './search/SavedSearchList'

export interface AccountTreesProps {
  /**
   * Every account with MAIL in it — the user's OWN first, then the shared tail (M4.4).
   *
   * Already narrowed by the S-4 probe when it comes from `connected.accounts`: a shared account the
   * server refuses `Mailbox/get` on is not in this list, so the rail renders what it is given and
   * asks nothing itself (see `sharing/probe.ts` and `app/session/accounts.ts`).
   */
  readonly accounts: readonly MailAccount[]
  /** The user's own account id: the primary the pass-through sidebar renders alone. */
  readonly primaryAccountId: Id
  /** Fired on every folder pick, including a re-pick of the open one — see FolderTreeProps. */
  readonly onNavigate?: (() => void) | undefined
}

export function AccountTrees({ accounts, primaryAccountId, onNavigate }: AccountTreesProps) {
  const { db } = useReplica()
  const navigate = useNavigate()
  const route = useRoute()
  const stored = useActiveAccountId()
  const activeAccountId = stored ?? primaryAccountId
  const incoming = useIncomingShares('Mailbox')
  const sharedNames = useSharedFolderNames(incoming.announcements)

  const selectMailbox = useCallback(
    (accountId: Id, mailboxId: string) => {
      if (accountId !== activeAccountId) {
        // Correctness-critical: clear the previous account's list window + selection + open message
        // BEFORE the panes re-scope. The per-account short mailbox ids collide, so a byte-identical
        // `windowKey` would otherwise be read as "same window" and keep the stale selection (M4.4).
        resetMailScopedStores()
        useActiveAccountStore.getState().setActiveAccount(accountId)
      }
      // Qualify the route with the account (B37): mailbox ids are per-account and short, so a bare
      // `/mail/a` reloaded or followed from a notification resolves against the user's OWN account,
      // where `a` is very likely a real but different mailbox.
      //
      // EVERY link in this grouped rail names its account, the primary's included — an explicit id
      // is what lets a switch BACK clear the parameter, because the router carries an existing
      // `?account=` forward and cannot tell "no opinion" from "the user's own". This code path only
      // exists when something is shared; the single-account sidebar is the pass-through below and
      // its links are untouched.
      // Same folder, same account, nothing to do but tell the drawer. Navigating anyway pushed a
      // duplicate history entry, which made the back gesture look broken.
      if (accountId === activeAccountId && mailboxId === route.params.mailboxId) {
        onNavigate?.()
        return
      }
      navigate(mailPath(mailboxId, undefined, accountId))
      onNavigate?.()
    },
    [activeAccountId, navigate, route.params.mailboxId, onNavigate],
  )

  const openShare = useCallback(
    (announcement: ShareAnnouncement) => {
      // Both halves of the address, because a mailbox id alone is ambiguous: they are per-account
      // and short, and `a` exists in nearly every account. Same rule as `selectMailbox` above.
      selectMailbox(announcement.accountId, announcement.objectId)
      // Read, and therefore done with. Leaving it up after the user has followed it would turn the
      // strip into a list of things they have already dealt with.
      incoming.dismiss(announcement.id)
    },
    [selectMailbox, incoming],
  )

  /*
   * The strip sits ABOVE the trees and outside the pass-through check, so a first-ever share is
   * announced even while the rail is still a single ungrouped tree — which is precisely the moment
   * it matters: the section it is telling the user about has not appeared yet. It renders nothing
   * when there is nothing, so the single-account sidebar stays byte-for-byte what it was.
   */
  const strip = (
    <IncomingShares
      announcements={incoming.announcements}
      nameOf={(announcement) =>
        sharedNames[`${announcement.accountId}/${announcement.objectId}`] ?? null
      }
      onOpen={openShare}
      onDismiss={incoming.dismiss}
    />
  )

  const shared = accounts.filter((account) => account.id !== primaryAccountId)

  // Pass-through: nothing shared ⇒ exactly today's single tree under the ambient (primary) provider.
  if (shared.length === 0) {
    return (
      <>
        {strip}
        <FolderTree onNavigate={onNavigate} />
        {/* Saved searches belong to the account whose mail is on screen, so they hang off the
            primary tree rather than the shell (M5.5, FR-SRCH-03). */}
        <SavedSearchList />
      </>
    )
  }

  const primary = accounts.find((account) => account.id === primaryAccountId)
  return (
    <>
      {strip}
      <AccountSection
        name={primary?.name ?? primaryAccountId}
        accountId={primaryAccountId}
        db={db}
        active={activeAccountId === primaryAccountId}
        isReadOnly={primary?.isReadOnly ?? false}
        onSelectMailbox={(mailboxId) => selectMailbox(primaryAccountId, mailboxId)}
      />
      {shared.map((account) => (
        <AccountSection
          key={account.id}
          name={account.name}
          accountId={account.id}
          db={db}
          shared
          active={activeAccountId === account.id}
          isReadOnly={account.isReadOnly}
          onSelectMailbox={(mailboxId) => selectMailbox(account.id, mailboxId)}
        />
      ))}
    </>
  )
}

/**
 * The NAMES of the folders the cards are about, keyed `accountId/mailboxId`.
 *
 * The server does not send one. `ShareNotification.name` is the empty string on v0.16.18 — measured,
 * for mailboxes and calendars alike — so "Carol shared the folder ‘Projekt’" has to get "Projekt"
 * from somewhere else, and the replica is where it already is: the fleet runs an engine per shared
 * account and mirrors its mailboxes into the same database, keyed by `[accountId, id]`.
 *
 * It is legitimately ABSENT for a brand-new share: the card can arrive before that account's first
 * sync has run, and the strip has a wording that needs no name for exactly that window. Nothing here
 * waits for it — a card the user cannot read yet would be worse than one that says "a mail folder".
 */
function useSharedFolderNames(announcements: readonly ShareAnnouncement[]): Record<string, string> {
  const { t } = useTranslation()
  const key = announcements.map((entry) => `${entry.accountId}/${entry.objectId}`).join(',')
  const names = useReplicaQuery(
    async ({ db }) => {
      const found: Record<string, string> = {}
      for (const pair of key === '' ? [] : key.split(',')) {
        const [accountId, mailboxId] = pair.split('/')
        if (accountId === undefined || mailboxId === undefined) continue
        const row = await db.mailboxes.get([accountId, mailboxId])
        // `folderDisplayName`, not `row.name`: a role folder is called "Inbox" here and
        // "INBOX" on the wire, and the card must read like the rail below it.
        if (row !== undefined) found[pair] = folderDisplayName(row, t)
      }
      return found
    },
    [key],
  )
  return names ?? {}
}

interface AccountSectionProps {
  readonly name: string
  readonly accountId: Id
  readonly db: ReplicaDb
  /** Whether this account owns the current route selection (only the active account highlights). */
  readonly active: boolean
  readonly isReadOnly: boolean
  /** Delegated/shared (not the user's own) — carries the "Shared" marker. */
  readonly shared?: boolean
  readonly onSelectMailbox: (mailboxId: string) => void
}

function AccountSection({
  name,
  accountId,
  db,
  active,
  isReadOnly,
  shared = false,
  onSelectMailbox,
}: AccountSectionProps) {
  const { t } = useTranslation()
  return (
    <section className={styles.accountSection} aria-label={name}>
      <div className={styles.accountHeader}>
        <span className={styles.accountName}>{name}</span>
        {shared && <Badge tone="neutral">{t('shell.accounts.shared')}</Badge>}
        {isReadOnly && (
          <span className={styles.accountReadOnly}>
            <Lock aria-hidden="true" className={styles.accountReadOnlyIcon} />
            <span>{t('shell.accounts.readOnly')}</span>
          </span>
        )}
      </div>
      <ReplicaProvider accountId={accountId} db={db}>
        <FolderTree onSelectMailbox={onSelectMailbox} active={active} />
      </ReplicaProvider>
    </section>
  )
}

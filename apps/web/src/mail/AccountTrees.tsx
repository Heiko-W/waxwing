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
import { mailPath, useNavigate } from '../app/route'
import { type ReplicaDb, ReplicaProvider, useReplica } from '../sync'
import { Badge } from '../ui'
import { resetMailScopedStores, useActiveAccountId, useActiveAccountStore } from './active-account'
import { FolderTree } from './FolderTree'
import styles from './folder-tree.module.css'

export interface AccountTreesProps {
  /** Every mail account the session grants — the user's OWN first, then the shared tail (M4.4). */
  readonly accounts: readonly MailAccount[]
  /** The user's own account id: the primary the pass-through sidebar renders alone. */
  readonly primaryAccountId: Id
}

export function AccountTrees({ accounts, primaryAccountId }: AccountTreesProps) {
  const { db } = useReplica()
  const navigate = useNavigate()
  const stored = useActiveAccountId()
  const activeAccountId = stored ?? primaryAccountId

  const selectMailbox = useCallback(
    (accountId: Id, mailboxId: string) => {
      if (accountId !== activeAccountId) {
        // Correctness-critical: clear the previous account's list window + selection + open message
        // BEFORE the panes re-scope. The per-account short mailbox ids collide, so a byte-identical
        // `windowKey` would otherwise be read as "same window" and keep the stale selection (M4.4).
        resetMailScopedStores()
        useActiveAccountStore.getState().setActiveAccount(accountId)
      }
      navigate(mailPath(mailboxId))
    },
    [activeAccountId, navigate],
  )

  const shared = accounts.filter((account) => account.id !== primaryAccountId)

  // Pass-through: nothing shared ⇒ exactly today's single tree under the ambient (primary) provider.
  if (shared.length === 0) {
    return <FolderTree />
  }

  const primary = accounts.find((account) => account.id === primaryAccountId)
  return (
    <>
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

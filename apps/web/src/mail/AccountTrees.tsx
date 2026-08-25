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
import { ChevronRight, Lock } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { mailPath, useNavigate, useRoute } from '../app/route'
import type { ShareAnnouncement } from '../sharing/incoming'
import {
  type ReplicaDb,
  ReplicaProvider,
  setPref,
  useLocalPref,
  useMailboxByRole,
  useReplica,
  useReplicaQuery,
} from '../sync'
import { Badge, VisuallyHidden } from '../ui'
import { resetMailScopedStores, useActiveAccountId, useActiveAccountStore } from './active-account'
import { FolderTree } from './FolderTree'
import { folderDisplayName } from './folder-tree'
import styles from './folder-tree.module.css'
import { SavedSearchList } from './search/SavedSearchList'

/**
 * Which account sections the reader has folded away, on THIS device.
 *
 * Local, like `folders.collapsed` next door and for the same reason: it is a view state, not
 * something the server has an opinion about. Stored against the PRIMARY account — the rail belongs
 * to the signed-in user, not to whichever delegated account a row happens to be in — so one entry
 * describes the whole rail and a revoked share simply stops being read.
 */
const COLLAPSED_ACCOUNTS_PREF = 'accounts.collapsed'

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

/**
 * Open a folder, switching account first where the two differ.
 *
 * Extracted from the rail so the share-notice strip can use the same path (B61). It had to move
 * anyway: the strip now renders AFTER the trees and the labels rather than above them, which put
 * it outside the component that owned this callback. One copy, because the account switch below is
 * correctness-critical and a second one would drift silently — the failure is a stale selection,
 * which looks like nothing at all until the wrong message opens.
 */
export function useSelectMailbox(
  /**
   * The account whose mail is on screen, ALREADY resolved against the primary.
   *
   * Passed in rather than read here, and that is not a style choice: `useActiveAccountId()` is
   * `null` until something has been switched to, so a hook that read it alone would compare the
   * primary against `null`, decide the accounts differ, and reset the list window and the open
   * message on a click within the account the reader was already in. That is what the extraction
   * broke first, and the test that caught it — "does not reset when selecting within the
   * already-active account" — is exactly the one written for that failure the first time.
   */
  activeAccountId: Id,
  onNavigate?: () => void,
): (accountId: Id, mailboxId: string) => void {
  const navigate = useNavigate()
  const route = useRoute()
  return useCallback(
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
}

export function AccountTrees({ accounts, primaryAccountId, onNavigate }: AccountTreesProps) {
  const { db } = useReplica()
  const stored = useActiveAccountId()
  const activeAccountId = stored ?? primaryAccountId
  const collapsedList = useLocalPref<string[]>(COLLAPSED_ACCOUNTS_PREF)
  const collapsed = useMemo(() => new Set(collapsedList ?? []), [collapsedList])

  const toggleAccount = useCallback(
    (accountId: Id) => {
      const next = new Set(collapsed)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      // `db` + the PRIMARY id, not `useReplica()` inside the section: each section runs under its
      // own account's provider, and a preference written there would be one collapse list per
      // account — half of them in a delegated account's replica, which a revoked share takes away.
      void setPref(db, primaryAccountId, COLLAPSED_ACCOUNTS_PREF, [...next])
    },
    [collapsed, db, primaryAccountId],
  )

  const selectMailbox = useSelectMailbox(activeAccountId, onNavigate)

  const shared = accounts.filter((account) => account.id !== primaryAccountId)

  // Pass-through: nothing shared ⇒ exactly today's single tree under the ambient (primary) provider.
  if (shared.length === 0) {
    return (
      <>
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
      <AccountSection
        name={primary?.name ?? primaryAccountId}
        accountId={primaryAccountId}
        db={db}
        active={activeAccountId === primaryAccountId}
        isReadOnly={primary?.isReadOnly ?? false}
        expanded={!collapsed.has(primaryAccountId)}
        onToggle={() => toggleAccount(primaryAccountId)}
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
          expanded={!collapsed.has(account.id)}
          onToggle={() => toggleAccount(account.id)}
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
export function useSharedFolderNames(
  announcements: readonly ShareAnnouncement[],
): Record<string, string> {
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
  /** Folded open. Collapsed, the section is its header alone — see {@link COLLAPSED_ACCOUNTS_PREF}. */
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onSelectMailbox: (mailboxId: string) => void
}

/**
 * One account's block of the rail: a header that folds it away, and its tree.
 *
 * The `ReplicaProvider` now wraps the WHOLE section rather than just the tree, so the header can ask
 * this account's replica what it is holding — which is what {@link AccountUnread} needs to keep a
 * folded-away account from hiding new mail. Everything below it resolves against the same account
 * it did before; the provider simply starts one element higher.
 */
function AccountSection({
  name,
  accountId,
  db,
  active,
  isReadOnly,
  shared = false,
  expanded,
  onToggle,
  onSelectMailbox,
}: AccountSectionProps) {
  const { t } = useTranslation()
  return (
    <ReplicaProvider accountId={accountId} db={db}>
      <section className={styles.accountSection} aria-label={name} data-active={active}>
        {/*
         * ONE header per account, and it is the tree's own — see `renderChrome` in FolderTree.
         * There used to be two: the account name, and then a "FOLDERS" caption under it carrying
         * the new-folder button. The second said nothing the first had not, and three accounts
         * paid for it three times.
         */}
        <FolderTree
          collapsed={!expanded}
          onSelectMailbox={onSelectMailbox}
          active={active}
          renderChrome={(actions) => (
            <div className={styles.accountHeader}>
              {/*
               * The whole name is the control, not a chevron beside it. A 16px glyph is the
               * smallest target in the rail and the least obvious one; a header row that folds
               * when clicked is what every mail client's account list does, and it gives the
               * gesture a 24px+ box without adding a second thing to aim at.
               */}
              <button
                type="button"
                className={styles.accountToggle}
                aria-expanded={expanded}
                // An address is user data of unbounded length and the row also holds a badge and a
                // button, so the name ellipsises sooner here than it did — the tooltip is what
                // keeps the full address one hover away. The accessible name is unaffected either
                // way: it comes from the span's text, which is complete in the DOM.
                title={name}
                onClick={onToggle}
              >
                <ChevronRight aria-hidden="true" className={styles.accountChevron} />
                <span className={styles.accountName}>{name}</span>
              </button>
              {!expanded && <AccountUnread />}
              {shared && <Badge tone="neutral">{t('shell.accounts.shared')}</Badge>}
              {isReadOnly && (
                <span className={styles.accountReadOnly}>
                  <Lock aria-hidden="true" className={styles.accountReadOnlyIcon} />
                  <span>{t('shell.accounts.readOnly')}</span>
                </span>
              )}
              {/* Folded, the actions go with the folders they act on: a "New folder" button over a
                  section with no visible folders points at nothing the reader can see. */}
              {expanded && actions}
            </div>
          )}
        />
      </section>
    </ReplicaProvider>
  )
}

/**
 * The unread count of a FOLDED account, shown on its header.
 *
 * Without it, folding an account away hides the one thing about it that is time-sensitive, and the
 * reader has no way to know they should unfold it. The number is the INBOX's, and deliberately not
 * a sum over the account's folders — the same choice `use-app-badge.ts` makes and for the same
 * reason: summing would count Junk and Archive, and one number on one header has to mean one thing.
 *
 * Only while folded. Expanded, the Inbox row below shows the same number, and two copies of it four
 * rows apart read as two different counts.
 */
function AccountUnread() {
  const { t } = useTranslation()
  const inbox = useMailboxByRole('inbox')
  const unread = inbox?.unreadEmails ?? 0
  if (unread === 0) return null
  return (
    <span className={styles.accountUnread}>
      {/* Decorative, announced once through the hidden text — the same split as the folder rows. */}
      <span aria-hidden="true">
        <Badge tone="neutral">{unread}</Badge>
      </span>
      <VisuallyHidden>{t('mailbox.unread', { count: unread })}</VisuallyHidden>
    </span>
  )
}

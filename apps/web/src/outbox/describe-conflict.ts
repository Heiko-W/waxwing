/**
 * Conflict → UI mapping (M3.3, FR-OFF-03 "gentle, actionable notices"). A pure function over the
 * persisted row: the replica stores a stable {@link ConflictCode}, never prose, so this is where a
 * code (plus the intent it failed on) becomes a translation key and the ONE action worth offering.
 *
 * The pairing matters: `folderGone` on a `move` is not "that folder is gone, retry" — the undo has
 * already put the message back where it was, so the only sensible offer is "Keep it in <folder>"
 * (i.e. dismiss). Retrying a move into a deleted folder could only fail again.
 */

import type { Id } from '@waxwing/jmap'
import type { ConflictCode, OutboxRow } from '../sync'
import type { OutboxIntent } from '../sync/engine'

/** `none` = the row is owned by another surface (the send notifier reopens the draft). */
export type ConflictAction = 'retry' | 'keepHere' | 'dismiss' | 'none'

export interface ConflictDescription {
  /** i18n key for the human sentence ("Couldn't move — that folder was deleted."). */
  readonly titleKey: string
  /** Interpolation values for {@link titleKey} and for the action label. */
  readonly params: Readonly<Record<string, string>>
  readonly action: ConflictAction
}

const RETRYABLE: ReadonlySet<ConflictCode> = new Set<ConflictCode>([
  'folderNotEmpty',
  'forbidden',
  'quota',
  'tooLarge',
  'invalid',
  'stateConflict',
  'serverRejected',
])

const TITLE_KEY: Readonly<Record<ConflictCode, string>> = {
  messageGone: 'outbox.conflict.messageGone',
  folderGone: 'outbox.conflict.folderGone',
  folderNotEmpty: 'outbox.conflict.folderNotEmpty',
  contactGone: 'outbox.conflict.contactGone',
  forbidden: 'outbox.conflict.forbidden',
  quota: 'outbox.conflict.quota',
  tooLarge: 'outbox.conflict.tooLarge',
  invalid: 'outbox.conflict.invalid',
  stateConflict: 'outbox.conflict.stateConflict',
  serverRejected: 'outbox.conflict.serverRejected',
  sendRejected: 'compose.sendErrorGeneric',
  sendInterrupted: 'compose.sendErrorInterrupted',
}

/**
 * Describe a dead-lettered outbox row. `folderNames` (mailbox id → name) resolves the folder a
 * failed move was undone BACK to; without a name for it the "Keep in {{folder}}" offer degrades to
 * a plain dismiss rather than rendering an empty placeholder.
 */
export function describeConflict(
  row: OutboxRow,
  folderNames?: ReadonlyMap<Id, string>,
): ConflictDescription {
  const intent = row.payload as OutboxIntent
  const code: ConflictCode = row.conflict?.code ?? 'serverRejected'

  // A rejected/interrupted send is surfaced (and retried) by the composer's send-error notifier,
  // which reopens the draft. Re-queuing the non-idempotent submission here could double-send.
  if (intent.kind === 'sendEmail') {
    return { titleKey: TITLE_KEY[code], params: {}, action: 'none' }
  }

  if (code === 'folderGone' && intent.kind === 'move') {
    const folder = intent.from === null ? undefined : folderNames?.get(intent.from)
    return folder === undefined
      ? { titleKey: 'outbox.conflict.moveFolderGone', params: {}, action: 'dismiss' }
      : { titleKey: 'outbox.conflict.moveFolderGone', params: { folder }, action: 'keepHere' }
  }

  return {
    titleKey: TITLE_KEY[code],
    params: {},
    action: RETRYABLE.has(code) ? 'retry' : 'dismiss',
  }
}

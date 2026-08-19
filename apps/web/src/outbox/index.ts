/**
 * `outbox/` — the user-facing half of the offline action queue (M3.3, FR-OFF-03). The queue itself
 * lives in `sync/engine`; this module surfaces what it cannot resolve on its own: conflicts that
 * need a decision, and sends that have not left the device yet.
 */

export {
  type ConflictAction,
  type ConflictDescription,
  describeConflict,
} from './describe-conflict'
export { OutboxProblemsButton } from './OutboxProblemsButton'
export { QueuedSends } from './QueuedSends'
export { ScheduledSends } from './ScheduledSends'
export { useConflictNotifier } from './use-conflict-notifier'
export { type OutboxProblems, useOutboxProblems } from './use-outbox-problems'

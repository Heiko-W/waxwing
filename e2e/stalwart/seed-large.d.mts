// Types for the JS seeder so the TypeScript perf spec can import it under Bundler resolution —
// the same shape `seed-read.d.mts` and `seed-write.d.mts` provide for their seeders.
export const LARGE_KEYWORD: string
export const LARGE_MAILBOX_NAME: string
export function seedLargeMailbox(count?: number): Promise<{
  accountId: string
  mailboxId: string
  removed: number
  created: number
}>

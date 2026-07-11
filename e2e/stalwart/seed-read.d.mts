// Types for the JS seeder so the TypeScript read spec can import it under Bundler resolution.
export const READ_KEYWORD: string
export const READ_SUBJECTS: {
  readonly newsletter: string
  readonly plain: string
  readonly thread: string
}
export const READ_BODIES: {
  readonly plain: string
  readonly newsletterMarker: string
  readonly threadOldest: string
  readonly threadMiddle: string
  readonly threadNewest: string
}
export const READ_REMOTE_HOST: string
export function seedReadMail(): Promise<{
  accountId: string
  inboxId: string
  removed: number
  created: number
}>
export function deliverLiveMail(tag?: string): Promise<string>

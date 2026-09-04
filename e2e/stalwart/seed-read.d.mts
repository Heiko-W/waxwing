// Types for the JS seeder so the TypeScript read spec can import it under Bundler resolution.
export const READ_KEYWORD: string
export const READ_SUBJECTS: {
  readonly newsletter: string
  readonly plain: string
  readonly thread: string
  readonly phishing: string
  readonly rfc822: string
  readonly pdf: string
}
/** The over-one-window folder the select-all-in-folder tests need (FR-LST-04). */
export const READ_BULK: {
  readonly folder: string
  readonly count: number
  readonly keyword: string
  readonly subject: (n: number) => string
}
export const READ_PHISHING: {
  readonly forgedAuthserv: string
  readonly trustedAuthserv: string
  readonly displayName: string
  readonly realAddress: string
  readonly linkText: string
  readonly linkTarget: string
  readonly benignText: string
  readonly benignTarget: string
}
export const READ_NESTED: {
  readonly subject: string
  readonly body: string
  readonly from: string
  readonly filename: string
}
export const READ_BODIES: {
  readonly plain: string
  readonly newsletterMarker: string
  readonly threadOldest: string
  readonly threadMiddle: string
  readonly threadNewest: string
}
export const READ_PDF: {
  readonly filename: string
  readonly text: string
}
export const READ_REMOTE_HOST: string
export function seedReadMail(): Promise<{
  accountId: string
  inboxId: string
  removed: number
  created: number
}>
export function deliverLiveMail(tag?: string): Promise<string>

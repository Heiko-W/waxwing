// Types for the JS write-suite helpers so the TypeScript write spec can import them (Bundler resolution).

export const WRITE_PREFIX: string
export const WRITE_TOKEN: string
export const ACCOUNTS: { readonly alice: string; readonly bob: string }

export interface JmapEmail {
  readonly id?: string
  readonly subject?: string
  readonly mailboxIds?: Record<string, boolean>
  readonly keywords?: Record<string, boolean>
  readonly from?: { name: string | null; email: string }[] | null
  readonly inReplyTo?: string[] | null
  readonly references?: string[] | null
  readonly attachments?:
    | { name: string | null; type: string; size: number; blobId: string }[]
    | null
  readonly [key: string]: unknown
}

export interface JmapClient {
  readonly login: string
  session(): Promise<Record<string, unknown>>
  account(): Promise<string>
  call(
    using: string[],
    methodCalls: unknown[],
  ): Promise<{ methodResponses: [string, Record<string, unknown>, string][] }>
  mailboxes(): Promise<{ id: string; role: string | null; name: string }[]>
  query(token: string, properties?: string[]): Promise<JmapEmail[]>
}

export function jmapAs(login: string): JmapClient
export function mailboxRoles(client: JmapClient): Promise<Map<string, string>>
export function pollMail(
  client: JmapClient,
  token: string,
  properties?: string[],
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<JmapEmail[]>
export function expectNoMail(
  client: JmapClient,
  token: string,
  windowMs?: number,
): Promise<JmapEmail[]>
export function emailById(
  client: JmapClient,
  id: string,
  properties?: string[],
): Promise<JmapEmail | null>
export function pollEmail(
  client: JmapClient,
  id: string,
  predicate: (email: JmapEmail) => boolean,
  properties?: string[],
  opts?: { timeoutMs?: number },
): Promise<JmapEmail | null>
export function resetWriteMail(): Promise<number>
export function seedReplySource(): Promise<{
  emailId: string
  messageId: string
  subject: string
  token: string
}>

/**
 * Settings → Server: what this JMAP server actually offers (M3.7, FR-SRV-04). Pure — it turns a
 * Session into rows, and the component turns rows into text.
 *
 * **The one thing that is easy to get wrong, and would be invisible:** a capability object exists at
 * TWO levels. `session.capabilities[urn]` is what the SERVER implements; `account.accountCapabilities[urn]`
 * is what may be invoked on THAT account — and a server may fill in only one of them. Stalwart
 * advertises `urn:ietf:params:jmap:mail` at both levels but leaves the session-level object **empty**
 * (`{}`), keeping every real limit in the account object. A panel built on `session.capabilities`
 * alone therefore renders an empty mail table against the very server we develop and test against,
 * while passing every hermetic test written with a hand-made session. Presence is asked of both
 * levels ({@link hasCapability}); limits are read from the level that has them ({@link getMailCapability}).
 *
 * Values carry a `kind` tag and stay RAW — no formatting, no locale — so the tests assert numbers
 * rather than strings and the component owns `formatBytes`/`formatNumber`.
 */

import type { Id } from '@waxwing/jmap'
import { Capabilities, getCoreCapability, getMailCapability, hasCapability } from '@waxwing/jmap'
import type { JmapSession } from '../app/session/types'

export type LimitValue =
  | { readonly kind: 'bytes'; readonly value: number }
  | { readonly kind: 'count'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'list'; readonly value: readonly string[] }
  /** The RFC's explicit `null`: the server imposes no limit here. */
  | { readonly kind: 'unlimited' }

export interface LimitRow {
  /** i18n suffix under `settings.server.limit.*`. */
  readonly key: string
  readonly value: LimitValue
}

export interface CapabilityRow {
  readonly urn: string
  /** i18n suffix under `settings.server.cap.*`. */
  readonly key: string
  readonly present: boolean
}

export interface CapabilitiesView {
  readonly apiOrigin: string
  readonly username: string
  readonly accountName: string
  readonly accountIsReadOnly: boolean
  /** `null` ⇒ no conformant core capability. Render a sentence, never an empty table. */
  readonly core: readonly LimitRow[] | null
  /** `null` ⇒ this ACCOUNT advertises no mail capability. */
  readonly mail: readonly LimitRow[] | null
  readonly known: readonly CapabilityRow[]
  /** URNs this server advertises that Waxwing does not know about — raw, sorted. Honest diagnostics. */
  readonly extra: readonly string[]
}

/** The optional features the panel reports on, in the order it reports them. */
const KNOWN: readonly { readonly key: string; readonly urn: string }[] = [
  { key: 'core', urn: Capabilities.core },
  { key: 'mail', urn: Capabilities.mail },
  { key: 'submission', urn: Capabilities.submission },
  { key: 'vacationResponse', urn: Capabilities.vacationResponse },
  { key: 'quota', urn: Capabilities.quota },
  { key: 'blob', urn: Capabilities.blob },
  { key: 'sieve', urn: Capabilities.sieve },
  { key: 'contacts', urn: Capabilities.contacts },
  { key: 'webSocket', urn: Capabilities.webSocket },
  { key: 'principals', urn: Capabilities.principals },
  { key: 'webPushVapid', urn: Capabilities.webPushVapid },
]

const count = (value: number): LimitValue => ({ kind: 'count', value })
const bytes = (value: number): LimitValue => ({ kind: 'bytes', value })
/** RFC nullable limits: `null` is not "missing", it is "no limit". */
const nullableCount = (value: number | null): LimitValue =>
  value === null ? { kind: 'unlimited' } : count(value)

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export function buildCapabilitiesView(session: JmapSession, accountId: Id): CapabilitiesView {
  const account = session.accounts[accountId]
  const core = getCoreCapability(session)
  const mail = getMailCapability(session, accountId)

  const coreRows: LimitRow[] | null =
    core === null
      ? null
      : [
          { key: 'maxSizeUpload', value: bytes(core.maxSizeUpload) },
          { key: 'maxSizeRequest', value: bytes(core.maxSizeRequest) },
          { key: 'maxConcurrentRequests', value: count(core.maxConcurrentRequests) },
          { key: 'maxConcurrentUpload', value: count(core.maxConcurrentUpload) },
          { key: 'maxCallsInRequest', value: count(core.maxCallsInRequest) },
          { key: 'maxObjectsInGet', value: count(core.maxObjectsInGet) },
          { key: 'maxObjectsInSet', value: count(core.maxObjectsInSet) },
          { key: 'collationAlgorithms', value: { kind: 'list', value: core.collationAlgorithms } },
        ]

  const mailRows: LimitRow[] | null =
    mail === null
      ? null
      : [
          { key: 'maxMailboxesPerEmail', value: nullableCount(mail.maxMailboxesPerEmail) },
          { key: 'maxMailboxDepth', value: nullableCount(mail.maxMailboxDepth) },
          { key: 'maxSizeMailboxName', value: count(mail.maxSizeMailboxName) },
          {
            key: 'maxSizeAttachmentsPerEmail',
            value: bytes(mail.maxSizeAttachmentsPerEmail),
          },
          {
            key: 'mayCreateTopLevelMailbox',
            value: { kind: 'bool', value: mail.mayCreateTopLevelMailbox },
          },
          {
            key: 'emailQuerySortOptions',
            value: { kind: 'list', value: mail.emailQuerySortOptions },
          },
        ]

  const known: CapabilityRow[] = KNOWN.map(({ key, urn }) => ({
    key,
    urn,
    present: hasCapability(session, urn, accountId),
  }))

  const knownUrns = new Set(KNOWN.map((entry) => entry.urn))
  const advertised = new Set([
    ...Object.keys(session.capabilities),
    ...Object.keys(account?.accountCapabilities ?? {}),
  ])
  const extra = [...advertised].filter((urn) => !knownUrns.has(urn)).sort()

  return {
    apiOrigin: originOf(session.apiUrl),
    username: session.username,
    accountName: account?.name ?? accountId,
    accountIsReadOnly: account?.isReadOnly ?? false,
    core: coreRows,
    mail: mailRows,
    known,
    extra,
  }
}

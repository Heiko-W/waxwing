/**
 * Quota (M3.7, FR-QTA-01, RFC 9425) — pure model. No React, no JMAP client, no formatting.
 *
 * A server may expose several quotas (bytes for mail, object counts for files, a domain-wide
 * allowance…). The chrome has room for exactly one, so {@link pickPrimaryQuota} chooses rather than
 * assuming there is only one — and returns `null` rather than inventing a bar for a server that
 * offers nothing meterable.
 */

import type { Quota, QuotaResourceType } from '@waxwing/jmap'

/** FR-QTA-01: warn at 90 %, whatever the server thinks. */
export const QUOTA_WARN_RATIO = 0.9

export type QuotaLevel = 'ok' | 'warn' | 'over'

export interface QuotaView {
  readonly id: string
  readonly name: string
  readonly resourceType: QuotaResourceType
  readonly used: number
  readonly limit: number
  /** `used / limit`, clamped to [0, 1] — a bar cannot be 130 % long, but the TEXT still says so. */
  readonly ratio: number
  readonly level: QuotaLevel
}

/**
 * Warn when EITHER the server's own `warnLimit` is reached OR usage crosses 90 %.
 *
 * The union is deliberate. A server is free to set `warnLimit` at 98 %, and FR-QTA-01 promises the
 * user a warning at 90 — so honouring only the server's threshold would break the promise, and
 * honouring only ours would ignore a server that wants to warn EARLIER than 90 %. Take whichever
 * fires first.
 */
export function quotaLevel(used: number, hardLimit: number, warnLimit: number | null): QuotaLevel {
  if (hardLimit <= 0) return 'ok'
  if (used >= hardLimit) return 'over'
  if (warnLimit !== null && warnLimit > 0 && used >= warnLimit) return 'warn'
  return used / hardLimit >= QUOTA_WARN_RATIO ? 'warn' : 'ok'
}

/**
 * The one quota worth a bar in the chrome: the account's own byte allowance, preferring one that
 * actually counts Email.
 *
 * A `hardLimit <= 0` is skipped: it is both a division hazard and, read literally, "nothing at all is
 * allowed" — which is never what a server means by it and never something a progress bar should imply.
 */
export function pickPrimaryQuota(quotas: readonly Quota[]): Quota | null {
  const usable = quotas.filter((quota) => quota.hardLimit > 0)
  const octets = usable.filter((quota) => quota.resourceType === 'octets')
  const accountScoped = octets.filter((quota) => quota.scope === 'account')
  const forMail = accountScoped.filter((quota) => quota.types.includes('Email'))
  return forMail[0] ?? accountScoped[0] ?? octets[0] ?? null
}

export function toQuotaView(quota: Quota): QuotaView {
  return {
    id: quota.id,
    name: quota.name,
    resourceType: quota.resourceType,
    used: quota.used,
    limit: quota.hardLimit,
    ratio: quota.hardLimit <= 0 ? 0 : Math.min(1, Math.max(0, quota.used / quota.hardLimit)),
    level: quotaLevel(quota.used, quota.hardLimit, quota.warnLimit),
  }
}

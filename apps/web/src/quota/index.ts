/**
 * `quota/` — RFC 9425 quota (M3.7, FR-QTA-01).
 *
 * Top-level rather than inside `settings/` because the sidebar bar lives in the EAGER mail chunk:
 * burying it in the lazy settings chunk would drag the settings screen into the entry bundle.
 * {@link QuotaPanel} is the only piece the settings screen owns, and it is imported from there.
 */

export { QuotaBar, type QuotaBarProps } from './QuotaBar'
export { QuotaPanel, type QuotaPanelProps } from './QuotaPanel'
export {
  makeQuotaClient,
  type QuotaClient,
  serverSupportsQuota,
} from './quota-client'
export {
  pickPrimaryQuota,
  QUOTA_WARN_RATIO,
  type QuotaLevel,
  type QuotaView,
  quotaLevel,
  toQuotaView,
} from './quota-model'
export { invalidateQuota, QUOTA_TTL_MS, resetQuotaStore, useQuota } from './use-quota'
export { type QuotaNotifierOptions, useQuotaNotifier } from './use-quota-notifier'

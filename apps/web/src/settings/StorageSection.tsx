/**
 * Settings → "Offline & storage" (M3.4, FR-OFF-02/FR-OFF-04). What is kept on this device, how much
 * space it uses, and the two controls the user actually has: ask the browser not to throw the data
 * away, and free space now.
 *
 * **It is honest about what it knows.** Bodies and attachments are exact sums of the stored sizes.
 * "Message index" is `count × ENVELOPE_BYTES_ESTIMATE` and says so. "Other" is
 * `estimate().usage − our accounting` (the app shell, the offline shell, the auth database,
 * IndexedDB's own overhead) and is HIDDEN entirely when the browser reports no estimate — a fabricated
 * number in a storage screen is worse than a missing one.
 *
 * Lives in the lazy `/settings` route chunk, so none of this — nor the engine module it reaches for
 * "Free up space" — costs the entry bundle anything.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../app/config-context'
import {
  CACHE_DAYS_CHOICES,
  effectiveCacheDays,
  setCacheDaysOverride,
  useCacheDaysOverride,
} from '../app/offline-prefs'
import { formatBytes } from '../i18n/formatters'
import { usePinnedMailboxes } from '../mail/pinned/use-pinned-folders'
import type { EstimateFn } from '../sync'
import { getActiveEngine, type MaintenanceOutcome } from '../sync/engine'
import { Button, Select, Switch, useToast } from '../ui'
import styles from './settings.module.css'
import { useRequestPersistence, useStorageUsage } from './use-storage-usage'

export interface StorageSectionProps {
  /** Injected in tests — jsdom has no StorageManager at all. */
  readonly estimate?: EstimateFn
  readonly persisted?: () => Promise<boolean | null>
  readonly requestPersist?: () => Promise<boolean>
  /** Injected in tests; defaults to a forced maintenance pass on the running engine. */
  readonly freeUpSpace?: () => Promise<MaintenanceOutcome>
}

/** Free space now: a forced pass (allowed on any tab — the deletes are idempotent and transactional). */
async function forcedMaintenance(): Promise<MaintenanceOutcome> {
  // The PRIMARY engine, deliberately (M4.4 Etappe 4): this is a DEVICE-level screen. It is also not
  // yet honest with shared accounts — `runMaintenance` evicts only its own engine's account and the
  // usage figure sums only the primary, so a device holding mostly shared-account cache can be told
  // "freed 0 bytes". The fix is global on both halves (fan a forced pass over `getRunningEngines()`,
  // sum usage across accounts) and is a reporting change, not a dispatch one; filed under M4.4.
  const engine = getActiveEngine()
  if (engine === null) return { status: 'skipped' }
  return engine.forceMaintenance()
}

export function StorageSection(props: StorageSectionProps) {
  const { t } = useTranslation()
  const config = useConfig()
  const { toast } = useToast()
  const pinned = usePinnedMailboxes()
  const requestPersist = useRequestPersistence(props.requestPersist)
  const view = useStorageUsage({
    ...(props.estimate ? { estimate: props.estimate } : {}),
    ...(props.persisted ? { persisted: props.persisted } : {}),
  })

  const meterId = useId()
  const summaryId = useId()
  const persistHintId = useId()
  const windowId = useId()
  const windowHintId = useId()
  // One resolution of the horizon, shared by the control and its own explanation — the sync engine
  // calls the same function, so the number on screen is the number the prune uses.
  useCacheDaysOverride()
  const cacheDays = effectiveCacheDays(config.offline.cacheDays)
  const [persistDenied, setPersistDenied] = useState(false)
  const [busy, setBusy] = useState(false)

  if (view === undefined) return null
  const { usage, budgetBytes, persisted } = view
  const estimate = usage.estimate

  // With no browser estimate we meter our OWN accounting against the configured budget: it is the only
  // ratio we can honestly draw.
  const used = estimate?.usage ?? usage.accountedBytes
  const total = estimate?.quota ?? budgetBytes
  const summary =
    estimate === null
      ? t('settings.offline.quotaUnknown')
      : t('settings.offline.total', {
          used: formatBytes(used),
          total: formatBytes(total),
        })

  async function freeUp(): Promise<void> {
    setBusy(true)
    try {
      const outcome = await (props.freeUpSpace ?? forcedMaintenance)()
      // A FAILED pass is not an empty one. The button matters most on a full disk, and a full disk
      // is exactly what makes the pass's gather stages abort — so the one press that had to be
      // reported honestly was answered with "Nothing to free up", i.e. a reassurance that the
      // storage screen contradicted two lines above.
      if (outcome.status === 'failed') {
        toast({ title: t('settings.offline.freeUpFailed'), tone: 'danger' })
        return
      }
      const freed = outcome.status === 'ran' ? outcome.result.evicted.freedBytes : 0
      toast({
        title:
          freed === 0
            ? t('settings.offline.nothingToFree')
            : t('settings.offline.freedToast', { size: formatBytes(freed) }),
      })
    } finally {
      setBusy(false)
    }
  }

  async function persist(): Promise<void> {
    const granted = await requestPersist()
    setPersistDenied(!granted)
  }

  // Rows, not a card: `Section` wraps whatever a section returns in the one `.controls` there is.
  return (
    <>
      {/* The product name is never hardcoded in the corpus — a hoster rebrands it (FR-THEME-02). */}
      <p className={styles.hint}>
        {t('settings.offline.description', { product: config.branding.productName })}
      </p>

      {/* `.group`, not `.field`: the meter and its summary are a block under their label, and a
          label parked in the vertical middle of one is a label floating in an empty column. */}
      <div className={styles.group}>
        <span id={meterId} className={styles.label}>
          {t('settings.offline.meter.label')}
        </span>
        {/* Native <progress> carries an implicit role="progressbar"; the numeric state is conveyed by
            the summary text it points at, never by the bar alone. */}
        <progress
          className={styles.meter}
          value={Math.min(used, total)}
          max={total}
          aria-labelledby={meterId}
          aria-describedby={summaryId}
        />
        <p id={summaryId} className={styles.hint}>
          {summary}
        </p>
      </div>

      <dl className={styles.breakdown}>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.offline.category.messages')}</dt>
          <dd>{formatBytes(usage.envelopes.bytes)}</dd>
        </div>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.offline.category.bodies')}</dt>
          <dd>{formatBytes(usage.bodies.bytes)}</dd>
        </div>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.offline.category.attachments')}</dt>
          <dd>{formatBytes(usage.blobs.bytes)}</dd>
        </div>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.offline.category.personalData')}</dt>
          <dd>{formatBytes(usage.personalData.bytes)}</dd>
        </div>
        {usage.otherBytes !== null && (
          <div className={styles.breakdownRow}>
            <dt>{t('settings.offline.category.other')}</dt>
            <dd>{formatBytes(usage.otherBytes)}</dd>
          </div>
        )}
      </dl>

      {persisted !== null && (
        <div className={styles.field}>
          <Switch
            block
            checked={persisted}
            disabled={persisted}
            label={t('settings.offline.persist.label')}
            aria-describedby={persistHintId}
            onCheckedChange={() => void persist()}
          />
          <p id={persistHintId} className={styles.hint}>
            {persisted
              ? t('settings.offline.persist.granted')
              : persistDenied
                ? t('settings.offline.persist.denied')
                : t('settings.offline.persist.hint')}
          </p>
        </div>
      )}

      <div className={styles.rowActions}>
        <Button variant="ghost" disabled={busy} onClick={() => void freeUp()}>
          {t('settings.offline.freeUp')}
        </Button>
      </div>

      {/*
        The horizon, as a CONTROL rather than a readout (B23, decided 2026-08-25).
        `config.json` supplies the value a fresh install starts with; the reader owns it from then
        on, because it bounds space on their own device — a hoster may state a default, not how
        much of someone else's disk a mail cache may use.

        Deliberately not offered beside it: `maxStorageMB`. It bounds the same cache from the other
        side, and two controls trimming one budget from two directions is how a state neither of
        them explains gets built.
      */}
      <div className={styles.field}>
        <label htmlFor={windowId} className={styles.label}>
          {t('settings.offline.windowLabel')}
        </label>
        <Select
          id={windowId}
          value={String(cacheDays)}
          aria-describedby={windowHintId}
          onChange={(event) => setCacheDaysOverride(Number.parseInt(event.target.value, 10))}
        >
          {CACHE_DAYS_CHOICES.map((days) => (
            <option key={days} value={days}>
              {t('settings.offline.windowChoice', { count: days })}
            </option>
          ))}
        </Select>
        <p id={windowHintId} className={styles.hint}>
          {t('settings.offline.window', { count: cacheDays })}
        </p>
        {/* Said out loud because it is invisible otherwise: shortening the horizon frees nothing
            until the next cleanup, and "Free up space" above is the button that does not wait. */}
        <p className={styles.hint}>{t('settings.offline.windowApplies')}</p>
      </div>

      <div className={styles.group}>
        <p className={styles.hint}>{t('settings.offline.pinned', { count: pinned?.size ?? 0 })}</p>
      </div>
    </>
  )
}

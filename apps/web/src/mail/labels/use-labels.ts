/**
 * Label registry hooks (M3.2). {@link useLabels} is the single live source the sidebar, the picker
 * and the per-row swatches read: it combines the curated `localPrefs['labels']` registry with the
 * custom keywords discovered on cached mail (the `akw` index) and per-label unread counts, all in one
 * Dexie liveQuery so any relevant write re-renders. {@link useLabelActions} mutates the registry via
 * the `updateLabels` read-modify-write (cross-tab safe) and, for a destructive delete, dispatches
 * chunked keyword-strip intents through the engine outbox.
 *
 * Owner decisions: rename edits the display name only (the wire keyword is immutable); delete is
 * non-destructive by default (registry entry removed, keyword left on messages) with an OPTIONAL
 * strip that removes the keyword from the replica-known carriers.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import {
  distinctKeywords,
  emailsWithKeyword,
  labelUnreadCounts,
  type ReplicaDb,
  updateLabels,
  useReplica,
  useReplicaQuery,
} from '../../sync'
import { getActiveEngine } from '../../sync/engine'
import {
  type DisplayLabel,
  LABELS_PREF_KEY,
  type LabelColor,
  type LabelPref,
  makeLabel,
  mergeLabels,
} from './label-model'

/** A merged display label plus its live unread count (the sidebar/badge model). */
export interface LabelSummary extends DisplayLabel {
  readonly unread: number
}

/** Max ids per durable keyword-strip intent (each intent is a resumable outbox row). */
const STRIP_CHUNK = 500

/**
 * The live label model: registry ⊕ discovered custom keywords, each with an unread count.
 * `undefined` until the first query resolves.
 */
export function useLabels(): LabelSummary[] | undefined {
  return useReplicaQuery(async ({ db, accountId }) => {
    const row = await db.localPrefs.get([accountId, LABELS_PREF_KEY])
    const registry = (row?.value as LabelPref[] | undefined) ?? []
    const discovered = await distinctKeywords(db, accountId)
    const merged = mergeLabels(registry, discovered)
    const counts = await labelUnreadCounts(
      db,
      accountId,
      merged.map((label) => label.keyword),
    )
    return merged.map((label) => ({ ...label, unread: counts.get(label.keyword) ?? 0 }))
  })
}

export interface LabelActions {
  /** Register a new label from a free-text name (slugged to a keyword); no-op if invalid/taken. */
  create(name: string, color: LabelColor): void
  /**
   * Register a DISCOVERED keyword exactly as it appears on mail (no re-slug/lowercasing) with a
   * display name + color — so adopting a mixed-case server keyword keeps the swatch/count lookups in
   * sync. No-op if already registered (case-insensitive).
   */
  register(keyword: string, name: string, color: LabelColor): void
  /** Edit the LOCAL display name only (the wire keyword is immutable). */
  renameDisplay(keyword: string, name: string): void
  recolor(keyword: string, color: LabelColor): void
  /** Remove the registry entry; with `alsoStrip`, also remove the keyword from known carriers. */
  remove(keyword: string, options?: { alsoStrip?: boolean }): void
}

/** Dispatch chunked `setKeywords(value:false)` intents over every replica-known carrier of `keyword`. */
async function stripKeyword(db: ReplicaDb, accountId: Id, keyword: string): Promise<void> {
  const engine = getActiveEngine()
  if (engine === null) return
  const rows = await emailsWithKeyword(db, accountId, keyword)
  const ids = rows.map((row) => row.id)
  for (let start = 0; start < ids.length; start += STRIP_CHUNK) {
    const chunk = ids.slice(start, start + STRIP_CHUNK)
    await engine.dispatch(
      { kind: 'setKeywords', emailIds: chunk, keyword, value: false },
      { id: crypto.randomUUID() },
    )
  }
}

export function useLabelActions(): LabelActions {
  const { db, accountId } = useReplica()
  return useMemo(
    () => ({
      create: (name, color) => {
        void updateLabels(db, accountId, (current) => {
          const label = makeLabel(
            name,
            color,
            current.map((entry) => entry.keyword),
          )
          return label === null ? current : [...current, label]
        })
      },
      register: (keyword, name, color) => {
        void updateLabels(db, accountId, (current) =>
          current.some((entry) => entry.keyword.toLowerCase() === keyword.toLowerCase())
            ? current
            : [...current, { keyword, name: name.trim() === '' ? keyword : name.trim(), color }],
        )
      },
      renameDisplay: (keyword, name) => {
        const trimmed = name.trim()
        if (trimmed === '') return
        void updateLabels(db, accountId, (current) =>
          current.map((entry) => (entry.keyword === keyword ? { ...entry, name: trimmed } : entry)),
        )
      },
      recolor: (keyword, color) => {
        void updateLabels(db, accountId, (current) =>
          current.map((entry) => (entry.keyword === keyword ? { ...entry, color } : entry)),
        )
      },
      remove: (keyword, options) => {
        void updateLabels(db, accountId, (current) =>
          current.filter((entry) => entry.keyword !== keyword),
        )
        if (options?.alsoStrip) void stripKeyword(db, accountId, keyword)
      },
    }),
    [db, accountId],
  )
}

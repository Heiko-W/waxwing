/**
 * Settings → Filters (M5.2, FR-SIEVE-01/02, RFC 9661).
 *
 * Rendered only when the server advertises `urn:ietf:params:jmap:sieve` and the hoster left
 * `features.sieveEditor` on (FR-SRV-02: a feature the server does not have is hidden, never
 * broken).
 *
 * The screen has two states, and which one it is in is not a preference but a fact about the
 * script on the server:
 *
 * - **Ours.** The script carries our marker, its rules are listed, editable and re-orderable, and
 *   the raw source is available read-only behind a toggle.
 * - **Someone else's.** The script has no marker — hand-written, or from Roundcube, Nextcloud, an
 *   admin. Then the rule list is not shown at all: the source is displayed read-only, and the only
 *   offer is to start managing filters *alongside* it, which keeps every line of theirs (see
 *   `adoptForeign`). Nothing is parsed, nothing is rewritten, nothing is thrown away.
 *
 * Three server calls that the section, and not the client, decides when to make:
 *
 * - **`SieveScript/validate` runs before every save** (FR-SIEVE-01). It is the only thing between
 *   "the server will not compile this" and finding out at delivery time, or never. It is advisory
 *   in one direction only: a refusal stops the save, but a validate that itself fails to complete
 *   does not — a broken validate must not make filters unsaveable.
 * - **`onSuccessDeactivateScript` is the master switch.** Turning filtering off leaves the script
 *   and its rules exactly where they are, which is why the list keeps showing them.
 * - **`destroy` removes the script.** RFC 9661 §2.4 refuses to destroy the active script in the
 *   call that deactivates it, so the client issues two — and if the server still says "it is
 *   active" (our snapshot can be stale), this retries after an explicit deactivate.
 *
 * Saving is online-only, like the vacation responder: a Sieve script is a settings document with
 * last-write-wins semantics, not something the outbox can replay or roll back.
 */

import type { SieveScript } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WaxwingConfig } from '../../app/config'
import { useSessionOptional } from '../../app/session/context'
import type { JmapSession } from '../../app/session/types'
import { useMailboxes } from '../../sync'
import { useEngineStatus } from '../../sync/engine'
import { Button, Dialog, Switch, useToast } from '../../ui'
import settings from '../settings.module.css'
import styles from './filters.module.css'
import { RuleForm } from './RuleForm'
import { RuleList } from './RuleList'
import type { SieveRule } from './rule-model'
import { generateSieve, unsupportedRequires } from './rule-model'
import {
  adoptForeign,
  buildScript,
  EMPTY_SCRIPT,
  type ManagedScript,
  parseScript,
} from './script-io'
import {
  isStillActiveRefusal,
  makeSieveClient,
  type SieveClient,
  SieveSetError,
  type SieveSnapshot,
  serverSupportsSieve,
  sieveExtensions,
} from './sieve-client'

export interface FiltersSectionProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: SieveClient
}

type Failure = 'loadFailed' | 'invalidSieve' | 'tooLarge' | 'offline' | 'rejected' | 'generic'

interface FailureState {
  readonly kind: Failure
  /** The server's own words, when it gave any — a compile error names the line. */
  readonly reason?: string | undefined
}

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function failureText(t: TFunction, failure: FailureState): string {
  switch (failure.kind) {
    case 'loadFailed':
      return t('settings.filters.error.loadFailed')
    case 'invalidSieve':
      return failure.reason === undefined || failure.reason === ''
        ? t('settings.filters.error.invalidSieve')
        : t('settings.filters.error.invalidSieveReason', { reason: failure.reason })
    case 'tooLarge':
      return t('settings.filters.error.tooLarge')
    case 'offline':
      return t('settings.filters.error.offline')
    case 'rejected':
      return t('settings.filters.error.rejected')
    case 'generic':
      return t('settings.filters.error.generic')
  }
}

function classify(thrown: unknown, offline: boolean): FailureState {
  if (thrown instanceof SieveSetError) {
    // Both spellings: Stalwart still emits the pre-RFC `invalidScript`.
    if (thrown.type === 'invalidSieve' || thrown.type === 'invalidScript')
      return { kind: 'invalidSieve', reason: thrown.message }
    if (thrown.type === 'tooLarge' || thrown.type === 'overQuota') return { kind: 'tooLarge' }
    return { kind: 'rejected' }
  }
  return { kind: offline ? 'offline' : 'generic' }
}

export function FiltersSection(props: FiltersSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const status = useEngineStatus()
  const mailboxes = useMailboxes() ?? []

  const [snapshot, setSnapshot] = useState<SieveSnapshot | null>(null)
  const [script, setScript] = useState<ManagedScript>(EMPTY_SCRIPT)
  const [editing, setEditing] = useState<{ rule: SieveRule | null } | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<FailureState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  // Memoized for the reason the other sections spell out: an unmemoized client is a new object
  // every render, the load effect depends on it, and the result is a request storm.
  const client: SieveClient | null = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeSieveClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  const extensions = sieveExtensions(connected?.jmapSession ?? null, accountId)
  const offline = !status.online

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === null) return
      const next = await client.load(signal)
      setSnapshot(next)
      // Ours even when it is not the active one: switching filtering off must not empty the list.
      const showing = next.active ?? next.managed
      setScript(showing === null ? EMPTY_SCRIPT : parseScript(showing.source))
    },
    [client],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      .then(() => setFailure(null))
      .catch((thrown: unknown) => {
        if (controller.signal.aborted) return
        setFailure({ kind: 'loadFailed' })
        console.warn('Failed to load Sieve scripts', thrown)
      })
    return () => controller.abort()
  }, [load])

  /** The script this section writes to, if the account has one at all. */
  const target: SieveScript | null = snapshot?.active?.script ?? snapshot?.managed?.script ?? null
  /** Is a script actually filtering mail right now? */
  const filtering = (snapshot?.active ?? null) !== null

  /** Compiles `rules` with the preserved foreign source and writes the whole script. */
  const persist = useCallback(
    async (rules: readonly SieveRule[], foreign: ManagedScript) => {
      if (client === null) return
      setBusy(true)
      setFailure(null)
      const source = buildScript(rules, foreign, extensions)
      try {
        // FR-SIEVE-01: the server compiles it before it is stored. A rule set the server will not
        // accept otherwise surfaces at the save — or, for a script that compiles but was never
        // activated, not at all.
        const refusal = await validateQuietly(client, source)
        if (refusal !== null) {
          setFailure({ kind: 'invalidSieve', reason: refusal.description ?? undefined })
          return
        }
        // A script that exists and is switched off stays switched off while it is edited.
        await client.save(source, target, { activate: target === null || filtering })
        await load()
        toast({ title: t('settings.filters.saved') })
      } catch (thrown) {
        setFailure(classify(thrown, offline))
      } finally {
        setBusy(false)
      }
    },
    [client, target, filtering, load, toast, t, offline, extensions],
  )

  /** Turns filtering on or off without touching a single rule. */
  const setFiltering = useCallback(
    async (on: boolean) => {
      if (client === null || target === null) return
      setBusy(true)
      setFailure(null)
      try {
        if (on) await client.activate(target)
        else await client.deactivate()
        await load()
      } catch (thrown) {
        setFailure(classify(thrown, offline))
      } finally {
        setBusy(false)
      }
    },
    [client, target, load, offline],
  )

  /** Removes the script from the server entirely. */
  const destroyScript = useCallback(async () => {
    if (client === null || target === null) return
    setBusy(true)
    setFailure(null)
    try {
      try {
        await client.destroy(target)
      } catch (thrown) {
        // RFC 9661 §2.4 forbids destroying the active script. The client already deactivates first
        // when its snapshot says the script is active — this is the case where the snapshot was
        // wrong (something else activated it since the last read).
        if (!isStillActiveRefusal(thrown)) throw thrown
        await client.deactivate()
        await client.destroy({ ...target, isActive: false })
      }
      setConfirmDelete(false)
      await load()
      toast({ title: t('settings.filters.delete.done') })
    } catch (thrown) {
      setFailure(classify(thrown, offline))
    } finally {
      setBusy(false)
    }
  }, [client, target, load, toast, t, offline])

  const rules = script.rules ?? []

  /** Extensions our rules need that this server never advertised (a delivery-time failure). */
  const missing = useMemo(
    () => unsupportedRequires(generateSieve(rules, extensions).requires, extensions),
    [rules, extensions],
  )

  if (client === null) return null

  const upsert = (rule: SieveRule) => {
    const next = rules.some((existing) => existing.id === rule.id)
      ? rules.map((existing) => (existing.id === rule.id ? rule : existing))
      : [...rules, rule]
    setEditing(null)
    void persist(next, script)
  }

  const foreignPreserved = script.preamble !== '' || script.trailer !== ''

  // Rows, not a card: `Section` wraps whatever a section returns in the one `.controls` there is.
  return (
    <>
      <p className={settings.hint}>{t('settings.filters.intro')}</p>

      {failure !== null && (
        <p className={styles.error} role="alert">
          {failureText(t, failure)}
        </p>
      )}

      {/* The master switch, above everything it governs. Absent until there is a script, because
          until then there is nothing to switch off and a control that governs nothing is noise. */}
      {target !== null && (
        <div className={settings.field}>
          <Switch
            block
            checked={filtering}
            label={t('settings.filters.active')}
            disabled={busy || offline}
            onCheckedChange={(on) => void setFiltering(on)}
          />
          <p className={settings.hint}>
            {filtering ? t('settings.filters.activeHint') : t('settings.filters.inactiveHint')}
          </p>
        </div>
      )}

      {script.opaque ? (
        <ForeignScript
          source={script.preamble}
          busy={busy}
          onAdopt={() => {
            const adopted = adoptForeign(script.preamble)
            setScript(adopted)
            void persist([], adopted)
          }}
        />
      ) : (
        <>
          {missing.length > 0 && (
            <p className={styles.warning} role="status">
              {t('settings.filters.unsupportedExtensions', { list: missing.join(', ') })}
            </p>
          )}

          {rules.length === 0 ? (
            <p className={settings.hint}>{t('settings.filters.empty')}</p>
          ) : (
            <RuleList
              rules={rules}
              disabled={busy || offline}
              onToggle={(rule, enabled) =>
                void persist(
                  rules.map((existing) =>
                    existing.id === rule.id ? { ...existing, enabled } : existing,
                  ),
                  script,
                )
              }
              onEdit={(rule) => setEditing({ rule })}
              onDelete={(rule) =>
                void persist(
                  rules.filter((existing) => existing.id !== rule.id),
                  script,
                )
              }
              onReorder={(next) => void persist(next, script)}
            />
          )}

          {/* Both actions in ONE row, at ONE size. They were two rows: "Add rule" a direct child
              of the card and therefore stretched across all 668px of it, "Show script" directly
              underneath at `size="sm"` — 12px type against 14px, for two buttons of equal rank
              sitting one above the other. "Show script" stays enabled offline: it discloses the
              script already on screen and writes nothing. */}
          <div className={settings.rowActions}>
            <Button
              variant="secondary"
              disabled={busy || offline}
              onClick={() => setEditing({ rule: null })}
            >
              {t('settings.filters.addRule')}
            </Button>

            <Button variant="ghost" onClick={() => setShowSource((shown) => !shown)}>
              {showSource ? t('settings.filters.hideSource') : t('settings.filters.showSource')}
            </Button>

            {target !== null && (
              <Button
                variant="ghost"
                disabled={busy || offline}
                onClick={() => setConfirmDelete(true)}
              >
                {t('settings.filters.deleteScript')}
              </Button>
            )}
          </div>

          {showSource && (
            // FR-SIEVE-02: the raw script, for the reader who wants to know exactly what runs.
            // Read-only on purpose — a script edited here would have to be re-parsed to stay in
            // sync with the rule list, which is the round trip this design refuses to make.
            <SourceView source={buildScript(rules, script, extensions)} />
          )}
        </>
      )}

      {/* The same sentence identities has shown since M5.1, for the same reason. Filters used to
          leave every action live offline: a reader could open the rule form, fill in six fields and
          meet the failure only on Save. Two sections of one screen answering "you are offline" two
          different ways is the finding; saying it BEFORE the work is the answer. */}
      {offline && <p className={settings.hint}>{t('settings.filters.error.offline')}</p>}

      {editing !== null && (
        <RuleForm
          rule={editing.rule}
          mailboxes={mailboxes}
          extensions={extensions}
          busy={busy}
          onSubmit={upsert}
          onCancel={() => setEditing(null)}
        />
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('settings.filters.delete.title')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('settings.filters.delete.cancel')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void destroyScript()}>
              {t('settings.filters.delete.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('settings.filters.delete.body')}</p>
        {/* Not a hypothetical: the region we manage sits INSIDE whatever script was already there,
            and destroying it takes their rules with it. They were preserved precisely so that this
            would never happen by accident — so it may only happen on purpose. */}
        {foreignPreserved && <p>{t('settings.filters.delete.foreignWarning')}</p>}
      </Dialog>
    </>
  )
}

/**
 * `SieveScript/validate`, run for its answer and not for its failures.
 *
 * A refusal is returned and stops the save. A validate that could not be performed at all — the
 * request failed, the server does not implement the method — returns `null`: the save then goes
 * ahead and reports whatever the server says about it. The alternative is a client in which one
 * broken method makes filters permanently unsaveable, which is a worse failure than the one this
 * check exists to catch. ADR-023 records the other half: a clean validate is not proof either,
 * because Stalwart compiles a `require` for an extension it does not implement.
 */
async function validateQuietly(
  client: SieveClient,
  source: string,
): Promise<{ description?: string | null } | null> {
  try {
    return await client.validate(source)
  } catch (thrown) {
    console.warn('SieveScript/validate could not be performed', thrown)
    return null
  }
}

/**
 * A read-only view of a script.
 *
 * A visible caption rather than an `aria-label` on the `<pre>`: the label is useful to everyone
 * reading the page, and `<pre>` has no role that carries an accessible name anyway.
 */
function SourceView(props: { readonly source: string }) {
  const { t } = useTranslation()
  return (
    <figure className={styles.sourceFigure}>
      <figcaption className={settings.label}>{t('settings.filters.sourceLabel')}</figcaption>
      <pre className={styles.source}>{props.source}</pre>
    </figure>
  )
}

interface ForeignScriptProps {
  readonly source: string
  readonly busy: boolean
  onAdopt(): void
}

/**
 * A script this client did not write.
 *
 * Shown, not parsed. The offer is explicitly additive — "manage filters alongside this" — because
 * the alternative a user would otherwise assume, that we understood their script well enough to
 * edit it, is exactly the promise this design will not make.
 *
 * Deliberately NO delete here, although the client can. Deleting a script we refuse to read, from
 * the one surface that exists to say we left it alone, is the contradiction ADR-023 is about. The
 * master switch above is the answer to "stop this from running": it is reversible and it destroys
 * nothing.
 */
function ForeignScript(props: ForeignScriptProps) {
  const { t } = useTranslation()
  return (
    <div className={styles.foreign}>
      <p className={styles.warning} role="status">
        {t('settings.filters.foreign.explain')}
      </p>
      <SourceView source={props.source} />
      <Button variant="secondary" loading={props.busy} onClick={props.onAdopt}>
        {t('settings.filters.foreign.adopt')}
      </Button>
      <p className={settings.hint}>{t('settings.filters.foreign.adoptHint')}</p>
    </div>
  )
}

/**
 * Should the Filters section render at all?
 *
 * Two gates, and both belong here rather than in the section body: the heading has to disappear
 * with the contents, or the page shows a section that is permanently empty.
 *
 * `features.sieveEditor` is the hoster's switch, for a deployment where filters are managed
 * centrally and a per-user editor would only invite support tickets. It was documented in
 * `docs/configuration.md` long before this section existed and read by nothing at all until now.
 */
export function filtersAvailable(
  session: JmapSession | null,
  accountId: string | null,
  config: WaxwingConfig,
): boolean {
  if (!config.features.sieveEditor) return false
  return serverSupportsSieve(session, accountId)
}

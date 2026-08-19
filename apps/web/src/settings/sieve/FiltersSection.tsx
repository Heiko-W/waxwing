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
 * - **Ours.** The active script carries our marker, its rules are listed and editable, and the raw
 *   source is available read-only behind a toggle.
 * - **Someone else's.** The script has no marker — hand-written, or from Roundcube, Nextcloud, an
 *   admin. Then the rule list is not shown at all: the source is displayed read-only, and the only
 *   offer is to start managing filters *alongside* it, which keeps every line of theirs (see
 *   `adoptForeign`). Nothing is parsed, nothing is rewritten, nothing is thrown away.
 *
 * Saving is online-only, like the vacation responder: a Sieve script is a settings document with
 * last-write-wins semantics, not something the outbox can replay or roll back.
 */

import type { SieveScript } from '@waxwing/jmap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WaxwingConfig } from '../../app/config'
import { useSessionOptional } from '../../app/session/context'
import type { JmapSession } from '../../app/session/types'
import { useMailboxes } from '../../sync'
import { useEngineStatus } from '../../sync/engine'
import { Button, Switch, useToast } from '../../ui'
import settings from '../settings.module.css'
import styles from './filters.module.css'
import { RuleForm } from './RuleForm'
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

/** Spelled out, not computed: the i18n guard only sees literal keys. */
function failureText(t: (key: string) => string, failure: Failure): string {
  switch (failure) {
    case 'loadFailed':
      return t('settings.filters.error.loadFailed')
    case 'invalidSieve':
      return t('settings.filters.error.invalidSieve')
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

function classify(thrown: unknown, offline: boolean): Failure {
  if (thrown instanceof SieveSetError) {
    // Both spellings: Stalwart still emits the pre-RFC `invalidScript`.
    if (thrown.type === 'invalidSieve' || thrown.type === 'invalidScript') return 'invalidSieve'
    if (thrown.type === 'tooLarge' || thrown.type === 'overQuota') return 'tooLarge'
    return 'rejected'
  }
  return offline ? 'offline' : 'generic'
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
  const [failure, setFailure] = useState<Failure | null>(null)

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
      setScript(next.active === null ? EMPTY_SCRIPT : parseScript(next.active.source))
    },
    [client],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      .then(() => setFailure(null))
      .catch((thrown: unknown) => {
        if (controller.signal.aborted) return
        setFailure('loadFailed')
        console.warn('Failed to load Sieve scripts', thrown)
      })
    return () => controller.abort()
  }, [load])

  /** Compiles `rules` with the preserved foreign source and writes the whole script. */
  const persist = useCallback(
    async (rules: readonly SieveRule[], foreign: ManagedScript) => {
      if (client === null) return
      setBusy(true)
      setFailure(null)
      try {
        await client.save(
          buildScript(rules, foreign),
          snapshot?.active?.script ?? managedOf(snapshot),
        )
        await load()
        toast({ title: t('settings.filters.saved') })
      } catch (thrown) {
        setFailure(classify(thrown, offline))
      } finally {
        setBusy(false)
      }
    },
    [client, snapshot, load, toast, t, offline],
  )

  const rules = script.rules ?? []

  /** Extensions our rules need that this server never advertised (a delivery-time failure). */
  const missing = useMemo(
    () => unsupportedRequires(generateSieve(rules).requires, extensions),
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

  return (
    <div className={settings.controls}>
      <p className={settings.hint}>{t('settings.filters.intro')}</p>

      {failure !== null && (
        <p className={styles.error} role="alert">
          {failureText(t, failure)}
        </p>
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
            <ul className={styles.ruleList}>
              {rules.map((rule) => (
                <li key={rule.id} className={styles.ruleRow}>
                  <Switch
                    checked={rule.enabled}
                    label={t('settings.filters.rule.enabled')}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      void persist(
                        rules.map((existing) =>
                          existing.id === rule.id ? { ...existing, enabled } : existing,
                        ),
                        script,
                      )
                    }
                  />
                  <span className={styles.ruleName}>{rule.name}</span>
                  <div className={settings.rowActions}>
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ rule })}>
                      {t('settings.filters.rule.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void persist(
                          rules.filter((existing) => existing.id !== rule.id),
                          script,
                        )
                      }
                    >
                      {t('settings.filters.rule.delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Button variant="secondary" disabled={busy} onClick={() => setEditing({ rule: null })}>
            {t('settings.filters.addRule')}
          </Button>

          <Button variant="ghost" size="sm" onClick={() => setShowSource((shown) => !shown)}>
            {showSource ? t('settings.filters.hideSource') : t('settings.filters.showSource')}
          </Button>

          {showSource && (
            // FR-SIEVE-02: the raw script, for the reader who wants to know exactly what runs.
            // Read-only on purpose — a script edited here would have to be re-parsed to stay in
            // sync with the rule list, which is the round trip this design refuses to make.
            <SourceView source={buildScript(rules, script)} />
          )}
        </>
      )}

      {editing !== null && (
        <RuleForm
          rule={editing.rule}
          mailboxes={mailboxes}
          busy={busy}
          onSubmit={upsert}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
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

/** The managed script if one exists but is not active — a create must not duplicate it. */
function managedOf(snapshot: SieveSnapshot | null): SieveScript | null {
  return snapshot?.scripts.find((script) => script.name === 'waxwing') ?? null
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

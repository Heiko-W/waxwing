/**
 * Settings → Vacation responder (M3.7, FR-VAC-01).
 *
 * Rendered only when the server advertises `urn:ietf:params:jmap:vacationresponse` (FR-SRV-02: a
 * feature the server does not have is hidden, never broken).
 *
 * **"Preview" means the message a recipient will actually get** — the same sanitizer, the same
 * sandboxed frame and the same link gate the reading pane uses, with remote content off. A second,
 * hand-rolled rendering surface would be a promise we could not keep: the point of a preview is that
 * it is not a different renderer. "Same" has to include the SECURITY behaviour, which is where this
 * went wrong once (G2): the preview was the one `MailBodyFrame` consumer that opened links itself,
 * so the FR-RD-08 host check did not run on this surface at all.
 *
 * Saving is online-only and carries `ifInState`, so a change made elsewhere is caught rather than
 * quietly overwritten — and a conflict repaints the form from the server instead of merging behind
 * the user's back.
 */

import { JmapMethodError } from '@waxwing/jmap'
import { sanitize } from '@waxwing/mail-html'
import type { TFunction } from 'i18next'
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import {
  cleanOutgoingHtml,
  type EditorFactory,
  RichTextEditor,
  type RichTextEditorHandle,
} from '../compose'
import { formatDate } from '../i18n/formatters'
import { MailBodyFrame } from '../mail/MailBodyFrame'
import { useLinkOpener } from '../mail/use-link-opener'
import { useEngineStatus } from '../sync/engine'
import { Button, Switch, TextInput, useToast } from '../ui'
import styles from './settings.module.css'
import { makeVacationClient, type VacationClient, VacationSetError } from './vacation-client'
import {
  DEFAULT_VACATION_DRAFT,
  toDraft,
  toPatch,
  type VacationDraft,
  type VacationErrorCode,
  vacationStatus,
  validateVacation,
} from './vacation-model'

export interface VacationSectionProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: VacationClient
  /** Injected in tests — the real editor lazy-loads Squire, which jsdom cannot run. */
  readonly editorFactory?: EditorFactory
}

/** Lazy, exactly as the reading pane loads it: most users never open a preview, let alone trip it. */
const LinkWarningDialog = lazy(() => import('../mail/LinkWarningDialog'))

/**
 * What went wrong — and `loadFailed` is a separate member on purpose.
 *
 * The section used to carry `{ key: string }` and reach for `error.generic` ("The vacation
 * responder could not be saved.") when a LOAD failed, because no load-failure string existed. Two
 * defects in one shortcut: the sentence was false — nothing had been saved — and it was
 * character-for-character the sentence a real save failure produces, so the reader could not tell a
 * genuine one from this. Its neighbours already say "The filters could not be LOADED."
 */
type Failure = 'loadFailed' | 'conflict' | 'rejected' | 'offline' | 'generic'

/**
 * Spelled out rather than `t(\`settings.vacation.error.${failure}\`)`: `guards.test.ts` only sees
 * LITERAL keys, so a computed one passes every gate and then renders the key itself on screen the
 * day a translation is missing. Identities and filters have spelled theirs out from the start; this
 * section was the one that did not, which is also how it came to name a key that said the wrong
 * thing with no check anywhere able to notice.
 */
function failureText(t: TFunction, failure: Failure): string {
  switch (failure) {
    case 'loadFailed':
      return t('settings.vacation.error.loadFailed')
    case 'conflict':
      return t('settings.vacation.error.conflict')
    case 'rejected':
      return t('settings.vacation.error.rejected')
    case 'offline':
      return t('settings.vacation.error.offline')
    case 'generic':
      return t('settings.vacation.error.generic')
  }
}

/** The one thing the form itself can refuse, for the same literal-key reason. */
function problemText(t: TFunction, problem: VacationErrorCode): string {
  switch (problem) {
    case 'endBeforeStart':
      return t('settings.vacation.error.endBeforeStart')
  }
}

export function VacationSection(props: VacationSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const status = useEngineStatus()
  // The preview is the reading pane's frame, so it gets the reading pane's link gate — the same hook,
  // the same `classifyLink`, the same non-disableable interstitial (FR-RD-08). It used to call
  // `window.open` from an inline arrow instead, which meant TWO defects in one line: no host
  // comparison happened on this surface at all, and a fresh `onOpenLink` identity on every render
  // re-fired `MailBodyFrame`'s mount effect, tearing the iframe down and rebuilding it on every
  // keystroke in the form above. `useLinkOpener`'s callbacks are stable, which fixes both.
  const links = useLinkOpener()

  const injected = props.client
  const [draft, setDraft] = useState<VacationDraft>(DEFAULT_VACATION_DRAFT)
  /** Mirrors `draft` so `save()` can read a just-flushed editor value without waiting for a render. */
  const draftRef = useRef<VacationDraft>(DEFAULT_VACATION_DRAFT)
  const editorRef = useRef<RichTextEditorHandle>(null)
  const [state, setState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [error, setError] = useState<Failure | null>(null)

  const ids = {
    enable: useId(),
    from: useId(),
    to: useId(),
    subject: useId(),
    preview: useId(),
    error: useId(),
  }

  // MEMOIZED, and that is not a micro-optimisation — it is the difference between one request and a
  // storm. `makeVacationClient()` returns a fresh object, so an unmemoized client is a new identity
  // on every render; the load effect below depends on it, so every `setDraft` from a load would
  // schedule the next load. That loop hammers `VacationResponse/get` for as long as the Settings
  // screen is open (Stalwart answers HTTP 429 within seconds) AND it overwrites whatever the user
  // just typed with the server's copy — the switch physically cannot be turned on. Depend on the
  // session identities, which change when the session does and not otherwise.
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  const client: VacationClient | null = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeVacationClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === null) return
      const snapshot = await client.get(signal)
      const next = toDraft(snapshot.vacation)
      draftRef.current = next
      setDraft(next)
      setState(snapshot.state)
    },
    [client],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      // A load that SUCCEEDED clears whatever the last one said, or a transient failure stays on
      // screen for good: nothing else resets it, and it would sit over a form that is demonstrably
      // fine. Only here — the conflict path repaints through `load()` too, and its message has to
      // survive that repaint.
      .then(() => {
        if (!controller.signal.aborted) setError(null)
      })
      .catch((thrown: unknown) => {
        // An aborted request is not a failure — it is us, tearing the effect down. React
        // StrictMode double-invokes effects in development and the client identity changes on
        // reconnect or an account switch, so treating the abort as an error painted a red
        // `role="alert"` over a form that had loaded perfectly on the second run: "The vacation
        // responder could not be saved." on a freshly opened section, in six runs out of six,
        // without the reader having touched a thing. (IdentitiesSection has handled this case
        // since M5.1; this line had not.)
        if (controller.signal.aborted) return
        if (thrown instanceof DOMException && thrown.name === 'AbortError') return
        // And a LOAD that fails is not a SAVE that failed — see the `Failure` type above.
        setError('loadFailed')
      })
    return () => controller.abort()
  }, [load])

  const invalid = validateVacation(draft)
  const offline = !status.online

  // The draft is mirrored in a ref, and that is what `save()` reads. `RichTextEditor.flush()` emits
  // the pending keystrokes SYNCHRONOUSLY through `onChange` → `patch`, but `draft` is React state:
  // reading it in the same handler would still see the value from before the flush. The ref is
  // written eagerly, so the flush is visible immediately.
  const patch = (next: Partial<VacationDraft>): void => {
    const merged = { ...draftRef.current, ...next }
    draftRef.current = merged
    setDraft(merged)
    setError(null)
  }

  async function save(): Promise<void> {
    if (client === null || state === null) return
    // The editor debounces by 200 ms (it keeps typing off the parent's render path), so a user who
    // types their away message and reaches straight for Save would otherwise save an EMPTY body —
    // the exact data loss `flush()` was added for in M2.8, when the composer hit it on send.
    editorRef.current?.flush()
    const current = draftRef.current
    setBusy(true)
    setError(null)
    try {
      const snapshot = await client.save(toPatch(current), state)
      const next = toDraft(snapshot.vacation)
      draftRef.current = next
      setDraft(next)
      setState(snapshot.state)
      toast({ title: t('settings.vacation.saved') })
    } catch (thrown) {
      // A stale `ifInState` aborts the METHOD (RFC 8620 §5.3), so it arrives here — never in
      // `notUpdated`. Repaint from the server rather than merge: we cannot know which of the two
      // versions the user meant, and silently keeping ours would discard someone else's change.
      if (thrown instanceof JmapMethodError && thrown.type === 'stateMismatch') {
        setError('conflict')
        await load().catch(() => {})
      } else if (thrown instanceof VacationSetError) {
        setError('rejected')
      } else {
        setError(offline ? 'offline' : 'generic')
      }
    } finally {
      setBusy(false)
    }
  }

  const statusKey = vacationStatus(draft, Date.now())
  const statusText =
    statusKey === 'scheduled' && draft.fromLocal !== ''
      ? t('settings.vacation.status.scheduled', {
          date: formatDate(new Date(draft.fromLocal), { dateStyle: 'medium', timeStyle: 'short' }),
        })
      : t(`settings.vacation.status.${statusKey}`)

  const previewHtml = sanitize(cleanOutgoingHtml(draft.bodyHtml), { allowRemote: false }).html

  // Rows, not a card: `Section` wraps whatever a section returns in the one `.controls` there is.
  return (
    <>
      <p className={styles.hint}>{t('settings.vacation.description')}</p>

      <div className={styles.field}>
        <Switch
          block
          checked={draft.isEnabled}
          label={t('settings.vacation.enable.label')}
          aria-describedby={ids.enable}
          onCheckedChange={(next) => patch({ isEnabled: next })}
        />
        <p id={ids.enable} className={styles.hint}>
          {statusText}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.from}>
          {t('settings.vacation.from')}
        </label>
        <TextInput
          id={ids.from}
          type="datetime-local"
          value={draft.fromLocal}
          onChange={(event) => patch({ fromLocal: event.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.to}>
          {t('settings.vacation.to')}
        </label>
        <TextInput
          id={ids.to}
          type="datetime-local"
          value={draft.toLocal}
          onChange={(event) => patch({ toLocal: event.target.value })}
        />
        <p className={styles.hint}>
          {t('settings.vacation.timezoneHint', {
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.subject}>
          {t('settings.vacation.subject.label')}
        </label>
        <TextInput
          id={ids.subject}
          value={draft.subject}
          placeholder={t('settings.vacation.subject.placeholder')}
          onChange={(event) => patch({ subject: event.target.value })}
        />
      </div>

      {/* The editor is a labelled BLOCK, like every other row of this card, rather than a bare
          child of it. It brings its own border and its own rounded corners, so as a direct child
          with no inset its corners cut visibly into the straight edge of the card and its toolbar
          ran to within a pixel of it. It also had no visible label while every field above it did —
          the name was only ever in `ariaLabel`. */}
      <div className={styles.group}>
        {/* A plain <span>, as in IdentityForm: the editor's own `ariaLabel` carries the same
            words, so the accessible name is right and the visible one no longer missing. */}
        <span className={styles.label}>{t('settings.vacation.body.label')}</span>
        <RichTextEditor
          ref={editorRef}
          value={draft.bodyHtml}
          onChange={(html) => patch({ bodyHtml: html })}
          ariaLabel={t('settings.vacation.body.label')}
          {...(props.editorFactory ? { factory: props.editorFactory } : {})}
        />
      </div>

      <div className={styles.group}>
        <div className={styles.rowActions}>
          <Button
            variant="ghost"
            aria-expanded={previewOpen}
            aria-controls={ids.preview}
            onClick={() => setPreviewOpen((open) => !open)}
          >
            {previewOpen
              ? t('settings.vacation.preview.hide')
              : t('settings.vacation.preview.show')}
          </Button>
        </div>
        {previewOpen && (
          <div id={ids.preview}>
            <MailBodyFrame
              bodyHtml={previewHtml}
              allowRemote={false}
              title={t('settings.vacation.preview.title')}
              onOpenLink={links.onOpenLink}
              onGateLink={links.gateLink}
            />
          </div>
        )}
        {/* Outside the `previewOpen` branch on purpose: hiding the preview mid-decision must not
            silently drop the dialog the reader is still looking at. */}
        {links.pending !== null && (
          <Suspense fallback={null}>
            <LinkWarningDialog
              claimedHost={links.pending.claimedHost}
              targetHost={links.pending.targetHost}
              onConfirm={links.confirm}
              onCancel={links.cancel}
            />
          </Suspense>
        )}
      </div>

      {(invalid !== null || error !== null) && (
        <p id={ids.error} role="alert" className={styles.error}>
          {invalid !== null ? problemText(t, invalid) : error !== null ? failureText(t, error) : ''}
        </p>
      )}

      <div className={styles.group}>
        <div className={styles.rowActions}>
          <Button
            variant="primary"
            disabled={busy || invalid !== null || offline || state === null}
            aria-describedby={invalid !== null || error !== null ? ids.error : undefined}
            onClick={() => void save()}
          >
            {t('settings.vacation.save')}
          </Button>
        </div>
        {offline && <p className={styles.hint}>{t('settings.vacation.error.offline')}</p>}
      </div>
    </>
  )
}

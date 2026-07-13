/**
 * Settings → Vacation responder (M3.7, FR-VAC-01).
 *
 * Rendered only when the server advertises `urn:ietf:params:jmap:vacationresponse` (FR-SRV-02: a
 * feature the server does not have is hidden, never broken).
 *
 * **"Preview" means the message a recipient will actually get** — the same sanitizer and the same
 * sandboxed frame the reading pane uses, with remote content off. A second, hand-rolled rendering
 * surface would be a promise we could not keep: the point of a preview is that it is not a different
 * renderer.
 *
 * Saving is online-only and carries `ifInState`, so a change made elsewhere is caught rather than
 * quietly overwritten — and a conflict repaints the form from the server instead of merging behind
 * the user's back.
 */

import { JmapMethodError } from '@waxwing/jmap'
import { sanitize } from '@waxwing/mail-html'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { useEngineStatus } from '../sync/engine'
import { Button, Switch, TextInput, useToast } from '../ui'
import styles from './settings.module.css'
import { makeVacationClient, type VacationClient, VacationSetError } from './vacation-client'
import {
  DEFAULT_VACATION_DRAFT,
  toDraft,
  toPatch,
  type VacationDraft,
  vacationStatus,
  validateVacation,
} from './vacation-model'

export interface VacationSectionProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: VacationClient
  /** Injected in tests — the real editor lazy-loads Squire, which jsdom cannot run. */
  readonly editorFactory?: EditorFactory
}

type SaveError = { readonly key: string } | null

export function VacationSection(props: VacationSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const status = useEngineStatus()

  const injected = props.client
  const [draft, setDraft] = useState<VacationDraft>(DEFAULT_VACATION_DRAFT)
  /** Mirrors `draft` so `save()` can read a just-flushed editor value without waiting for a render. */
  const draftRef = useRef<VacationDraft>(DEFAULT_VACATION_DRAFT)
  const editorRef = useRef<RichTextEditorHandle>(null)
  const [state, setState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [error, setError] = useState<SaveError>(null)

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
    void load(controller.signal).catch(() => setError({ key: 'settings.vacation.error.generic' }))
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
        setError({ key: 'settings.vacation.error.conflict' })
        await load().catch(() => {})
      } else if (thrown instanceof VacationSetError) {
        setError({ key: 'settings.vacation.error.rejected' })
      } else {
        setError({
          key: offline ? 'settings.vacation.error.offline' : 'settings.vacation.error.generic',
        })
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

  return (
    <div className={styles.controls}>
      <p className={styles.hint}>{t('settings.vacation.description')}</p>

      <div className={styles.field}>
        <Switch
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

      <RichTextEditor
        ref={editorRef}
        value={draft.bodyHtml}
        onChange={(html) => patch({ bodyHtml: html })}
        ariaLabel={t('settings.vacation.body.label')}
        {...(props.editorFactory ? { factory: props.editorFactory } : {})}
      />

      <div className={styles.field}>
        <Button
          variant="ghost"
          aria-expanded={previewOpen}
          aria-controls={ids.preview}
          onClick={() => setPreviewOpen((open) => !open)}
        >
          {previewOpen ? t('settings.vacation.preview.hide') : t('settings.vacation.preview.show')}
        </Button>
        {previewOpen && (
          <div id={ids.preview}>
            <MailBodyFrame
              bodyHtml={previewHtml}
              allowRemote={false}
              title={t('settings.vacation.preview.title')}
              onOpenLink={(href) => window.open(href, '_blank', 'noopener,noreferrer')}
            />
          </div>
        )}
      </div>

      {(invalid !== null || error !== null) && (
        <p id={ids.error} role="alert" className={styles.hint}>
          {invalid !== null ? t(`settings.vacation.error.${invalid}`) : t(error?.key ?? '')}
        </p>
      )}

      <div className={styles.field}>
        <Button
          variant="primary"
          disabled={busy || invalid !== null || offline || state === null}
          aria-describedby={invalid !== null || error !== null ? ids.error : undefined}
          onClick={() => void save()}
        >
          {t('settings.vacation.save')}
        </Button>
        {offline && <p className={styles.hint}>{t('settings.vacation.error.offline')}</p>}
      </div>
    </div>
  )
}

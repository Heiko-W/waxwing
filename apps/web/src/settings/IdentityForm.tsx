/**
 * The identity editor form (M5.1, FR-CMP-06).
 *
 * Owns its own draft state and hands the finished draft to `onSubmit`. The parent stays the one
 * that talks to the server, but it never has to mirror keystrokes — and remounting the form with a
 * `key` (the identity id, or `new`) is all it takes to switch which identity is being edited.
 *
 * The address of an existing identity is immutable (RFC 8621 §6), so the field is read-only when
 * editing and says why, rather than accepting an edit the server would reject as
 * `invalidProperties`.
 *
 * Both signatures are editable, and neither is derived from the other behind the user's back: a
 * server may well hold a hand-written `textSignature` that is not what `htmlSignature` would flatten
 * to (that is exactly what an admin-provisioned identity looks like), and silently overwriting it on
 * the first save would be data loss. The "take it from the HTML" button makes the derivation an
 * explicit choice.
 */

import type { TFunction } from 'i18next'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type EditorFactory,
  htmlToPlainText,
  RichTextEditor,
  type RichTextEditorHandle,
} from '../compose'
import { Button, TextInput } from '../ui'
import { type IdentityDraft, type IdentityProblem, validateIdentity } from './identity-model'
import styles from './settings.module.css'

/**
 * Spelled out rather than `t(\`settings.identities.error.\${problem}\`)`, because `guards.test.ts`
 * only sees LITERAL keys: a computed one passes every gate and then renders the key itself on
 * screen the day a translation is missing.
 */
function problemText(t: TFunction, problem: IdentityProblem): string {
  switch (problem) {
    case 'emailMissing':
      return t('settings.identities.error.emailMissing')
    case 'emailInvalid':
      return t('settings.identities.error.emailInvalid')
    case 'replyToInvalid':
      return t('settings.identities.error.replyToInvalid')
    case 'bccInvalid':
      return t('settings.identities.error.bccInvalid')
  }
}

export interface IdentityFormProps {
  readonly initial: IdentityDraft
  /** Creating adds the (immutable) address field; editing shows it read-only. */
  readonly creating: boolean
  readonly busy: boolean
  /** Already-translated failure text from the last save attempt, if any. */
  readonly saveError: string | null
  readonly onSubmit: (draft: IdentityDraft) => void
  readonly onCancel: () => void
  /** Injected in tests — the real editor lazy-loads Squire, which jsdom cannot run. */
  readonly editorFactory?: EditorFactory
}

export function IdentityForm(props: IdentityFormProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<IdentityDraft>(props.initial)
  // Mirrors `draft` so submit can read a just-flushed editor value without waiting for a render —
  // the same reason VacationSection keeps one: `flush()` emits through `onChange` synchronously.
  const draftRef = useRef<IdentityDraft>(props.initial)
  const editorRef = useRef<RichTextEditorHandle>(null)
  const ids = {
    email: useId(),
    emailHint: useId(),
    name: useId(),
    replyTo: useId(),
    bcc: useId(),
    textSignature: useId(),
    error: useId(),
  }

  const patch = (next: Partial<IdentityDraft>): void => {
    const merged = { ...draftRef.current, ...next }
    draftRef.current = merged
    setDraft(merged)
  }

  const problem: IdentityProblem | null = validateIdentity(draft, { creating: props.creating })
  const message = problem !== null ? problemText(t, problem) : props.saveError

  function submit(): void {
    // The editor debounces by 200 ms to keep typing off the parent's render path, so a user who
    // types a signature and reaches straight for Save would otherwise save the previous value.
    editorRef.current?.flush()
    const current = draftRef.current
    if (validateIdentity(current, { creating: props.creating }) !== null) return
    props.onSubmit(current)
  }

  return (
    // `.form`, not `.controls`: this editor is rendered as a ROW of the identities card, so a
    // `.controls` here drew a second bordered card inside that one. A form is also not a settings
    // list — it stacks, which is what puts its fields, its text box and its rich-text editor on the
    // one right edge they used to miss by 91px in two directions.
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.email}>
          {t('settings.identities.email.label')}
        </label>
        <TextInput
          id={ids.email}
          type="email"
          value={draft.email}
          readOnly={!props.creating}
          autoComplete="off"
          aria-describedby={props.creating ? undefined : ids.emailHint}
          invalid={problem === 'emailMissing' || problem === 'emailInvalid'}
          onChange={(event) => patch({ email: event.target.value })}
        />
        {!props.creating && (
          <p id={ids.emailHint} className={styles.hint}>
            {t('settings.identities.email.immutable')}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.name}>
          {t('settings.identities.name.label')}
        </label>
        <TextInput
          id={ids.name}
          value={draft.name}
          placeholder={t('settings.identities.name.placeholder')}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.replyTo}>
          {t('settings.identities.replyTo.label')}
        </label>
        <TextInput
          id={ids.replyTo}
          value={draft.replyTo}
          invalid={problem === 'replyToInvalid'}
          onChange={(event) => patch({ replyTo: event.target.value })}
        />
        <p className={styles.hint}>{t('settings.identities.replyTo.hint')}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.bcc}>
          {t('settings.identities.bcc.label')}
        </label>
        <TextInput
          id={ids.bcc}
          value={draft.bcc}
          invalid={problem === 'bccInvalid'}
          onChange={(event) => patch({ bcc: event.target.value })}
        />
        <p className={styles.hint}>{t('settings.identities.bcc.hint')}</p>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>{t('settings.identities.htmlSignature.label')}</span>
        <RichTextEditor
          ref={editorRef}
          value={draft.htmlSignature}
          onChange={(html) => patch({ htmlSignature: html })}
          ariaLabel={t('settings.identities.htmlSignature.label')}
          {...(props.editorFactory ? { factory: props.editorFactory } : {})}
        />
        <p className={styles.hint}>{t('settings.identities.htmlSignature.hint')}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.textSignature}>
          {t('settings.identities.textSignature.label')}
        </label>
        <textarea
          id={ids.textSignature}
          className={styles.textarea}
          rows={4}
          value={draft.textSignature}
          onChange={(event) => patch({ textSignature: event.target.value })}
        />
        <p className={styles.hint}>{t('settings.identities.textSignature.hint')}</p>
        {/* A direct child of the field, so it starts on the same left edge as the labels above it
            rather than 12px in from them behind a wrapper that did nothing else. */}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            editorRef.current?.flush()
            patch({ textSignature: htmlToPlainText(draftRef.current.htmlSignature) })
          }}
        >
          {t('settings.identities.textSignature.fromHtml')}
        </Button>
      </div>

      {message !== null && (
        <p id={ids.error} role="alert" className={styles.error}>
          {message}
        </p>
      )}

      <div className={styles.rowActions}>
        <Button
          type="submit"
          variant="primary"
          disabled={props.busy || problem !== null}
          aria-describedby={message !== null ? ids.error : undefined}
        >
          {props.creating
            ? t('settings.identities.create.submit')
            : t('settings.identities.edit.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onCancel} disabled={props.busy}>
          {t('settings.identities.cancel')}
        </Button>
      </div>
    </form>
  )
}

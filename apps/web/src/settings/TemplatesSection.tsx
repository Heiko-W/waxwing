/**
 * Settings → Templates (M5.5, FR-CMP-12).
 *
 * Stored per account in the local preferences, so this section is the only place they can be
 * created or edited — the composer inserts, it does not manage. The body is edited as plain text
 * and stored as simple HTML paragraphs: a second rich-text surface would have to carry the whole
 * sanitize/serialize contract the composer already owns, for a screen most users visit twice.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { plainTextToHtml } from '../compose/html-to-text'
import {
  coerceTemplates,
  MAX_TEMPLATES,
  type MessageTemplate,
  PLACEHOLDERS,
  removeTemplate,
  TEMPLATE_PREF_KEY,
  upsertTemplate,
} from '../compose/templates'
import { setPref, useLocalPref, useReplica } from '../sync'
import { Button, Dialog, TextInput } from '../ui'
import styles from './settings.module.css'

/** Renders stored HTML back to something editable in a textarea. */
function htmlToPlain(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return parsed.body.textContent ?? ''
}

export function TemplatesSection() {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const templates = coerceTemplates(useLocalPref<unknown>(TEMPLATE_PREF_KEY))
  const [editing, setEditing] = useState<MessageTemplate | null>(null)

  const save = async (next: readonly MessageTemplate[]): Promise<void> => {
    await setPref(db, accountId, TEMPLATE_PREF_KEY, [...next])
  }

  return (
    <div className={styles.controls}>
      <p className={styles.hint}>{t('settings.templates.description')}</p>
      <p className={styles.hint}>
        {t('settings.templates.placeholders', {
          list: PLACEHOLDERS.map((name) => `{{${name}}}`).join(', '),
        })}
      </p>

      {templates.length === 0 ? (
        <p className={styles.hint}>{t('settings.templates.empty')}</p>
      ) : (
        <ul className={styles.identityList}>
          {templates.map((entry) => (
            <li key={entry.id} className={styles.identityRow}>
              <div className={styles.identityText}>
                <span className={styles.identityName}>{entry.name}</span>
                <span className={styles.hint}>{entry.subject}</span>
              </div>
              <div className={styles.rowActions}>
                <Button variant="ghost" size="sm" onClick={() => setEditing(entry)}>
                  {t('settings.templates.edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void save(removeTemplate(templates, entry.id))}
                >
                  {t('settings.templates.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        disabled={templates.length >= MAX_TEMPLATES}
        onClick={() => setEditing({ id: crypto.randomUUID(), name: '', subject: '', body: '' })}
      >
        {t('settings.templates.add')}
      </Button>

      {editing !== null && (
        <TemplateDialog
          template={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(next) => {
            setEditing(null)
            void save(upsertTemplate(templates, next))
          }}
        />
      )}
    </div>
  )
}

interface TemplateDialogProps {
  readonly template: MessageTemplate
  onCancel: () => void
  onSubmit: (template: MessageTemplate) => void
}

function TemplateDialog(props: TemplateDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(props.template.name)
  const [subject, setSubject] = useState(props.template.subject)
  const [body, setBody] = useState(() => htmlToPlain(props.template.body))

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="md"
      title={t('settings.templates.dialogTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={props.onCancel}>
            {t('settings.templates.cancel')}
          </Button>
          <Button
            disabled={name.trim() === ''}
            onClick={() =>
              props.onSubmit({
                ...props.template,
                name: name.trim(),
                subject,
                // `plainTextToHtml` escapes, so a template body can never carry markup into a draft.
                body: plainTextToHtml(body),
              })
            }
          >
            {t('settings.templates.save')}
          </Button>
        </>
      }
    >
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-name">
            {t('settings.templates.name')}
          </label>
          <TextInput
            id="template-name"
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-subject">
            {t('settings.templates.subject')}
          </label>
          <TextInput
            id="template-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="template-body">
            {t('settings.templates.body')}
          </label>
          <textarea
            id="template-body"
            className={styles.textarea}
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Inserting a template into an open draft (M5.5, FR-CMP-12).
 *
 * Insertion goes through the composer store rather than the editor handle, and it is **additive**:
 * the template's body is appended to whatever is already written, and the subject is only filled in
 * when it is still empty. Replacing would be the obvious implementation and the wrong one — a
 * template picked by mistake would silently discard a half-written message.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '../i18n/formatters'
import { useLocalPrefOptional } from '../sync'
import { useComposerStore } from './composer-store'
import {
  applyTemplate,
  coerceTemplates,
  type MessageTemplate,
  TEMPLATE_PREF_KEY,
} from './templates'

export interface TemplateInserter {
  readonly templates: readonly MessageTemplate[]
  /** Appends `template` to the draft, filling its placeholders from that draft's state. */
  insert(draftId: string, template: MessageTemplate): void
}

export function useTemplates(): TemplateInserter {
  const { t } = useTranslation()
  const stored = useLocalPrefOptional<unknown>(TEMPLATE_PREF_KEY)
  const templates = coerceTemplates(stored)

  const insert = useCallback(
    (draftId: string, template: MessageTemplate): void => {
      const store = useComposerStore.getState()
      const draft = store.drafts.get(draftId)
      if (draft === undefined) return

      const context = {
        // The first recipient is the one a greeting means; with several, a template that addresses
        // one of them by name is the user's choice to make, not ours to refuse.
        recipient: draft.to[0] ?? null,
        senderName: t('settings.templates.defaultSenderName'),
        date: formatDate(new Date(), { dateStyle: 'long' }),
      }

      const body = applyTemplate(template.body, context)
      // Appended, never replaced: a mis-clicked template must not discard a half-written message.
      store.updateBody(draftId, draft.body === '' ? body : `${draft.body}${body}`)
      if (draft.subject === '' && template.subject !== '') {
        store.updateSubject(draftId, applyTemplate(template.subject, context))
      }
    },
    [t],
  )

  return { templates, insert }
}

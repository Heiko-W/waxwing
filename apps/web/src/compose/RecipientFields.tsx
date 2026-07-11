/**
 * The composer's recipient block (M2.4, FR-CMP-05): the To field is always shown; Cc and Bcc are
 * behind compact toggles and auto-revealed when they already hold addresses (a reply-all seeds Cc).
 * Builds the default suggestion source from the replica (recents), or an empty source when none is
 * available; a "did you mean …?" hint appears under To for a domain typo in the last address.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReplicaOptional } from '../sync'
import {
  type DraftWindow,
  type RecipientField as RecipientFieldName,
  useComposerStore,
} from './composer-store'
import { RecipientField } from './RecipientField'
import styles from './recipient-field.module.css'
import {
  createRecentsSuggestionSource,
  EMPTY_SUGGESTION_SOURCE,
  type RecipientSuggestionSource,
} from './recipient-suggestions'
import { suggestDomainCorrection } from './typo-heuristic'

const LABEL_KEY: Record<RecipientFieldName, string> = {
  to: 'compose.toLabel',
  cc: 'compose.ccLabel',
  bcc: 'compose.bccLabel',
}
const ALL_FIELDS = ['to', 'cc', 'bcc'] as const

export interface RecipientFieldsProps {
  readonly draft: DraftWindow
  /** Injected in tests; production builds a recents source from the replica. */
  readonly suggestionSource?: RecipientSuggestionSource | undefined
}

export function RecipientFields({ draft, suggestionSource }: RecipientFieldsProps) {
  const { t } = useTranslation()
  const setRecipients = useComposerStore((state) => state.setRecipients)
  const moveRecipient = useComposerStore((state) => state.moveRecipient)
  const replica = useReplicaOptional()

  const source = useMemo<RecipientSuggestionSource>(() => {
    if (suggestionSource !== undefined) return suggestionSource
    return replica !== null
      ? createRecentsSuggestionSource(replica.db, replica.accountId)
      : EMPTY_SUGGESTION_SOURCE
  }, [suggestionSource, replica])

  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const ccVisible = showCc || draft.cc.length > 0
  const bccVisible = showBcc || draft.bcc.length > 0

  const renderField = (field: RecipientFieldName) => (
    <RecipientField
      field={field}
      label={t(LABEL_KEY[field])}
      value={draft[field]}
      source={source}
      onChange={(addrs) => setRecipients(draft.id, field, addrs)}
      onMove={(index, to) => moveRecipient(draft.id, field, to, index)}
      otherFields={ALL_FIELDS.filter((candidate) => candidate !== field)}
    />
  )

  const lastTo = draft.to[draft.to.length - 1]
  const suggestion = useMemo(
    () => (lastTo ? suggestDomainCorrection(lastTo.email) : null),
    [lastTo],
  )

  const applySuggestion = (): void => {
    const index = draft.to.length - 1
    const last = draft.to[index]
    if (suggestion === null || last === undefined) return
    const next = [...draft.to]
    next[index] = { ...last, email: suggestion }
    setRecipients(draft.id, 'to', next)
  }

  return (
    <div className={styles.fields}>
      {renderField('to')}
      {suggestion !== null && (
        <p className={styles.didYouMean}>
          {t('compose.recipientDidYouMean', { suggestion })}{' '}
          <button type="button" className={styles.didYouMeanApply} onClick={applySuggestion}>
            {t('compose.recipientDidYouMeanApply', { suggestion })}
          </button>
        </p>
      )}
      {(!ccVisible || !bccVisible) && (
        <div className={styles.fieldToggles}>
          {!ccVisible && (
            <button type="button" className={styles.fieldToggle} onClick={() => setShowCc(true)}>
              {t('compose.showCcField')}
            </button>
          )}
          {!bccVisible && (
            <button type="button" className={styles.fieldToggle} onClick={() => setShowBcc(true)}>
              {t('compose.showBccField')}
            </button>
          )}
        </div>
      )}
      {ccVisible && renderField('cc')}
      {bccVisible && renderField('bcc')}
    </div>
  )
}

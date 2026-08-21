/**
 * The composer's recipient block (M2.4, FR-CMP-05): the To field is always shown; Cc and Bcc are
 * behind compact toggles and auto-revealed when they already hold addresses (a reply-all seeds Cc).
 * Builds the default suggestion source from the replica (recents), or an empty source when none is
 * available; a "did you mean …?" hint appears under To for a domain typo in the last address.
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ContactCardRow, useReplicaOptional } from '../sync'
import { Button } from '../ui'
import {
  type AddressField,
  type DraftWindow,
  type RecipientField as RecipientFieldName,
  useComposerStore,
} from './composer-store'
import { createContactSuggestionSource } from './contact-suggestion-source'
import { RecipientField } from './RecipientField'
import styles from './recipient-field.module.css'
import {
  combineSuggestionSources,
  createRecentsSuggestionSource,
  EMPTY_SUGGESTION_SOURCE,
  type RecipientSuggestionSource,
} from './recipient-suggestions'
import { suggestDomainCorrection } from './typo-heuristic'

const LABEL_KEY: Record<AddressField, string> = {
  to: 'compose.toLabel',
  cc: 'compose.ccLabel',
  bcc: 'compose.bccLabel',
  replyTo: 'compose.replyToLabel',
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

  // The account's contact cards, provider-SAFE (mirrors `useLocalPrefOptional`): the composer is
  // unit-tested WITHOUT a `ReplicaProvider`, where the throwing `useAccountContactCards` (M4.2) would
  // crash it. `undefined` while the first query resolves OR when there is no replica — the source then
  // falls back to recents only, never a blank/broken field. Deps are the stable db+accountId, so a
  // keystroke does not re-run this and a `contactCards` write is the ONLY thing that re-emits.
  const cards = useLiveQuery<ContactCardRow[] | undefined>(
    () =>
      replica === null
        ? Promise.resolve(undefined)
        : replica.db.contactCards.where('accountId').equals(replica.accountId).toArray(),
    [replica?.db, replica?.accountId],
  )

  const source = useMemo<RecipientSuggestionSource>(() => {
    if (suggestionSource !== undefined) return suggestionSource
    if (replica === null) return EMPTY_SUGGESTION_SOURCE
    const recents = createRecentsSuggestionSource(replica.db, replica.accountId)
    if (cards === undefined || cards.length === 0) return recents
    // Contacts FIRST: the merge dedups by lowercased email keeping the first, so a contact wins over a
    // stale recent for the same address (proper name + photo instead of a harvested envelope name).
    const contacts = createContactSuggestionSource(cards, {
      db: replica.db,
      accountId: replica.accountId,
    })
    return combineSuggestionSources([contacts, recents])
  }, [suggestionSource, replica, cards])

  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [showReplyTo, setShowReplyTo] = useState(false)
  const ccVisible = showCc || draft.cc.length > 0
  const bccVisible = showBcc || draft.bcc.length > 0
  // Reply-To (M-11) joins Cc and Bcc behind the same toggle row rather than moving into the send
  // options sheet, because it IS an address: it belongs with the other addresses, edited by the
  // same pill widget, and a writer looking for "where do replies go" looks at the header block.
  // It auto-reveals when it already holds one, so a reopened draft never hides a choice already made.
  const replyToVisible = showReplyTo || draft.replyTo.length > 0

  const renderField = (field: RecipientFieldName) => (
    <RecipientField
      field={field}
      label={t(LABEL_KEY[field])}
      value={draft[field]}
      source={source}
      accountId={replica?.accountId}
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
      {(!ccVisible || !bccVisible || !replyToVisible) && (
        <div className={styles.fieldToggles}>
          {/* Second grid column, so these line up under the entry box rather than under the label —
              see `.fieldToggles` for why hardcoding the offset kept getting it wrong. */}
          <div className={styles.fieldToggleGroup}>
            {!ccVisible && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.fieldToggle}
                onClick={() => setShowCc(true)}
              >
                {t('compose.showCcField')}
              </Button>
            )}
            {!bccVisible && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.fieldToggle}
                onClick={() => setShowBcc(true)}
              >
                {t('compose.showBccField')}
              </Button>
            )}
            {!replyToVisible && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.fieldToggle}
                onClick={() => setShowReplyTo(true)}
              >
                {t('compose.showReplyToField')}
              </Button>
            )}
          </div>
        </div>
      )}
      {ccVisible && renderField('cc')}
      {bccVisible && renderField('bcc')}
      {replyToVisible && (
        <RecipientField
          field="replyTo"
          label={t(LABEL_KEY.replyTo)}
          value={draft.replyTo}
          source={source}
          accountId={replica?.accountId}
          onChange={(addrs) => setRecipients(draft.id, 'replyTo', addrs)}
          // Never movable: Reply-To is not a recipient, so "move to Cc" from here would be a
          // promise to deliver somewhere. An empty list hides the pill menu (RecipientField:268).
          onMove={() => {}}
          otherFields={[]}
        />
      )}
    </div>
  )
}

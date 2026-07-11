/**
 * `compose/` — the message composer (M2). M2.1 ships the rich-text editor: the {@link RichTextEditor}
 * React wrapper over the swappable {@link EditorEngine} seam, plus the pure HTML↔text helpers used
 * for the plain-text alternative and outgoing-HTML hygiene. M2.2 adds the parallel-draft composer:
 * the module-scoped {@link useComposerStore} and the {@link NewMessageButton} trigger. The docked
 * `ComposerHost` is intentionally NOT re-exported here — it is loaded only via a lazy `import()`.
 */

export {
  formatAddress,
  isPlausibleEmail,
  parseAddressList,
} from './address-validation'
export { cleanOutgoingHtml } from './clean-html'
export {
  type ComposerActions,
  type ComposerStore,
  type DraftMode,
  type DraftWindow,
  MAX_OPEN,
  type OpenDraftInit,
  type RecipientField,
  useComposerStore,
} from './composer-store'
export {
  deserializeDraft,
  isEmptyDraft,
  serializeDraft,
  toDraftInit,
  toEmailCreate,
} from './draft-email'
export type { ActiveFormats, EditorEngine, EditorFactory } from './editor-engine'
export { FromField } from './FromField'
export { htmlToPlainText, plainTextToHtml } from './html-to-text'
export { NEW_MESSAGE_BTN_ID, NewMessageButton } from './NewMessageButton'
export { RecipientFields, type RecipientFieldsProps } from './RecipientFields'
export { RichTextEditor, type RichTextEditorProps } from './RichTextEditor'
export {
  combineSuggestionSources,
  createRecentsSuggestionSource,
  EMPTY_SUGGESTION_SOURCE,
  type RecipientSuggestionSource,
  scoreAddressStat,
} from './recipient-suggestions'
export {
  buildReplyDraft,
  type DraftAttachment,
  deriveRecipients,
  forwardAttachments,
  forwardBody,
  inferFromIdentity,
  ownAddresses,
  quoteBody,
  type ReplyDraftInit,
  type ReplyKind,
  type ReplySource,
  replySubject,
  stripSubjectPrefix,
  threadingHeaders,
} from './reply'
export {
  applySignature,
  pickDefaultIdentity,
  replaceSignature,
  SIGNATURE_ATTR,
  type SignaturePlacement,
  signatureHtmlForIdentity,
} from './signature'
export { COMMON_EMAIL_DOMAINS, suggestDomainCorrection } from './typo-heuristic'
export { useDraftAutosave } from './use-draft-autosave'
export { type DraftOpener, useDraftOpener } from './use-draft-opener'
export { useDraftRestore } from './use-draft-restore'
export { type DraftSync, useDraftSync } from './use-draft-sync'

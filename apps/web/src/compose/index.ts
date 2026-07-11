/**
 * `compose/` — the message composer (M2). M2.1 ships the rich-text editor: the {@link RichTextEditor}
 * React wrapper over the swappable {@link EditorEngine} seam, plus the pure HTML↔text helpers used
 * for the plain-text alternative and outgoing-HTML hygiene. M2.2 adds the parallel-draft composer:
 * the module-scoped {@link useComposerStore} and the {@link NewMessageButton} trigger. The docked
 * `ComposerHost` is intentionally NOT re-exported here — it is loaded only via a lazy `import()`.
 */

export { cleanOutgoingHtml } from './clean-html'
export {
  type ComposerStore,
  type DraftMode,
  type DraftWindow,
  MAX_OPEN,
  useComposerStore,
} from './composer-store'
export type { ActiveFormats, EditorEngine, EditorFactory } from './editor-engine'
export { htmlToPlainText, plainTextToHtml } from './html-to-text'
export { NEW_MESSAGE_BTN_ID, NewMessageButton } from './NewMessageButton'
export { RichTextEditor, type RichTextEditorProps } from './RichTextEditor'
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

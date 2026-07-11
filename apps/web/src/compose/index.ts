/**
 * `compose/` — the message composer (M2). M2.1 ships the rich-text editor: the {@link RichTextEditor}
 * React wrapper over the swappable {@link EditorEngine} seam, plus the pure HTML↔text helpers used
 * for the plain-text alternative and outgoing-HTML hygiene.
 */

export { cleanOutgoingHtml } from './clean-html'
export type { ActiveFormats, EditorEngine, EditorFactory } from './editor-engine'
export { htmlToPlainText, plainTextToHtml } from './html-to-text'
export { RichTextEditor, type RichTextEditorProps } from './RichTextEditor'

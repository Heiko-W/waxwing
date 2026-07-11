/**
 * The compose editor seam (M2.1, FR-CMP-01; tech-stack §8 "wrap behind our own component API so it
 * stays swappable"). {@link EditorEngine} is the NARROW surface the React wrapper + toolbar drive —
 * exactly the Squire operations we use, nothing more — so Squire never leaks into the UI and a test
 * can inject a fake engine (jsdom has no real `contenteditable`/selection). {@link defaultEditorFactory}
 * dynamically imports the real Squire adapter, keeping squire-rte + DOMPurify out of the entry chunk.
 */

/** Which inline/block formats are active at the caret — drives the toolbar's pressed state. */
export interface ActiveFormats {
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly unorderedList: boolean
  readonly orderedList: boolean
  readonly quote: boolean
  readonly link: boolean
}

export const NO_ACTIVE_FORMATS: ActiveFormats = {
  bold: false,
  italic: false,
  underline: false,
  unorderedList: false,
  orderedList: false,
  quote: false,
  link: false,
}

/** The operations the wrapper/toolbar call on the underlying editor (a subset of Squire's API). */
export interface EditorEngine {
  getHTML(): string
  setHTML(html: string): void
  focus(): void
  destroy(): void
  bold(): void
  removeBold(): void
  italic(): void
  removeItalic(): void
  underline(): void
  removeUnderline(): void
  makeUnorderedList(): void
  makeOrderedList(): void
  removeList(): void
  increaseQuoteLevel(): void
  decreaseQuoteLevel(): void
  makeLink(url: string): void
  removeLink(): void
  setFontSize(size: string | null): void
  hasFormat(tag: string): boolean
  getPath(): string
  addEventListener(type: string, handler: (event: Event) => void): void
  removeEventListener(type: string, handler: (event: Event) => void): void
}

/** Creates an engine bound to a contenteditable root. Async so the default can lazy-load Squire. */
export type EditorFactory = (root: HTMLElement) => Promise<EditorEngine>

/** Derive the toolbar's active-format state from an engine's current selection. */
export function readActiveFormats(engine: EditorEngine): ActiveFormats {
  const tags = new Set(
    engine
      .getPath()
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean),
  )
  return {
    bold: engine.hasFormat('B'),
    italic: engine.hasFormat('I'),
    underline: engine.hasFormat('U'),
    unorderedList: tags.has('UL'),
    orderedList: tags.has('OL'),
    quote: tags.has('BLOCKQUOTE'),
    link: engine.hasFormat('A'),
  }
}

/**
 * Default engine factory: dynamically imports the Squire adapter so squire-rte AND DOMPurify are
 * emitted in a separate lazy chunk (never in the entry `index-*.js` measured by size-limit).
 */
export const defaultEditorFactory: EditorFactory = async (root) => {
  const { createSquireEngine } = await import('./squire-adapter')
  return createSquireEngine(root)
}

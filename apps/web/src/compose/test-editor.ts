/**
 * A fake {@link EditorEngine} for tests (extracted in M3.7, when the vacation responder became the
 * editor's second consumer). jsdom has no real contenteditable and no selection, and the real engine
 * lazy-loads Squire — so every editor test injects this double instead.
 */

import { vi } from 'vitest'
import type { EditorEngine, EditorFactory } from './editor-engine'

export interface FakeEngine extends EditorEngine {
  html: string
  destroyed: boolean
  readonly formats: Set<string>
  path: string
  emit(type: string): void
}

export function createFakeEngine(): FakeEngine {
  const listeners = new Map<string, Array<(event: Event) => void>>()
  const fake: FakeEngine = {
    html: '',
    destroyed: false,
    formats: new Set<string>(),
    path: '',
    getHTML: () => fake.html,
    setHTML: (html) => {
      fake.html = html
    },
    focus: vi.fn(),
    destroy: () => {
      fake.destroyed = true
    },
    bold: vi.fn(),
    removeBold: vi.fn(),
    italic: vi.fn(),
    removeItalic: vi.fn(),
    underline: vi.fn(),
    removeUnderline: vi.fn(),
    makeUnorderedList: vi.fn(),
    makeOrderedList: vi.fn(),
    removeList: vi.fn(),
    increaseQuoteLevel: vi.fn(),
    decreaseQuoteLevel: vi.fn(),
    makeLink: vi.fn(),
    removeLink: vi.fn(),
    insertImage: vi.fn(),
    setFontSize: vi.fn(),
    hasFormat: (tag) => fake.formats.has(tag),
    getPath: () => fake.path,
    addEventListener: (type, handler) => {
      const arr = listeners.get(type) ?? []
      arr.push(handler)
      listeners.set(type, arr)
    },
    removeEventListener: (type, handler) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((fn) => fn !== handler),
      )
    },
    emit: (type) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(new Event(type))
    },
  }
  return fake
}

/** An {@link EditorFactory} resolving to a fresh {@link createFakeEngine}. */
export function fakeEditorFactory(engine: FakeEngine = createFakeEngine()): EditorFactory {
  return () => Promise.resolve(engine)
}

/**
 * HTML escaping (M1.7). Used by the plain-text renderer and anywhere the package emits text into
 * the mail document. Escaping the five significant characters is sufficient for text nodes and for
 * double/single-quoted attribute values.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character)
}

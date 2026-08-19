/**
 * Message templates / canned responses (M5.5, FR-CMP-12).
 *
 * Stored **client-side**, in the account-scoped local preferences, which is one of the two shapes
 * the spec allows. The other — drafts in a dedicated folder — was not chosen: a template is not a
 * message, it has no recipient and no send date, and parking one in Drafts means every other mail
 * client on the account shows an unfinished message the user has to learn to ignore.
 *
 * The cost is honest and worth naming: templates do not follow the user to another device. That is
 * the trade for not putting non-messages in a mailbox.
 *
 * **Placeholders are substituted, not evaluated.** `{{date}}` and `{{recipientName}}` are replaced
 * by plain strings, and an unknown placeholder is left exactly as it stands rather than blanked —
 * a template that silently loses `{{invoiceNo}}` is worse than one that visibly did not fill it in.
 */

import type { EmailAddress } from '@waxwing/jmap'

export const TEMPLATE_PREF_KEY = 'compose.templates'

/** How many a single account may keep; a guard against an unbounded preference row. */
export const MAX_TEMPLATES = 50

export interface MessageTemplate {
  readonly id: string
  readonly name: string
  readonly subject: string
  /** HTML, as the composer stores a body. */
  readonly body: string
}

/** The placeholders a template may use. */
export const PLACEHOLDERS = ['recipientName', 'recipientEmail', 'date', 'myName'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

/** What the placeholders resolve against at insert time. */
export interface TemplateContext {
  readonly recipient: EmailAddress | null
  readonly senderName: string
  /** Pre-formatted in the active locale — this module does no formatting of its own. */
  readonly date: string
}

/**
 * Reads the stored list, tolerating anything.
 *
 * A preference row is user-editable in principle (it is a database another client could write) and
 * survives across versions, so a shape we do not recognise must not crash the composer.
 */
export function coerceTemplates(value: unknown): MessageTemplate[] {
  if (!Array.isArray(value)) return []
  const out: MessageTemplate[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const raw = candidate as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    out.push({
      id: raw.id,
      name: raw.name,
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      body: typeof raw.body === 'string' ? raw.body : '',
    })
  }
  return out.slice(0, MAX_TEMPLATES)
}

/** The value for one placeholder, or `null` when this context cannot fill it. */
function resolve(name: string, context: TemplateContext): string | null {
  switch (name as Placeholder) {
    case 'recipientName':
      // Falls back to the address: "Dear {{recipientName}}" with an empty name reads as an error,
      // while the address at least addresses somebody.
      return context.recipient?.name ?? context.recipient?.email ?? null
    case 'recipientEmail':
      return context.recipient?.email ?? null
    case 'date':
      return context.date
    case 'myName':
      return context.senderName
    default:
      return null
  }
}

/** Matches `{{name}}`, tolerating inner whitespace. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g

/**
 * Substitutes the placeholders in `text`.
 *
 * An unresolvable placeholder is left standing, so the user sees what did not get filled in rather
 * than a gap where a name should be.
 */
export function applyTemplate(text: string, context: TemplateContext): string {
  return text.replace(PLACEHOLDER_RE, (match, name: string) => resolve(name, context) ?? match)
}

/** Adds or replaces a template, capped at {@link MAX_TEMPLATES}. */
export function upsertTemplate(
  templates: readonly MessageTemplate[],
  template: MessageTemplate,
): MessageTemplate[] {
  const existing = templates.findIndex((entry) => entry.id === template.id)
  if (existing >= 0) return templates.map((entry, i) => (i === existing ? template : entry))
  return [...templates, template].slice(0, MAX_TEMPLATES)
}

export function removeTemplate(
  templates: readonly MessageTemplate[],
  id: string,
): MessageTemplate[] {
  return templates.filter((entry) => entry.id !== id)
}

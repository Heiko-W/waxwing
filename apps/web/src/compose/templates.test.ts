/**
 * Message templates (M5.5, FR-CMP-12).
 *
 * The substitution rules carry this file: an unknown placeholder must survive rather than vanish,
 * and a stored list of any shape must not be able to crash the composer.
 */

import { describe, expect, it } from 'vitest'
import {
  applyTemplate,
  coerceTemplates,
  MAX_TEMPLATES,
  type MessageTemplate,
  removeTemplate,
  type TemplateContext,
  upsertTemplate,
} from './templates'

const context: TemplateContext = {
  recipient: { name: 'Ada Lovelace', email: 'ada@example.test' },
  senderName: 'Alice',
  date: '19 August 2026',
}

const template = (over: Partial<MessageTemplate> = {}): MessageTemplate => ({
  id: 't1',
  name: 'Thanks',
  subject: 'Thank you',
  body: '<p>Hello</p>',
  ...over,
})

describe('applyTemplate', () => {
  it('fills the placeholders it knows', () => {
    expect(applyTemplate('Dear {{recipientName}}, on {{date}} — {{myName}}', context)).toBe(
      'Dear Ada Lovelace, on 19 August 2026 — Alice',
    )
  })

  it('tolerates whitespace inside the braces', () => {
    expect(applyTemplate('{{ recipientEmail }}', context)).toBe('ada@example.test')
  })

  it('LEAVES an unknown placeholder standing rather than blanking it', () => {
    // A template that silently loses {{invoiceNo}} sends a message with a hole in it; one that
    // shows the placeholder tells the user what they still have to fill in.
    expect(applyTemplate('Ref {{invoiceNo}}', context)).toBe('Ref {{invoiceNo}}')
  })

  it('falls back to the address when the recipient has no name', () => {
    const anonymous = { ...context, recipient: { name: null, email: 'x@y.test' } }
    expect(applyTemplate('Dear {{recipientName}}', anonymous)).toBe('Dear x@y.test')
  })

  it('leaves the placeholder standing when there is no recipient at all', () => {
    const none = { ...context, recipient: null }
    expect(applyTemplate('Dear {{recipientName}}', none)).toBe('Dear {{recipientName}}')
  })

  it('substitutes every occurrence', () => {
    expect(applyTemplate('{{myName}} and {{myName}}', context)).toBe('Alice and Alice')
  })
})

describe('coerceTemplates', () => {
  it('reads a well-formed list', () => {
    expect(coerceTemplates([template()])).toEqual([template()])
  })

  it('returns nothing for a value that is not a list', () => {
    for (const value of [null, undefined, 42, 'x', {}]) {
      expect(coerceTemplates(value)).toEqual([])
    }
  })

  it('skips entries without an id or a name instead of throwing', () => {
    expect(coerceTemplates([{ id: 't' }, { name: 'n' }, null, template()])).toEqual([template()])
  })

  it('defaults a missing subject and body to empty strings', () => {
    expect(coerceTemplates([{ id: 't', name: 'n' }])).toEqual([
      { id: 't', name: 'n', subject: '', body: '' },
    ])
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_TEMPLATES + 10 }, (_, i) => template({ id: `t${i}` }))
    expect(coerceTemplates(many)).toHaveLength(MAX_TEMPLATES)
  })
})

describe('upsertTemplate / removeTemplate', () => {
  it('replaces by id rather than appending a duplicate', () => {
    const updated = upsertTemplate([template()], template({ name: 'Renamed' }))
    expect(updated).toHaveLength(1)
    expect(updated[0]?.name).toBe('Renamed')
  })

  it('appends a new one', () => {
    expect(upsertTemplate([template()], template({ id: 't2' }))).toHaveLength(2)
  })

  it('removes by id', () => {
    expect(removeTemplate([template(), template({ id: 't2' })], 't1')).toEqual([
      template({ id: 't2' }),
    ])
  })
})

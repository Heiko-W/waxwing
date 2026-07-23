/**
 * The vCard syntax layer (M4.1, RFC 6350 §3). Every case here is one that fails SILENTLY: the file
 * still parses, the contact still has a name, and the damage surfaces three screens later as a
 * stray backslash or a mangled character in someone's surname.
 */

import { describe, expect, it } from 'vitest'
import { parseContentLines } from './lex'
import {
  escapeText,
  listValues,
  splitList,
  splitStructured,
  structuredComponents,
  unescapeText,
} from './value'
import { escapeParam, FOLD_OCTETS, foldLine, joinStructured, renderCard, renderLine } from './write'

const crlf = (...lines: string[]) => `${lines.join('\r\n')}\r\n`

describe('unfolding', () => {
  it('rejoins a folded line and eats exactly one whitespace character', () => {
    const { lines } = parseContentLines(crlf('BEGIN:VCARD', 'NOTE:hello', ' world', 'END:VCARD'))
    expect(lines.find((l) => l.name === 'NOTE')?.value).toBe('helloworld')
  })

  /**
   * The case a "strip the break and following whitespace" implementation gets wrong. An address
   * folded mid-value legitimately continues with a space, and eating both would join two words.
   */
  it('preserves a second leading space on a continuation line', () => {
    const { lines } = parseContentLines(crlf('NOTE:hello', '  world'))
    expect(lines[0]?.value).toBe('hello world')
  })

  it('accepts LF and CR line endings, not only CRLF', () => {
    for (const eol of ['\r\n', '\n', '\r']) {
      const text = ['BEGIN:VCARD', 'FN:Anna Meier', 'END:VCARD'].join(eol)
      const { lines } = parseContentLines(text)
      expect(lines.find((l) => l.name === 'FN')?.value).toBe('Anna Meier')
    }
  })

  it('unfolds a tab continuation, consuming the tab itself', () => {
    // §3.2 allows space OR horizontal tab as the fold character, and it is part of the FOLD, not of
    // the value — exactly like the space case above, which is why this joins with no gap.
    const { lines } = parseContentLines('NOTE:hello\r\n\tworld\r\n')
    expect(lines[0]?.value).toBe('helloworld')
  })

  /** Outlook and anything Excel has touched. Without this the first property is named `\uFEFFBEGIN`. */
  it('strips a UTF-8 BOM', () => {
    const { lines } = parseContentLines(`\uFEFF${crlf('BEGIN:VCARD', 'FN:Anna')}`)
    expect(lines[0]?.name).toBe('BEGIN')
  })
})

describe('content lines', () => {
  it('upper-cases the property name and the parameter keys', () => {
    const { lines } = parseContentLines(crlf('email;type=work:anna@example.test'))
    expect(lines[0]?.name).toBe('EMAIL')
    expect(lines[0]?.params.get('TYPE')).toEqual(['work'])
  })

  /**
   * Apple's custom labels ride on group prefixes: `item1.TEL` beside `item1.X-ABLabel`. Dropping the
   * prefix turns every custom label into an unlabelled field — data loss the user can see.
   */
  it('keeps the group prefix', () => {
    const { lines } = parseContentLines(crlf('item1.TEL:+49 123', 'item1.X-ABLabel:Ferienhaus'))
    expect(lines[0]).toMatchObject({ group: 'item1', name: 'TEL' })
    expect(lines[1]).toMatchObject({ group: 'item1', name: 'X-ABLABEL' })
  })

  it('splits at the value colon, not inside a quoted parameter', () => {
    const { lines } = parseContentLines(crlf('TEL;TYPE="work:main":+49 123'))
    expect(lines[0]?.name).toBe('TEL')
    expect(lines[0]?.params.get('TYPE')).toEqual(['work:main'])
    expect(lines[0]?.value).toBe('+49 123')
  })

  it('merges a repeated parameter and a comma list into one bucket', () => {
    const { lines } = parseContentLines(crlf('TEL;TYPE=work,voice;TYPE=cell:+49 123'))
    expect(lines[0]?.params.get('TYPE')).toEqual(['work', 'voice', 'cell'])
  })

  /** vCard 3.0 shorthand, still emitted by plenty of exporters: `TEL;WORK:` means `TYPE=WORK`. */
  it('reads a valueless parameter as a TYPE value', () => {
    const { lines } = parseContentLines(crlf('TEL;WORK;VOICE:+49 123'))
    expect(lines[0]?.params.get('TYPE')).toEqual(['WORK', 'VOICE'])
  })

  it('applies RFC 6868 unescaping to parameter values', () => {
    const { lines } = parseContentLines(crlf('ADR;LABEL="Haus^n1. Stock":;;Weg 1;;;;'))
    expect(lines[0]?.params.get('LABEL')).toEqual(['Haus\n1. Stock'])
  })

  /**
   * A 400-contact export with one broken line must import 399 contacts, not zero — and must SAY it
   * dropped one. Silent partial success is its own defect.
   */
  it('skips a line with no colon and reports it', () => {
    const { lines, skipped } = parseContentLines(
      crlf('FN:Anna', 'THIS IS NOT A LINE', 'N:Meier;Anna;;;'),
    )
    expect(lines.map((l) => l.name)).toEqual(['FN', 'N'])
    expect(skipped).toEqual([{ line: 2, text: 'THIS IS NOT A LINE', reason: 'noColon' }])
  })

  it('skips a line with an empty property name', () => {
    const { skipped } = parseContentLines(crlf(':value'))
    expect(skipped[0]?.reason).toBe('emptyName')
  })
})

describe('escaping', () => {
  it('round-trips the four escapes', () => {
    const value = 'a,b;c\\d\ne'
    expect(unescapeText(escapeText(value))).toBe(value)
  })

  it('reads \\N as a newline, like \\n', () => {
    expect(unescapeText('line1\\Nline2')).toBe('line1\nline2')
  })

  /**
   * §3.4 defines escapes for exactly four characters. Inventing more — reading `\t` as a tab —
   * corrupts every value that legitimately contains a backslash, which is every Windows path
   * anyone ever pasted into a note field.
   */
  it('leaves a backslash before anything else literal', () => {
    expect(unescapeText('C:\\\\temp\\x')).toBe('C:\\temp\\x')
  })

  it('keeps a trailing lone backslash rather than dropping it', () => {
    expect(unescapeText('trailing\\')).toBe('trailing\\')
  })

  it('collapses CRLF to a single escaped newline', () => {
    expect(escapeText('a\r\nb')).toBe('a\\nb')
  })
})

describe('structured values', () => {
  it('splits N into its five components', () => {
    expect(structuredComponents('Meier;Anna;Maria;Dr.;MBA')).toEqual([
      'Meier',
      'Anna',
      'Maria',
      'Dr.',
      'MBA',
    ])
  })

  it('splits ADR into its seven components, empty ones included', () => {
    expect(structuredComponents(';;Hauptstr. 1;Verl;NRW;33415;Deutschland')).toHaveLength(7)
  })

  it('does not split on an escaped semicolon', () => {
    expect(structuredComponents('Meier\\; Anna;Dr.')).toEqual(['Meier; Anna', 'Dr.'])
  })

  /**
   * **The case that decides the split-then-unescape order.** `\\;` is a LITERAL backslash followed
   * by a separator. Unescaping first turns it into `\;`, which then reads as an escaped semicolon
   * and swallows the next component — a Windows path in an address field eating the town name.
   */
  it('splits after an escaped backslash', () => {
    expect(splitStructured('C:\\\\;Verl')).toEqual(['C:\\\\', 'Verl'])
    expect(structuredComponents('C:\\\\;Verl')).toEqual(['C:\\', 'Verl'])
  })

  it('splits multi-value components on unescaped commas only', () => {
    expect(listValues('Anna,Maria')).toEqual(['Anna', 'Maria'])
    expect(listValues('Meier\\, Anna')).toEqual(['Meier, Anna'])
    expect(splitList('a\\\\,b')).toEqual(['a\\\\', 'b'])
  })
})

describe('folding', () => {
  const encoder = new TextEncoder()

  it('leaves a short line alone', () => {
    expect(foldLine('FN:Anna')).toBe('FN:Anna')
  })

  it('folds at the octet limit with CRLF + one space', () => {
    const folded = foldLine(`NOTE:${'a'.repeat(200)}`)
    for (const physical of folded.split('\r\n')) {
      expect(encoder.encode(physical).length).toBeLessThanOrEqual(FOLD_OCTETS)
    }
    expect(folded).toContain('\r\n ')
  })

  /**
   * **Octets, not code units.** A `slice(0, 75)` on a line of `ü` folds at 75 CHARACTERS = 150
   * octets, well over the limit — and worse, can cut a multi-byte character in half and produce a
   * file that is no longer valid UTF-8. It is invisible in a diff.
   */
  it('counts multi-byte characters as their UTF-8 length', () => {
    const folded = foldLine(`NOTE:${'ü'.repeat(100)}`)
    for (const physical of folded.split('\r\n')) {
      expect(encoder.encode(physical).length).toBeLessThanOrEqual(FOLD_OCTETS)
    }
  })

  it('never splits a surrogate pair', () => {
    const folded = foldLine(`NOTE:${'👍'.repeat(40)}`)
    expect(folded).not.toContain('\uFFFD')
    // Re-decoding each physical line must yield no lone surrogates.
    for (const physical of folded.split('\r\n')) {
      expect(physical).toBe(new TextDecoder().decode(encoder.encode(physical)))
    }
  })

  /** Fold and unfold are inverses. This is the assertion that keeps the two halves honest. */
  it('round-trips through the parser for every awkward width', () => {
    for (const length of [1, 60, 74, 75, 76, 149, 150, 151, 500]) {
      const value = 'x'.repeat(length)
      const { lines } = parseContentLines(`${foldLine(`NOTE:${value}`)}\r\n`)
      expect(lines[0]?.value).toBe(value)
    }
  })

  it('round-trips multi-byte content through fold and unfold', () => {
    const value = 'grüße äöü — 日本語テキスト 👍'.repeat(6)
    const { lines } = parseContentLines(`${foldLine(`NOTE:${escapeText(value)}`)}\r\n`)
    expect(unescapeText(lines[0]?.value ?? '')).toBe(value)
  })
})

describe('rendering', () => {
  it('writes VERSION immediately after BEGIN', () => {
    const card = renderCard([{ name: 'FN', value: 'Anna Meier' }])
    expect(card.split('\r\n').slice(0, 3)).toEqual(['BEGIN:VCARD', 'VERSION:4.0', 'FN:Anna Meier'])
    expect(card.endsWith('END:VCARD\r\n')).toBe(true)
  })

  it('renders a group prefix and parameters', () => {
    expect(
      renderLine({
        group: 'item1',
        name: 'TEL',
        params: new Map([['TYPE', ['work', 'voice']]]),
        value: '+49 123',
      }),
    ).toBe('item1.TEL;TYPE=work,voice:+49 123')
  })

  it('omits a parameter with no values rather than writing a bare `=`', () => {
    expect(renderLine({ name: 'TEL', params: new Map([['TYPE', []]]), value: 'x' })).toBe('TEL:x')
  })

  /** Caret first, or escaping a newline to `^n` would then have its own caret escaped. */
  it('quotes and escapes a parameter value per RFC 6868', () => {
    expect(escapeParam('a;b')).toBe('"a;b"')
    expect(escapeParam('line\nbreak')).toBe('line^nbreak')
    expect(escapeParam('a^b')).toBe('a^^b')
    expect(escapeParam('say "hi"')).toBe("say ^'hi^'")
  })

  it('round-trips a parameter through render and parse', () => {
    const rendered = renderLine({
      name: 'ADR',
      params: new Map([['LABEL', ['Haus\n1. Stock; hinten']]]),
      value: joinStructured(['', '', 'Weg 1', '', '', '', '']),
    })
    const { lines } = parseContentLines(`${rendered}\r\n`)
    expect(lines[0]?.params.get('LABEL')).toEqual(['Haus\n1. Stock; hinten'])
  })

  it('round-trips a structured value containing every separator', () => {
    const components = ['Meier; Anna', 'a,b', 'back\\slash', 'line\nbreak', '']
    const rendered = renderLine({ name: 'N', value: joinStructured(components) })
    const { lines } = parseContentLines(`${foldLine(rendered)}\r\n`)
    expect(structuredComponents(lines[0]?.value ?? '')).toEqual(components)
  })
})

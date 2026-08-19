/**
 * Round-trip safety for the managed Sieve script (M5.2, FR-SIEVE-01).
 *
 * The spec's requirement is that foreign scripts are "shown read-only in a code view rather than
 * destroyed". These tests are that sentence, made falsifiable: the foreign bytes have to come back
 * out of a save unchanged, and anything we cannot read has to make the script opaque rather than
 * be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import type { SieveRule } from './rule-model'
import { generateSieve, quoteSieveString, unsupportedRequires } from './rule-model'
import {
  adoptForeign,
  buildScript,
  EMPTY_SCRIPT,
  hasManagedRegion,
  parseScript,
  splitRequires,
} from './script-io'

function rule(overrides: Partial<SieveRule> = {}): SieveRule {
  return {
    id: 'r1',
    name: 'Invoices',
    enabled: true,
    match: 'all',
    conditions: [{ kind: 'text', field: 'from', match: 'contains', value: 'billing@example.com' }],
    actions: [{ kind: 'fileInto', mailboxId: 'mb1', mailboxName: 'Invoices' }],
    stop: false,
    ...overrides,
  }
}

describe('quoting', () => {
  it('escapes the two characters Sieve treats as special', () => {
    expect(quoteSieveString('a"b')).toBe('"a\\"b"')
    expect(quoteSieveString('a\\b')).toBe('"a\\\\b"')
  })

  it('flattens newlines rather than emitting a literal line break inside a string', () => {
    expect(quoteSieveString('a\nb')).toBe('"a b"')
  })

  it('escapes a quote that would otherwise close the string and inject a command', () => {
    // The injection shape: a subject filter of `"; discard; #` must not become a discard.
    const script = generateSieve([
      rule({
        conditions: [{ kind: 'text', field: 'subject', match: 'is', value: '"; discard; #' }],
      }),
    ]).body
    expect(script).toContain('"\\"; discard; #"')
    expect(script).not.toMatch(/^\s*discard;/m)
  })
})

describe('generateSieve', () => {
  it('addresses a mailbox by id first, with the name as a readable fallback', () => {
    // A name-only `fileinto` stops working the moment the user renames the folder.
    expect(generateSieve([rule()]).body).toContain('fileinto :mailboxid "mb1" "Invoices";')
  })

  it('collects the extensions it used, so the require line is never guessed', () => {
    const generated = generateSieve([
      rule({
        actions: [
          { kind: 'fileInto', mailboxId: 'm', mailboxName: 'n' },
          { kind: 'addFlag', flag: '\\Seen' },
        ],
      }),
    ])
    expect(generated.requires).toEqual(['fileinto', 'imap4flags', 'mailboxid'])
  })

  it('escapes wildcards in a startsWith value — the user typed them as literals', () => {
    // Without escaping, "starts with 5*5" silently matches far more than asked.
    const body = generateSieve([
      rule({ conditions: [{ kind: 'text', field: 'subject', match: 'startsWith', value: '5*5' }] }),
    ]).body
    // `\\*` is how RFC 5228 §2.7.1 spells a literal asterisk inside a quoted `:matches` operand:
    // the string parser turns `\\` into one backslash, which then escapes the `*` for the matcher.
    expect(body).toContain('"5\\\\*5*"')
  })

  it('compiles a disabled rule to nothing while keeping it in the model', () => {
    expect(generateSieve([rule({ enabled: false })]).body).toBe('')
  })

  it('emits allof / anyof according to the match mode', () => {
    const conditions = [
      { kind: 'text', field: 'from', match: 'contains', value: 'a' },
      { kind: 'text', field: 'to', match: 'contains', value: 'b' },
    ] as const
    expect(generateSieve([rule({ match: 'all', conditions: [...conditions] })]).body).toContain(
      'allof(',
    )
    expect(generateSieve([rule({ match: 'any', conditions: [...conditions] })]).body).toContain(
      'anyof(',
    )
  })
})

describe('parseScript', () => {
  it('treats an empty script as an empty rule set, not as opaque', () => {
    expect(parseScript('')).toEqual(EMPTY_SCRIPT)
  })

  it('marks a script it did not write as opaque and keeps every byte', () => {
    const foreign =
      'require ["fileinto"];\n# rule:[Roundcube rule]\nif header :contains "X" "y" {\n  fileinto "Old";\n}\n'
    const parsed = parseScript(foreign)
    expect(parsed.opaque).toBe(true)
    expect(parsed.rules).toBeNull()
    expect(parsed.preamble).toBe(foreign)
  })

  it('round-trips its own rules through JSON, not through the generated Sieve', () => {
    const rules = [rule(), rule({ id: 'r2', name: 'Newsletters', match: 'any', stop: true })]
    const parsed = parseScript(buildScript(rules, EMPTY_SCRIPT))
    expect(parsed.opaque).toBe(false)
    expect(parsed.rules).toEqual(rules)
  })

  it('survives a rule name containing a newline — the metadata stays one line', () => {
    // The `#` comment ends at the first newline, so an unescaped one would turn the rest of the
    // metadata into Sieve source. This is the `*/`-in-a-block-comment bug, avoided by construction.
    const rules = [rule({ name: 'Line one\nline two' })]
    const script = buildScript(rules, EMPTY_SCRIPT)
    expect(parseScript(script).rules).toEqual([rule({ name: 'Line one\nline two' })])
  })

  it('refuses a newer schema version instead of dropping what it cannot read', () => {
    const script = '# @waxwing:rules:v1 {"version":2,"rules":[]}\n# @waxwing:rules:end\n'
    expect(parseScript(script).opaque).toBe(true)
  })

  it('refuses malformed metadata', () => {
    expect(parseScript('# @waxwing:rules:v1 {not json\n# @waxwing:rules:end\n').opaque).toBe(true)
  })

  it('refuses a rule whose shape it does not recognise', () => {
    const script = `# @waxwing:rules:v1 {"version":1,"rules":[{"id":"r","name":"n","enabled":true,"match":"all","conditions":[{"kind":"telepathy"}],"actions":[],"stop":false}]}\n# @waxwing:rules:end\n`
    expect(parseScript(script).opaque).toBe(true)
  })

  it('refuses a script with two managed regions', () => {
    const one = buildScript([rule()], EMPTY_SCRIPT)
    expect(parseScript(one + one).opaque).toBe(true)
  })
})

describe('foreign content is preserved across a save', () => {
  const foreignBody =
    '# rule:[Nextcloud]\nif header :contains "List-Id" "announce" {\n  fileinto "Lists";\n}'
  const foreignScript = `require ["fileinto"];\n\n${foreignBody}\n`

  it('keeps foreign source byte for byte through adopt → build → parse → build', () => {
    // The real sequence: the mailbox already had filters, the user adds one of ours.
    const adopted = adoptForeign(foreignScript)
    expect(adopted.preamble).toBe(foreignBody)

    const saved = buildScript([rule()], adopted)
    expect(saved).toContain(foreignBody)

    const reloaded = parseScript(saved)
    expect(reloaded.opaque).toBe(false)
    expect(reloaded.rules).toEqual([rule()])
    expect(reloaded.preamble).toBe(foreignBody)

    // Saving again must be a fixed point — no accumulating headers, no drifting whitespace.
    expect(buildScript(reloaded.rules ?? [], reloaded)).toBe(saved)
  })

  it('hoists a foreign require into the merged line instead of dropping it', () => {
    // Losing `require "reject"` leaves a `reject` command that no longer compiles.
    const adopted = adoptForeign('require ["reject"];\n\nif true {\n  reject "no";\n}\n')
    expect(adopted.foreignRequires).toContain('reject')

    const saved = buildScript([rule()], adopted)
    expect(saved).toMatch(/^require \[.*"reject".*\];/)
    // Exactly one require line, and it is first (RFC 5228 §3.2).
    expect(saved.match(/require \[/g)).toHaveLength(1)
    expect(saved).toContain('"fileinto"')
  })

  it('does not interpret the foreign rules it carries', () => {
    // Their `fileinto "Lists"` is a by-name filing our own generator would never emit. It has to
    // come back out exactly as written rather than be "corrected" into our id-first form.
    const saved = buildScript([rule()], adoptForeign(foreignScript))
    expect(saved).toContain('fileinto "Lists";')
  })
})

describe('splitRequires', () => {
  it('reads several require commands and keeps the comments between them', () => {
    // Skipping past a comment to find the next `require` must not consume it — it is the user's.
    const source = 'require ["fileinto"];\n# a comment\nrequire "imap4flags";\nif true { stop; }\n'
    const { requires, rest } = splitRequires(source)
    expect(requires).toEqual(['fileinto', 'imap4flags'])
    expect(rest).toContain('# a comment')
    expect(rest).toContain('if true { stop; }')
    expect(rest).not.toContain('require')
  })

  it('stops at the first non-require command', () => {
    const { requires, rest } = splitRequires('if true { stop; }\nrequire ["late"];\n')
    expect(requires).toEqual([])
    expect(rest.trim()).toBe('if true { stop; }\nrequire ["late"];')
  })

  it('does not mistake a semicolon inside a string for the end of the command', () => {
    const { requires } = splitRequires('require ["a;b", "c"];\nif true { stop; }')
    expect(requires).toEqual(['a;b', 'c'])
  })
})

describe('unsupportedRequires', () => {
  it('names extensions the server did not advertise', () => {
    expect(unsupportedRequires(['fileinto', 'mailboxid'], ['fileinto'])).toEqual(['mailboxid'])
  })

  it('reports nothing when the server advertised no list at all', () => {
    // An absent list means "unknown", not "supports nothing" — warning on every rule would be noise.
    expect(unsupportedRequires(['fileinto'], undefined)).toEqual([])
    expect(unsupportedRequires(['fileinto'], [])).toEqual([])
  })
})

describe('hasManagedRegion', () => {
  it('distinguishes our script from someone else’s', () => {
    expect(hasManagedRegion(buildScript([rule()], EMPTY_SCRIPT))).toBe(true)
    expect(hasManagedRegion('if true { stop; }')).toBe(false)
  })
})

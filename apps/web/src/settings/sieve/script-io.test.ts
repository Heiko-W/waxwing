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
import {
  dropIndex,
  generateSieve,
  moveItem,
  quoteSieveString,
  sieveFeatures,
  unsupportedRequires,
} from './rule-model'
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

  it('reads a v1 region written by an earlier build', () => {
    // The vocabulary only ever grew, so v1 rules are all still expressible. Refusing them would
    // strand every mailbox that has filters today behind a read-only view.
    const v1 = `# @waxwing:rules:v1 {"version":1,"rules":[${JSON.stringify(rule())}]}\n# @waxwing:rules:end\n`
    expect(parseScript(v1).rules).toEqual([rule()])
  })

  it('writes the version the vocabulary needs, so an older build stops rather than guesses', () => {
    // ADR-023: a build that widens the vocabulary bumps the version. An older build then finds no
    // marker it knows, treats the script as opaque, and leaves it intact — instead of saving it
    // back with the conditions it could not represent quietly dropped.
    expect(buildScript([rule()], EMPTY_SCRIPT)).toContain('# @waxwing:rules:v2 ')
  })

  it('refuses a region whose marker and payload disagree about the version', () => {
    const mismatched = '# @waxwing:rules:v2 {"version":1,"rules":[]}\n# @waxwing:rules:end\n'
    expect(parseScript(mismatched).opaque).toBe(true)
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

/**
 * M-8 — the vocabulary the server advertised, and only that.
 *
 * Stalwart lists around fifty extensions in `sieveExtensions` and every deployment lists its own
 * set. A `require` for one a server does not implement can compile cleanly and then fail when mail
 * actually arrives (ADR-023), so what the builder emits is a function of that list.
 */
describe('the widened vocabulary (M-8)', () => {
  const ALL = [
    'envelope',
    'spamtest',
    'relational',
    'comparator-i;ascii-numeric',
    'date',
    'duplicate',
    'reject',
    'mime',
  ]

  it('matches the SMTP envelope, not the From header, when asked for the envelope sender', () => {
    // The distinction that catches a forged sender: `From:` is written by whoever composed the
    // message, the envelope is what the sending server actually said.
    const generated = generateSieve(
      [
        rule({
          conditions: [
            { kind: 'text', field: 'envelopeFrom', match: 'is', value: 'bounce@acme.test' },
          ],
        }),
      ],
      ALL,
    )
    expect(generated.body).toContain('envelope :is "from" "bounce@acme.test"')
    expect(generated.requires).toContain('envelope')
  })

  it('compares the spam score numerically, with the comparator that makes that mean anything', () => {
    const generated = generateSieve(
      [rule({ conditions: [{ kind: 'spam', operator: 'atLeast', score: 5 }] })],
      ALL,
    )
    expect(generated.body).toContain('spamtest :value "ge" :comparator "i;ascii-numeric" "5"')
    // Without `relational` there is no `:value`, and without the comparator "10" sorts before "5".
    expect(generated.requires).toEqual(
      expect.arrayContaining(['spamtest', 'relational', 'comparator-i;ascii-numeric']),
    )
  })

  it('clamps a spam score to the 0–10 the extension defines', () => {
    const body = generateSieve(
      [rule({ conditions: [{ kind: 'spam', operator: 'atMost', score: 99 }] })],
      ALL,
    ).body
    expect(body).toContain('"le"')
    expect(body).toContain('"10"')
  })

  it('tests the weekday with :is, which needs no comparator at all', () => {
    const generated = generateSieve(
      [rule({ conditions: [{ kind: 'currentDate', part: 'weekday', operator: 'is', value: 6 }] })],
      ['date'],
    )
    expect(generated.body).toContain('currentdate :is "weekday" "6"')
    expect(generated.requires).toEqual(['date', 'fileinto', 'mailboxid'])
  })

  it('zero-pads an hour, so the script reads the way a clock does', () => {
    const body = generateSieve(
      [
        rule({
          conditions: [{ kind: 'currentDate', part: 'hour', operator: 'atLeast', value: 9 }],
        }),
      ],
      ALL,
    ).body
    expect(body).toContain('currentdate :value "ge" :comparator "i;ascii-numeric" "hour" "09"')
  })

  it('suppresses duplicates with the bare test, inventing no tracking key of its own', () => {
    const generated = generateSieve([rule({ conditions: [{ kind: 'duplicate' }] })], ALL)
    expect(generated.body).toContain('if duplicate {')
    expect(generated.requires).toContain('duplicate')
  })

  it('refuses with a reason instead of discarding silently', () => {
    const generated = generateSieve(
      [rule({ actions: [{ kind: 'reject', reason: 'Not accepting mail from this list.' }] })],
      ALL,
    )
    expect(generated.body).toContain('reject "Not accepting mail from this list.";')
    expect(generated.requires).toContain('reject')
  })

  it('tests the MIME parts for an attachment when the server can, and guesses when it cannot', () => {
    // The old test matched `Content-Type: multipart/mixed`, which misses a `multipart/related`
    // attachment and fires on a message whose only "attachment" is an inline signature image.
    const withMime = generateSieve([rule({ conditions: [{ kind: 'hasAttachment' }] })], ALL)
    expect(withMime.body).toContain(
      'header :mime :anychild :contains "Content-Disposition" "attachment"',
    )
    expect(withMime.requires).toContain('mime')

    const without = generateSieve([rule({ conditions: [{ kind: 'hasAttachment' }] })], ['fileinto'])
    expect(without.body).toContain('header :contains "Content-Type" "multipart/mixed"')
    expect(without.requires).not.toContain('mime')
  })

  it('offers nothing extra to a server that advertised no list at all', () => {
    // "Unknown" is not "supported". A rule the form offered and the server then silently failed to
    // run is worse than one the form never offered.
    expect(sieveFeatures(undefined)).toEqual({
      envelope: false,
      spam: false,
      currentDate: false,
      hourRange: false,
      duplicate: false,
      reject: false,
      mimeAttachment: false,
    })
  })

  it('needs relational AND the numeric comparator before it offers a spam score', () => {
    expect(sieveFeatures(['spamtest']).spam).toBe(false)
    expect(sieveFeatures(['spamtest', 'relational']).spam).toBe(false)
    expect(sieveFeatures(['spamtest', 'relational', 'comparator-i;ascii-numeric']).spam).toBe(true)
  })

  it('separates the weekday gate from the hour gate — they need different extensions', () => {
    expect(sieveFeatures(['date'])).toMatchObject({ currentDate: true, hourRange: false })
    expect(sieveFeatures(['date', 'relational', 'comparator-i;ascii-numeric'])).toMatchObject({
      currentDate: true,
      hourRange: true,
    })
  })

  it('round-trips every new condition and action through the metadata', () => {
    const wide = rule({
      conditions: [
        { kind: 'text', field: 'envelopeTo', match: 'contains', value: 'alias@' },
        { kind: 'spam', operator: 'atLeast', score: 7 },
        { kind: 'currentDate', part: 'hour', operator: 'atMost', value: 6 },
        { kind: 'duplicate' },
      ],
      actions: [{ kind: 'reject', reason: 'no' }],
    })
    expect(parseScript(buildScript([wide], EMPTY_SCRIPT, ALL)).rules).toEqual([wide])
  })
})

/**
 * B-4 — order IS the semantics: a rule carrying `stop` ends processing and everything below it
 * never runs. The arithmetic is kept pure because jsdom has no layout engine, so a geometry-driven
 * drag cannot be exercised there at all.
 */
describe('reordering', () => {
  it('moves an entry down and shifts the rest up', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('moves an entry up', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('clamps rather than dropping the entry off either end', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a'])
  })

  it('returns the very same array when nothing moved, so a no-op drag saves nothing', () => {
    const rules = ['a', 'b']
    expect(moveItem(rules, 1, 1)).toBe(rules)
  })

  it('drops into the slot whose midpoint the pointer has passed', () => {
    const midpoints = [10, 30, 50]
    expect(dropIndex(midpoints, 0)).toBe(0)
    expect(dropIndex(midpoints, 20)).toBe(1)
    expect(dropIndex(midpoints, 40)).toBe(2)
    // Past the last row is the last row, not an index off the end.
    expect(dropIndex(midpoints, 9999)).toBe(2)
  })

  it('answers 0 for an empty list rather than -1', () => {
    expect(dropIndex([], 42)).toBe(0)
  })

  it('changes what the script does, which is the whole point', () => {
    const first = rule({ id: 'a', name: 'Stop here', stop: true })
    const second = rule({ id: 'b', name: 'Never reached' })
    const before = generateSieve([first, second]).body
    const after = generateSieve(moveItem([first, second], 0, 1)).body
    expect(before.indexOf('Stop here')).toBeLessThan(before.indexOf('Never reached'))
    expect(after.indexOf('Never reached')).toBeLessThan(after.indexOf('Stop here'))
  })
})

/**
 * ADR-023, nailed down where it is easiest to break: a foreign script has to survive the two
 * operations that were added after it was written.
 *
 * Reordering rewrites the whole script, and switching filtering off re-reads it. Neither may move,
 * reformat or re-interpret a single byte of what somebody else put there — position included,
 * because a foreign `stop;` decides whether anything below it runs at all.
 */
describe('a foreign script survives the operations added after ADR-023', () => {
  // Their `require` is the ONE thing ADR-023 allows to move: RFC 5228 §3.2 puts every `require`
  // before the first command, so two of them in sequence would not compile. Everything below it is
  // theirs, and neither moves nor changes.
  const foreignBody = `# rule:[Nextcloud]\nif header :contains "List-Id" "announce" {\n  fileinto "Lists";\n  stop;\n}`
  const foreign = `require ["fileinto", "reject"];\n\n${foreignBody}\n`

  const first = rule({ id: 'a', name: 'Invoices' })
  const second = rule({ id: 'b', name: 'Newsletters', stop: true })

  it('comes back byte for byte after the rules above it are reordered', () => {
    const adopted = adoptForeign(foreign)
    const saved = buildScript([first, second], adopted)
    const reordered = buildScript(moveItem([first, second], 1, 0), parseScript(saved))

    expect(reordered).toContain(foreignBody)
    // And in the SAME place: their `stop;` still runs before ours does.
    expect(reordered.indexOf('# rule:[Nextcloud]')).toBeLessThan(
      reordered.indexOf('@waxwing:rules'),
    )
    // Our order really did change underneath it.
    expect(reordered.indexOf('"name":"Newsletters"')).toBeLessThan(
      reordered.indexOf('"name":"Invoices"'),
    )
  })

  it('comes back byte for byte after a save that does not activate the script', () => {
    // Switching filtering off changes one argument of `SieveScript/set` and nothing about the
    // bytes — this is the assertion that keeps it that way.
    const adopted = adoptForeign(foreign)
    const saved = buildScript([first], adopted)
    const parsed = parseScript(saved)

    expect(parsed.opaque).toBe(false)
    expect(buildScript(parsed.rules ?? [], parsed)).toBe(saved)
    expect(saved).toContain(foreignBody)
  })

  it('keeps a require of theirs that only their rules use', () => {
    const saved = buildScript([first], adoptForeign(foreign))
    expect(saved).toMatch(/^require \[.*"reject".*\];/)
    expect(saved.match(/require \[/g)).toHaveLength(1)
  })
})

/**
 * The identity editor's pure half (M5.1, FR-CMP-06, RFC 8621 §6).
 *
 * Two things here are load-bearing beyond "the mapping works":
 *
 *  - **The shape of an `update` patch.** `PatchObject` is `Record<string, unknown>`, so a patch
 *    carrying `email`, `id` or `mayDelete` compiles perfectly and is only ever refused by the
 *    server, as `invalidProperties` — a runtime failure the user reads as "saving my signature is
 *    broken". These tests are the only thing standing between that and a refactor of `toWritable`.
 *  - **The signature sanitizer, in both directions.** `identity-model` is the single place an HTML
 *    signature is filtered, and the fixtures below are the same overlay `quoted-html.test.ts`
 *    measures — a signature is inserted into a contenteditable in the APP document on every new
 *    draft, so it is the same door with a longer lifetime. Both directions are asserted because
 *    only one of them protects this reader (load) and only the other protects the next save.
 *
 * Every HTML fixture puts real content BEFORE a `<style>`/`<script>`: the parser hoists a leading
 * one into `<head>`, where `body.innerHTML` never sees it, and the fixture would then pass with the
 * sanitizer removed entirely.
 */

import type { Identity } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_IDENTITY_DRAFT,
  type IdentityDraft,
  isDirty,
  toCreate,
  toDraft,
  toWritable,
  validateIdentity,
} from './identity-model'

const identity = (over: Partial<Identity> = {}): Identity => ({
  id: 'I1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  replyTo: null,
  bcc: null,
  textSignature: '',
  htmlSignature: '',
  mayDelete: true,
  ...over,
})

const draft = (over: Partial<IdentityDraft> = {}): IdentityDraft => ({
  ...EMPTY_IDENTITY_DRAFT,
  email: 'ada@example.test',
  ...over,
})

/** The properties RFC 8621 §6 lets a client write — and, exactly, the ones a patch may carry. */
const WRITABLE_KEYS = ['bcc', 'htmlSignature', 'name', 'replyTo', 'textSignature']

/** The overlay `quoted-html.ts` was measured against, as an admin-provisioned signature. */
const OVERLAY_SIGNATURE =
  '<div style="position:fixed;inset:0;z-index:2147483647;background:#fff">Sign in again</div>'

describe('toDraft', () => {
  it('renders reply-to and bcc as the same text the composer’s address fields accept', () => {
    // One parser and one formatter for every address in the app: `Name <a@b.test>` has to mean
    // here what it means in the To field, or editing one back is a lossy round-trip.
    const wire = identity({
      replyTo: [
        { name: 'Ada Lovelace', email: 'ada@example.test' },
        { name: null, email: 'ops@example.test' },
      ],
      bcc: [{ name: 'Archive', email: 'archive@example.test' }],
    })
    expect(toDraft(wire).replyTo).toBe('Ada Lovelace <ada@example.test>, ops@example.test')
    expect(toDraft(wire).bcc).toBe('Archive <archive@example.test>')
  })

  it('survives a full round-trip back to the wire shape', () => {
    const replyTo = [
      { name: 'Ada Lovelace', email: 'ada@example.test' },
      { name: null, email: 'ops@example.test' },
    ]
    expect(toWritable(toDraft(identity({ replyTo }))).replyTo).toEqual(replyTo)
  })

  it('turns the wire’s "unset" nulls into empty fields rather than crashing on them', () => {
    expect(toDraft(identity({ replyTo: null, bcc: null }))).toMatchObject({ replyTo: '', bcc: '' })
  })

  it('carries the address, the name and both signatures into the form', () => {
    const wire = identity({
      name: 'Ada L.',
      textSignature: '--\nAda',
      htmlSignature: '<p>--<br>Ada</p>',
    })
    expect(toDraft(wire)).toEqual({
      email: 'ada@example.test',
      name: 'Ada L.',
      replyTo: '',
      bcc: '',
      textSignature: '--\nAda',
      htmlSignature: '<p>--<br>Ada</p>',
    })
  })
})

describe('toWritable', () => {
  /**
   * THE test of this file. `PatchObject` is `Record<string, unknown>`, so nothing but this
   * assertion stops `email` (immutable per §6), `id` or `mayDelete` (server-set) from riding along
   * in an `update` — and a server answers that with `invalidProperties`, not with a hint that the
   * address of an identity simply cannot be changed.
   */
  it('never puts an immutable or server-set property in an update patch', () => {
    const patch = toWritable(toDraft(identity()))
    expect(Object.keys(patch).sort()).toEqual(WRITABLE_KEYS)
    expect(patch).not.toHaveProperty('email')
    expect(patch).not.toHaveProperty('id')
    expect(patch).not.toHaveProperty('mayDelete')
  })

  it('writes null — not "" — for a cleared reply-to or bcc', () => {
    // `replyTo: ""` is not "no reply-to", it is a malformed address list, and a server refuses it
    // as `invalidProperties`. Whitespace alone counts as cleared.
    const patch = toWritable(draft({ replyTo: '', bcc: '   ' }))
    expect(patch.replyTo).toBeNull()
    expect(patch.bcc).toBeNull()
  })

  it('keeps "" for the signatures, whose RFC default is the empty string', () => {
    const patch = toWritable(draft({ textSignature: '', htmlSignature: '' }))
    expect(patch.textSignature).toBe('')
    expect(patch.htmlSignature).toBe('')
  })

  it('trims the display name, which is padding the user cannot see in the list', () => {
    expect(toWritable(draft({ name: '  Ada Lovelace  ' })).name).toBe('Ada Lovelace')
  })

  it('parses a typed list the way the composer does', () => {
    const patch = toWritable(draft({ replyTo: 'Ada <ada@example.test>; ops@example.test' }))
    expect(patch.replyTo).toEqual([
      { name: 'Ada', email: 'ada@example.test' },
      { name: null, email: 'ops@example.test' },
    ])
  })

  it('strips the editor’s own artefacts before the signature is stored', () => {
    // Squire tags styled runs with an editor-only class and pads the cursor with U+200B; both are
    // meaningless outside the editor and would ship inside every future message.
    const artefacts = '<span class="color" style="color:#c00">Ada\u200B</span>'
    const patch = toWritable(draft({ htmlSignature: artefacts }))
    expect(patch.htmlSignature).toBe('<span style="color:#c00">Ada</span>')
  })
})

describe('toCreate', () => {
  it('adds the address — trimmed — to the writable properties, and nothing else', () => {
    const created = toCreate(draft({ email: '  ada@example.test  ', name: 'Ada' }))
    expect(created).toEqual({
      email: 'ada@example.test',
      name: 'Ada',
      replyTo: null,
      bcc: null,
      textSignature: '',
      htmlSignature: '',
    })
  })

  it('still refuses the server-set properties, which only the server may assign', () => {
    const created = toCreate(draft())
    expect(created).not.toHaveProperty('id')
    expect(created).not.toHaveProperty('mayDelete')
  })
})

/**
 * The sanitizer is asserted on BOTH edges because they close different holes: the load path filters
 * markup this app never wrote (an admin, another client, a pre-Waxwing signature), the save path
 * makes what is stored equal to what will actually be inserted into a draft. Each direction alone
 * leaves the other open.
 */
describe('the HTML signature is sanitized in both directions', () => {
  const both = (html: string): readonly string[] => [
    toDraft(identity({ htmlSignature: html })).htmlSignature,
    toWritable(draft({ htmlSignature: html })).htmlSignature ?? '',
  ]

  it('reduces a fixed full-viewport overlay to its paint, keeping the text', () => {
    for (const out of both(OVERLAY_SIGNATURE)) {
      expect(out).toBe('<div style="background:#fff">Sign in again</div>')
    }
  })

  it('deletes a stylesheet, which would re-grant every property the allowlist removed', () => {
    for (const out of both('<p>Ada</p><style>p{position:fixed;inset:0}</style>')) {
      expect(out).toBe('<p>Ada</p>')
    }
  })

  it('deletes a script — belt and braces, but the signature outlives every draft it enters', () => {
    for (const out of both('<p>Ada</p><script>alert(1)</script>')) expect(out).toBe('<p>Ada</p>')
  })

  it('deletes input widgets, of which a signature has no legitimate use', () => {
    for (const out of both('<p>Ada</p><input name="password"><textarea></textarea>')) {
      expect(out).toBe('<p>Ada</p>')
    }
  })

  it('leaves an ordinary signature alone — a sanitizer that eats formatting gets reverted', () => {
    const signature =
      '<p style="color:#333;font-family:Georgia,serif">— <b>Ada Lovelace</b><br>' +
      '<a href="https://example.test/ada">example.test/ada</a><br>' +
      '<img src="https://example.test/logo.png" alt="logo" style="width:120px"></p>'
    for (const out of both(signature)) expect(out).toBe(signature)
  })
})

describe('validateIdentity', () => {
  it('demands a plausible address only while creating', () => {
    // Editing cannot change the address (§6), so re-checking one the server already accepted would
    // block the user out of their own signature over an address we merely find implausible.
    expect(validateIdentity(draft({ email: '' }), { creating: true })).toBe('emailMissing')
    expect(validateIdentity(draft({ email: '   ' }), { creating: true })).toBe('emailMissing')
    expect(validateIdentity(draft({ email: 'ada@localhost' }), { creating: true })).toBe(
      'emailInvalid',
    )
    expect(validateIdentity(draft({ email: '' }), { creating: false })).toBeNull()
    expect(validateIdentity(draft({ email: 'ada@localhost' }), { creating: false })).toBeNull()
  })

  it('flags a typo in reply-to and bcc whether creating or editing', () => {
    for (const creating of [true, false]) {
      expect(validateIdentity(draft({ replyTo: 'Ada <ada@example>' }), { creating })).toBe(
        'replyToInvalid',
      )
      expect(
        validateIdentity(draft({ bcc: 'archive@example.test, not an address' }), { creating }),
      ).toBe('bccInvalid')
    }
  })

  it('accepts a filled-in draft', () => {
    const good = draft({
      name: 'Ada',
      replyTo: 'Ada <ada@example.test>, ops@example.test',
      bcc: 'archive@example.test',
      htmlSignature: '<p>Ada</p>',
    })
    expect(validateIdentity(good, { creating: true })).toBeNull()
    expect(validateIdentity(good, { creating: false })).toBeNull()
  })
})

describe('isDirty', () => {
  it('reports an untouched form as clean, however the wire record was spelled', () => {
    // The comparison has to happen AFTER both sides are normalized: loading sanitizes the signature
    // and re-formats the addresses, so a raw comparison would call every server-provisioned
    // identity dirty and fire a pointless `/set` on the first Save.
    const wire = identity({
      name: 'Ada Lovelace',
      replyTo: [{ name: 'Ada', email: 'ada@example.test' }],
      textSignature: '--\nAda',
      htmlSignature: OVERLAY_SIGNATURE,
    })
    expect(isDirty(toDraft(wire), wire)).toBe(false)
  })

  it.each([
    ['name', { name: 'Ada L.' }],
    ['reply-to', { replyTo: 'ops@example.test' }],
    ['bcc', { bcc: 'archive@example.test' }],
    ['text signature', { textSignature: '--\nAda' }],
    ['html signature', { htmlSignature: '<p>Ada</p>' }],
  ])('reports an edited %s as dirty', (_field, change) => {
    const wire = identity()
    expect(isDirty({ ...toDraft(wire), ...change }, wire)).toBe(true)
  })

  it('ignores a change the server would never see', () => {
    // Padding around the name is trimmed on the way out, so it is not a reason to write.
    const wire = identity({ name: 'Ada Lovelace' })
    expect(isDirty({ ...toDraft(wire), name: '  Ada Lovelace  ' }, wire)).toBe(false)
  })
})

/**
 * TNEF extraction (M5.21).
 *
 * This parses bytes a stranger sent, so the tests that matter are the hostile ones: a length field
 * that points past the end, a truncated stream, a stream claiming a gigabyte. Each of those must
 * end the parse and hand back what was already whole — never throw, never read out of bounds, never
 * allocate on the file's say-so.
 *
 * The fixtures are built here rather than checked in as binaries, so what each byte means is
 * readable in the test that depends on it.
 */

import { describe, expect, it } from 'vitest'
import { extractTnefAttachments, looksLikeTnef } from './tnef'
import { isTnefPart } from './tnef-detect'

const ATT_ATTACH_DATA = 0x800f
const ATT_ATTACH_TITLE = 0x8010
const ATT_ATTACH_REND_DATA = 0x9002
const ATT_ATTACHMENT = 0x9005
const LVL_MESSAGE = 0x01
const LVL_ATTACHMENT = 0x02

interface Attribute {
  level: number
  id: number
  data: number[]
  /** Overrides the length field, for the malformed-stream tests. */
  claimedLength?: number
}

/** A TNEF stream: signature, key, then the attributes given. */
function tnef(attributes: Attribute[], signature = 0x223e9f78): Uint8Array {
  const out: number[] = []
  const u32 = (value: number) => {
    out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }
  u32(signature)
  out.push(0x01, 0x00) // key
  for (const attribute of attributes) {
    out.push(attribute.level)
    u32(attribute.id)
    u32(attribute.claimedLength ?? attribute.data.length)
    out.push(...attribute.data)
    out.push(0x00, 0x00) // checksum, not verified
  }
  return new Uint8Array(out)
}

const latin1 = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
const nulTerminated = (text: string): number[] => [...latin1(text), 0]

function utf16(text: string): number[] {
  const out: number[] = []
  for (const char of text) {
    const code = char.charCodeAt(0)
    out.push(code & 0xff, (code >>> 8) & 0xff)
  }
  out.push(0, 0)
  return out
}

describe('recognising the container', () => {
  it('accepts the declared TNEF types', () => {
    expect(isTnefPart('application/ms-tnef', 'winmail.dat')).toBe(true)
    expect(isTnefPart('application/vnd.ms-tnef', 'winmail.dat')).toBe(true)
    expect(isTnefPart('APPLICATION/MS-TNEF; name=winmail.dat', null)).toBe(true)
  })

  it('accepts an octet-stream that is named winmail.dat', () => {
    // Some relays rewrite the type and leave only the name.
    expect(isTnefPart('application/octet-stream', 'winmail.dat')).toBe(true)
    expect(isTnefPart('application/octet-stream', 'WinMail.DAT')).toBe(true)
  })

  it('does NOT claim an ordinary octet-stream', () => {
    // The name is the only evidence in that branch; without it, guessing would swallow real files.
    expect(isTnefPart('application/octet-stream', 'firmware.bin')).toBe(false)
    expect(isTnefPart('application/octet-stream', null)).toBe(false)
    expect(isTnefPart('application/pdf', 'winmail.dat')).toBe(false)
  })

  it('checks the signature before decoding anything', () => {
    expect(looksLikeTnef(tnef([]))).toBe(true)
    expect(looksLikeTnef(tnef([], 0xdeadbeef))).toBe(false)
    expect(looksLikeTnef(new Uint8Array([1, 2]))).toBe(false)
    expect(extractTnefAttachments(tnef([], 0xdeadbeef))).toEqual([])
  })
})

describe('extracting files', () => {
  it('recovers a named attachment', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0, 0, 0, 0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('invoice.pdf') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('%PDF-1.4') },
    ])
    const found = extractTnefAttachments(stream)
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('invoice.pdf')
    expect(new TextDecoder().decode(found[0]?.bytes)).toBe('%PDF-1.4')
  })

  it('recovers several, keeping each name with its own bytes', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('one.txt') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('first') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('two.txt') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('second') },
    ])
    const found = extractTnefAttachments(stream)
    expect(found.map((file) => file.name)).toEqual(['one.txt', 'two.txt'])
    expect(new TextDecoder().decode(found[0]?.bytes)).toBe('first')
    expect(new TextDecoder().decode(found[1]?.bytes)).toBe('second')
  })

  it('reads a UTF-16 filename', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: utf16('Angebot.pdf') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('x') },
    ])
    expect(extractTnefAttachments(stream)[0]?.name).toBe('Angebot.pdf')
  })

  it('names an untitled attachment rather than emitting an empty filename', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('body') },
    ])
    expect(extractTnefAttachments(stream)[0]?.name).toBe('attachment')
  })

  it('ignores message-level attributes and the MAPI property table', () => {
    const stream = tnef([
      { level: LVL_MESSAGE, id: ATT_ATTACH_DATA, data: latin1('not an attachment') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACHMENT, data: [1, 2, 3, 4, 5] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('real.txt') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('yes') },
    ])
    const found = extractTnefAttachments(stream)
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('real.txt')
  })

  it('returns nothing for a container that holds no files', () => {
    expect(extractTnefAttachments(tnef([]))).toEqual([])
    expect(
      extractTnefAttachments(tnef([{ level: LVL_MESSAGE, id: 0x9006, data: [1, 0, 0, 0] }])),
    ).toEqual([])
  })
})

describe('bytes a stranger sent', () => {
  it('stops at a length that points past the end, keeping what was already whole', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('good.txt') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('kept') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('xx'), claimedLength: 0xffffff },
    ])
    const found = extractTnefAttachments(stream)
    expect(found).toHaveLength(1)
    expect(new TextDecoder().decode(found[0]?.bytes)).toBe('kept')
  })

  it('does not throw on a stream truncated mid-attribute', () => {
    const full = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('cut.txt') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('0123456789') },
    ])
    for (let cut = 6; cut < full.length; cut += 1) {
      expect(() => extractTnefAttachments(full.subarray(0, cut)), `cut at ${cut}`).not.toThrow()
    }
  })

  it('does not throw on random bytes behind a valid signature', () => {
    const noise = new Uint8Array(512)
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 37) % 256
    noise.set([0x78, 0x9f, 0x3e, 0x22], 0)
    expect(() => extractTnefAttachments(noise)).not.toThrow()
  })

  it('does not allocate on a claimed length the file does not back', () => {
    // The attack: a 4 GB length in a 40-byte file. The guard is a comparison, so this returns
    // rather than attempting the allocation.
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: [1], claimedLength: 0xfffffff0 },
    ])
    expect(extractTnefAttachments(stream)).toEqual([])
  })

  it('handles an empty and a signature-only input', () => {
    expect(extractTnefAttachments(new Uint8Array(0))).toEqual([])
    expect(extractTnefAttachments(new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0, 0]))).toEqual([])
  })

  it('gives each file a distinct id even when two share a name', () => {
    // The container is allowed to repeat a name, and the reader has to be able to tell the two
    // rows apart — the position is the only thing that does.
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('report.pdf') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('one') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_TITLE, data: nulTerminated('report.pdf') },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('two') },
    ])
    const found = extractTnefAttachments(stream)
    expect(found.map((file) => file.name)).toEqual(['report.pdf', 'report.pdf'])
    expect(new Set(found.map((file) => file.id)).size).toBe(2)
  })

  it('copies the bytes out, so the result does not pin the container buffer', () => {
    const stream = tnef([
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_REND_DATA, data: [0] },
      { level: LVL_ATTACHMENT, id: ATT_ATTACH_DATA, data: latin1('abc') },
    ])
    const found = extractTnefAttachments(stream)
    expect(found[0]?.bytes.byteLength).toBe(3)
    // A subarray would share the container's buffer and report its full length here.
    expect(found[0]?.bytes.buffer.byteLength).toBe(3)
  })
})

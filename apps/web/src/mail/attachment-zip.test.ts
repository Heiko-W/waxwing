/**
 * Bundling attachments into one archive (M5.3).
 *
 * The naming rules are the part worth pinning: two attachments with the same filename is an
 * ordinary message, and a zip with two identical entry names loses one of them silently.
 */

import { describe, expect, it } from 'vitest'
import { buildZip, uniqueNames, zipFilename } from './attachment-zip'

describe('uniqueNames', () => {
  it('leaves distinct names alone', () => {
    expect(uniqueNames(['a.pdf', 'b.pdf'])).toEqual(['a.pdf', 'b.pdf'])
  })

  it('numbers a repeat before its extension', () => {
    expect(uniqueNames(['invoice.pdf', 'invoice.pdf', 'invoice.pdf'])).toEqual([
      'invoice.pdf',
      'invoice (1).pdf',
      'invoice (2).pdf',
    ])
  })

  it('numbers an extensionless name at the end', () => {
    expect(uniqueNames(['README', 'README'])).toEqual(['README', 'README (1)'])
  })

  it('treats a leading dot as the whole name, not an extension', () => {
    expect(uniqueNames(['.gitignore', '.gitignore'])).toEqual(['.gitignore', '.gitignore (1)'])
  })
})

describe('zipFilename', () => {
  it('derives the archive name from the subject', () => {
    expect(zipFilename('Quarterly report')).toBe('Quarterly report.zip')
  })

  it('falls back when there is no usable subject', () => {
    expect(zipFilename(null)).toBe('attachments.zip')
    expect(zipFilename('')).toBe('attachments.zip')
  })

  it('strips a subject that would escape the download directory', () => {
    // The subject is the sender's string and this becomes a filesystem name.
    const name = zipFilename('../../etc/passwd')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
    expect(name.endsWith('.zip')).toBe(true)
  })
})

describe('buildZip', () => {
  it('produces a zip whose bytes start with the local file header signature', async () => {
    const archive = await buildZip([
      { name: 'one.txt', blob: new Blob(['first']) },
      { name: 'two.txt', blob: new Blob(['second']) },
    ])
    const head = new Uint8Array(await archive.slice(0, 4).arrayBuffer())
    // "PK\x03\x04" — the local file header every zip begins with.
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(archive.size).toBeGreaterThan(0)
  })

  it('is deterministic: the same entries produce the same bytes', async () => {
    // The timestamp is fixed rather than "now", so an archive is a function of its contents.
    const entries = [{ name: 'a.txt', blob: new Blob(['x']) }]
    const first = new Uint8Array(await (await buildZip(entries)).arrayBuffer())
    const second = new Uint8Array(await (await buildZip(entries)).arrayBuffer())
    expect([...first]).toEqual([...second])
  })
})

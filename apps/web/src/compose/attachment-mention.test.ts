import { describe, expect, it } from 'vitest'
import { mentionsAttachment } from './attachment-mention'

const en = ['attach', 'attached', 'attachment', 'enclosed', 'see the file']
const de = ['anhang', 'anbei', 'angehängt', 'beigefügt', 'siehe datei']

describe('mentionsAttachment', () => {
  it('detects an attachment mention (prefix match catches inflections)', () => {
    expect(mentionsAttachment('<p>See the attached report.</p>', en)).toBe(true)
    expect(mentionsAttachment('<p>Please find enclosed the file.</p>', en)).toBe(true)
    expect(mentionsAttachment('<p>Der Vertrag ist anbei.</p>', de)).toBe(true)
    expect(mentionsAttachment('<p>siehe Datei unten</p>', de)).toBe(true)
  })

  it('is false when nothing mentions an attachment', () => {
    expect(mentionsAttachment('<p>Thanks, talk soon.</p>', en)).toBe(false)
    expect(mentionsAttachment('<p></p>', en)).toBe(false)
  })

  it('does not false-positive on quoted text or the signature', () => {
    const quoted = '<p>ok</p><blockquote><p>Please see the attached invoice.</p></blockquote>'
    expect(mentionsAttachment(quoted, en)).toBe(false)
    const sig = '<p>Thanks</p><div data-waxwing-signature=""><p>Sent with attachment love</p></div>'
    expect(mentionsAttachment(sig, en)).toBe(false)
  })

  it('does not match a keyword inside an unrelated word', () => {
    expect(mentionsAttachment('<p>We reattached nothing — detach it.</p>', ['attach'])).toBe(false)
  })
})

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

/**
 * The boundary, once the bundle stopped being two Latin languages (v0.21.0).
 *
 * Two of the twelve translators reported this independently while writing their keyword lists, and
 * it is worth stating what the failure looked like, because it is the kind that reviews miss: the
 * feature did not get weaker in Russian, Ukrainian, Japanese and Chinese — it was OFF. `\b` is
 * defined against ASCII `\w`, so a needle beginning with `в` or `附` could not sit on a boundary at
 * any position, including the start of the message. Nineteen of nineteen keywords in those four
 * shipped bundles were unmatchable, and the composer sent without a word.
 *
 * Each case below is taken from the bundle that ships, not invented for the test.
 */
describe('mentionsAttachment across scripts', () => {
  const ru = ['вложени', 'прикреп', 'прилага', 'приложен', 'см. файл']
  const uk = ['вклад', 'прикріп', 'додаю файл', 'у доданому файлі', 'див. файл']
  const zh = ['附件', '附上', '见附件', '随信附上']
  const ja = ['添付', '別添', '同封', 'ファイルを送', '資料を送']

  it('matches a Cyrillic keyword — the case that was dead', () => {
    expect(mentionsAttachment('<p>Отчёт во вложении.</p>', ru)).toBe(true)
    // At the very start of the text, where `\b` also failed.
    expect(mentionsAttachment('<p>Вложение ниже.</p>', ru)).toBe(true)
    expect(mentionsAttachment('<p>Ось вкладення.</p>', uk)).toBe(true)
  })

  it('matches a Han or kana keyword with no word gap in front of it', () => {
    // `请见附件` has a letter immediately before the needle. Any boundary rule at all rejects this,
    // which is why a script without word gaps does not get one.
    expect(mentionsAttachment('<p>请见附件。</p>', zh)).toBe(true)
    expect(mentionsAttachment('<p>資料を添付しました。</p>', ja)).toBe(true)
  })

  it('still refuses a Latin keyword inside a longer word', () => {
    // The exemption is by script, not a general loosening: the boundary that stopped "detach" from
    // firing has to survive the change that made "附件" fire.
    expect(mentionsAttachment('<p>We reattached nothing — detach it.</p>', ['attach'])).toBe(false)
    expect(mentionsAttachment('<p>Ganzheitlich betrachtet.</p>', ['acht'])).toBe(false)
  })

  it('says nothing when a Cyrillic or CJK draft mentions no attachment', () => {
    expect(mentionsAttachment('<p>Спасибо, до связи.</p>', ru)).toBe(false)
    expect(mentionsAttachment('<p>謝謝，再聯絡。</p>', zh)).toBe(false)
  })

  it('folds case in the language’s own way, not the default one', () => {
    const tr = ['ekte', 'ilişikte', 'dosyayı ekle']
    // `İ` is the case that decides it. `toLowerCase()` turns it into `i` + U+0307, which matches
    // nothing — and a message opening with the word is the commonest way to write it.
    expect(mentionsAttachment('<p>İlişikte bulabilirsiniz.</p>', tr, 'tr')).toBe(true)
    expect(mentionsAttachment('<p>Ekte gönderiyorum.</p>', tr, 'tr')).toBe(true)
  })
})

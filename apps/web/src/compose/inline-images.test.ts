import { describe, expect, it } from 'vitest'
import {
  canonicalizeInlineImages,
  referencedCids,
  removeInlineImage,
  resolveInlineImages,
} from './inline-images'

describe('canonicalizeInlineImages', () => {
  it('rewrites an editor img (objectURL + data-cid) to the canonical cid: form', () => {
    const html = '<p><img src="blob:abc" data-cid="c1" alt="x"></p>'
    expect(canonicalizeInlineImages(html)).toBe('<p><img src="cid:c1" alt="x"></p>')
  })

  it('leaves an img without data-cid untouched', () => {
    const html = '<p><img src="https://x/y.png"></p>'
    expect(canonicalizeInlineImages(html)).toBe(html)
  })
})

describe('resolveInlineImages', () => {
  it('rewrites cid: to a resolved objectURL and re-adds data-cid', () => {
    const html = '<p><img src="cid:c1"></p>'
    expect(resolveInlineImages(html, (cid) => (cid === 'c1' ? 'blob:xyz' : null))).toBe(
      '<p><img src="blob:xyz" data-cid="c1"></p>',
    )
  })

  it('drops an img whose cid cannot be resolved (deferred preview restore)', () => {
    expect(resolveInlineImages('<p><img src="cid:gone">after</p>', () => null)).toBe('<p>after</p>')
  })

  it('round-trips: canonical → display → canonical is stable', () => {
    const canonical = '<p><img src="cid:c1">hi</p>'
    const display = resolveInlineImages(canonical, () => 'blob:z')
    expect(canonicalizeInlineImages(display)).toBe(canonical)
  })
})

describe('referencedCids', () => {
  it('collects every referenced inline cid', () => {
    const html = '<img src="cid:a"><img src="cid:b"><img src="https://x/c.png">'
    expect(referencedCids(html)).toEqual(new Set(['a', 'b']))
  })
})

describe('removeInlineImage', () => {
  it('removes only the img for the given cid', () => {
    const html = '<p><img src="cid:a"><img src="cid:b">tail</p>'
    expect(removeInlineImage(html, 'a')).toBe('<p><img src="cid:b">tail</p>')
  })
})

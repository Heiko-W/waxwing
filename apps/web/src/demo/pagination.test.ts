import { describe, expect, it } from 'vitest'
import { DEMO_PAGE_SIZE, nextPosition, pageInfo, prevPosition } from './pagination'

describe('demo pagination', () => {
  it('describes the first page of a 25-message mailbox', () => {
    expect(pageInfo(0, 10, 25)).toEqual({
      hasPrev: false,
      hasNext: true,
      from: 1,
      to: 10,
      total: 25,
    })
  })

  it('describes a short last page and disables next at the end', () => {
    expect(pageInfo(20, 5, 25)).toEqual({
      hasPrev: true,
      hasNext: false,
      from: 21,
      to: 25,
      total: 25,
    })
  })

  it('disables next when a full window reaches exactly the total', () => {
    const info = pageInfo(20, 10, 30)
    expect(info.hasNext).toBe(false)
    expect(info.to).toBe(30)
  })

  it('reports an empty mailbox with a zero range', () => {
    expect(pageInfo(0, 0, 0)).toEqual({
      hasPrev: false,
      hasNext: false,
      from: 0,
      to: 0,
      total: 0,
    })
  })

  it('advances a page but never over-requests past the last page', () => {
    expect(nextPosition(0, DEMO_PAGE_SIZE, 25)).toBe(10)
    expect(nextPosition(10, DEMO_PAGE_SIZE, 25)).toBe(20)
    // 20 + 10 = 30 > 25 → stay put; the short last page is already loaded.
    expect(nextPosition(20, DEMO_PAGE_SIZE, 25)).toBe(20)
  })

  it('steps back a page, clamped at zero', () => {
    expect(prevPosition(0, DEMO_PAGE_SIZE)).toBe(0)
    expect(prevPosition(10, DEMO_PAGE_SIZE)).toBe(0)
    expect(prevPosition(25, DEMO_PAGE_SIZE)).toBe(15)
  })
})

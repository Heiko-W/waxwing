import { afterEach, describe, expect, it } from 'vitest'
import {
  computePaneLayout,
  getFolderRailVisible,
  MIN_SPLIT_BLOCK_PX,
  setFolderRailVisible,
  tierForWidth,
  toggleFolderRail,
} from './layout'

/**
 * The shell's two pure layout decisions, and the preference that now sits beside them.
 *
 * This file had no test at all, which is how a layout rule that consulted only the WIDTH survived:
 * an iPhone on its side is 844 px wide — the tablet tier by that measure alone — so it was handed
 * the two-pane split, the side rail instead of the bottom bar, and a second 60 px pane toolbar.
 * Measured on 844 × 390 that is roughly 180 px of bars against 210 px of list. There was no height
 * condition anywhere in the source tree.
 */

afterEach(() => {
  localStorage.removeItem('waxwing.folderRail')
  setFolderRailVisible(true)
})

describe('tierForWidth', () => {
  it.each([
    { width: 390, tier: 'phone' },
    { width: 639, tier: 'phone' },
    { width: 640, tier: 'tablet' },
    { width: 834, tier: 'tablet' },
    { width: 1023, tier: 'tablet' },
    { width: 1024, tier: 'desktop' },
    { width: 1440, tier: 'desktop' },
    // A phone in landscape. By width it is a tablet, and that is exactly the trap below.
    { width: 844, tier: 'tablet' },
  ])('$width px is the $tier tier', ({ width, tier }) => {
    expect(tierForWidth(width)).toBe(tier)
  })
})

describe('computePaneLayout — the split needs room in BOTH axes', () => {
  it('splits on a tablet with room', () => {
    expect(computePaneLayout('tablet', 'right', false, true).split).toBe(true)
  })

  it('does not split a viewport that is wide but short', () => {
    // The iPhone-in-landscape case: 844 × 390.
    expect(computePaneLayout('tablet', 'right', false, false).split).toBe(false)
  })

  it('leaves the phone tier single-pane whatever the height', () => {
    expect(computePaneLayout('phone', 'right', false, true).split).toBe(false)
  })

  it('still honours reading-pane "off" where there is plenty of room', () => {
    expect(computePaneLayout('desktop', 'off', false, true).split).toBe(false)
  })

  it('assumes there is room when nobody says otherwise', () => {
    // The default keeps every existing caller and test at the behaviour they had; only the shell
    // passes the measured answer.
    expect(computePaneLayout('desktop', 'right', false).split).toBe(true)
  })

  it('puts the threshold below every tablet and above every phone on its side', () => {
    // iPad landscape is 834 high, an iPhone on its side is 390. A number between the two is the
    // whole of the rule; naming it here is what stops it drifting into either.
    expect(MIN_SPLIT_BLOCK_PX).toBeGreaterThan(390)
    expect(MIN_SPLIT_BLOCK_PX).toBeLessThan(834)
  })
})

describe('the folder rail preference', () => {
  it('starts visible', () => {
    // HIG `sidebars`: "Avoid hiding the sidebar by default to ensure that it remains discoverable."
    expect(getFolderRailVisible()).toBe(true)
  })

  it('remembers being hidden', () => {
    setFolderRailVisible(false)
    expect(getFolderRailVisible()).toBe(false)
    expect(localStorage.getItem('waxwing.folderRail')).toBe('false')
  })

  it('toggles', () => {
    toggleFolderRail()
    expect(getFolderRailVisible()).toBe(false)
    toggleFolderRail()
    expect(getFolderRailVisible()).toBe(true)
  })

  it('treats anything but an explicit "false" as visible', () => {
    // A cleared or corrupted entry returns to the discoverable state rather than to the last one:
    // a reader who cannot find their folders has no way to reason about what went wrong.
    localStorage.setItem('waxwing.folderRail', 'nonsense')
    setFolderRailVisible(true)
    expect(getFolderRailVisible()).toBe(true)
  })
})

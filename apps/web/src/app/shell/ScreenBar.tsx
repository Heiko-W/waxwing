/**
 * A screen's own toolbar, in the one place it belongs on each viewport.
 *
 * Below 40em the shell header carries it (`SCREEN_BAR_ID`), so one row holds both the screen's
 * controls and the shell's; above that the screen keeps its own strip beside the panes, where the
 * brand is on screen and there is room for both.
 *
 * MailScreen has done this since the first audit, and it was the whole of that audit's phone win:
 * an upper row holding a logo and two buttons, directly above a second row with a folder toggle and
 * a title, became one row. Contacts, Calendar and Files never got it. Measured on a 390px phone
 * they still spent a 61px header on `⌘` and an account button — 290 of 390px empty — and put their
 * own band underneath: Calendar needed three bands (169px, 20% of the height) before its grid
 * began, and Contacts showed no title at all, in either of them.
 *
 * So this is that mechanism, extracted rather than copied a third and fourth time. The rule it
 * encodes is one sentence: a screen states where you are and what you can do here, and the viewport
 * decides which row that goes in.
 */

import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SCREEN_BAR_ID } from './Header'
import { useLayoutTier } from './layout'
import styles from './shell.module.css'

/**
 * The header slot on a phone, `null` everywhere else.
 *
 * Looked up after mount rather than passed down: the header is a sibling several levels up, and
 * threading a ref through `AppShell` would make the shell's layout depend on which screen is
 * mounted. Re-queried when the tier changes, because the slot only exists below 40em.
 *
 * A LAYOUT effect, so the bar is in its final place before the first paint. With a passive effect
 * the toolbar rendered once inside the pane and then moved into the header a frame later — a
 * visible jump on the device, and in tests a node already detached by the time anything clicks it.
 */
export function useScreenBarSlot(): HTMLElement | null {
  const tier = useLayoutTier()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setSlot(tier === 'phone' ? document.getElementById(SCREEN_BAR_ID) : null)
  }, [tier])
  return slot
}

/**
 * Render a screen's bar into whichever row this viewport uses.
 *
 * For screens with ONE bar. MailScreen swaps between a list bar and a reading bar depending on
 * which pane is showing, so it holds the slot itself via {@link useScreenBarSlot} and portals the
 * one it wants — the same arrangement, one level lower.
 */
export function ScreenBar({ children }: { readonly children: ReactNode }) {
  const slot = useScreenBarSlot()
  if (slot !== null) return createPortal(children, slot)
  return <div className={styles.paneToolbar}>{children}</div>
}

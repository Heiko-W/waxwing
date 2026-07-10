import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders children into a dedicated element appended to `document.body`, so overlays
 * (Menu, Dialog, Tooltip, Toast) escape ancestor `overflow`/`transform`/stacking contexts
 * and paint above the app. The host element is created once per Portal instance and removed
 * on unmount. Marked `data-waxwing-portal` for debugging and for tests that assert against
 * `document.body`. Client-only by design (Waxwing is a static SPA — tech-stack §2.1), so a
 * layout effect is used to attach the host before paint.
 */
export function Portal({ children }: { children: ReactNode }) {
  const [host] = useState(() => document.createElement('div'))

  useLayoutEffect(() => {
    host.setAttribute('data-waxwing-portal', '')
    document.body.append(host)
    return () => {
      host.remove()
    }
  }, [host])

  return createPortal(children, host)
}

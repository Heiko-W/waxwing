/**
 * Dev-only entry for the M1.1 component gallery. Loaded via a DYNAMIC import from
 * src/main.tsx guarded by `import.meta.env.DEV && import.meta.env.VITE_WAXWING_GALLERY === '1'`,
 * so this subtree is dead-code-eliminated from every production build. i18n is already
 * initialised by the boot sequence before this runs, so component labels resolve.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Gallery } from './Gallery'

export function mountGallery(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  )
}

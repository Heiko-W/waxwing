/**
 * Open-state for the two shortcut overlays (M3.8): the ⌘K command palette and the `?` cheat-sheet.
 *
 * Module-scoped (the `composer-store` precedent) so it can be opened from places that share no React
 * ancestor state: the global key dispatcher and the header's palette button. Only one overlay is open
 * at a time — opening either closes the other. ⌘K inside the open palette closes it via `closeOverlays`
 * (the palette's own `onClose`), so there is no separate toggle to drift out of sync.
 *
 * Reset on sign-out (`SessionProvider.endSession`) — sign-out is an in-SPA transition and the module
 * graph survives it, so a palette left open would greet the next account.
 */

import { create } from 'zustand'

export interface PaletteUiStore {
  readonly paletteOpen: boolean
  readonly helpOpen: boolean
  openPalette(): void
  openHelp(): void
  closeOverlays(): void
}

export const usePaletteUi = create<PaletteUiStore>()((set) => ({
  paletteOpen: false,
  helpOpen: false,
  openPalette: () => set({ paletteOpen: true, helpOpen: false }),
  openHelp: () => set({ helpOpen: true, paletteOpen: false }),
  closeOverlays: () => set({ paletteOpen: false, helpOpen: false }),
}))

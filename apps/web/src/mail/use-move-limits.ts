/**
 * The account limits a folder re-parent must respect (M3.9), read off the JMAP session.
 *
 * Shared by the move picker and the drag, so the two cannot disagree about what is legal — a drag
 * that could reach a parent the dialog filters out would be a new WCAG 2.2 SC 2.5.7 violation
 * rather than a feature.
 */

import { getMailCapability } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useSessionOptional } from '../app/session/context'
import type { MoveLimits } from './folder-tree'

export function useMoveLimits(): MoveLimits {
  // Optional on purpose: `useSession` throws, and the folder tree is mounted in tests (and, briefly,
  // in the shell) without a session provider.
  const session = useSessionOptional()

  return useMemo<MoveLimits>(() => {
    const cap = session ? getMailCapability(session.jmapSession, session.accountId) : null
    return {
      // `maxMailboxDepth` is TYPED `UnsignedInt | null`, but nothing validates it at the wire — a
      // server that omits it hands us `undefined`, which TypeScript cannot see. `undefined > n` is
      // false (silently allows everything) and `?? 0` blocks every move on the commonest config, so
      // narrow explicitly and let an absent limit mean what the RFC says `null` means: unlimited.
      maxMailboxDepth: typeof cap?.maxMailboxDepth === 'number' ? cap.maxMailboxDepth : null,
      // Absent capability ⇒ allowed, matching the ungated top-level "New folder" button.
      mayCreateTopLevelMailbox: cap?.mayCreateTopLevelMailbox ?? true,
    }
  }, [session])
}

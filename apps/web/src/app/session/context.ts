/**
 * Session React context + consumer hooks (M1.4). {@link SessionProvider} fills the value;
 * onboarding, the shell chrome and the feature panes read it here. Kept separate from the
 * provider so presentational components import hooks without a dependency cycle.
 */

import { createContext, useContext } from 'react'
import type { ConnectedSession, SessionContextValue } from './types'

export const SessionContext = createContext<SessionContextValue | null>(null)

/** The session surface (FR-AUTH-01..06). Throws outside a {@link SessionProvider}. */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used within a SessionProvider')
  return value
}

/**
 * The connected JMAP session for feature panes (M1.5/M1.6). Throws if not connected, so a
 * pane never has to null-check the client — it only mounts under a `ready` shell.
 */
export function useJmap(): ConnectedSession {
  const { connected } = useSession()
  if (!connected) throw new Error('useJmap requires a connected session')
  return connected
}

/**
 * The connected session or `null` — outside a {@link SessionProvider} OR not yet connected
 * (M2.7). Lets the composer's attachment hook read the client without forcing a provider in
 * unit tests (which inject a fake uploader instead), mirroring {@link useReplicaOptional}.
 */
export function useSessionOptional(): ConnectedSession | null {
  return useContext(SessionContext)?.connected ?? null
}

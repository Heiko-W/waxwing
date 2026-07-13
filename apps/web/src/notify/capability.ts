/**
 * "Can this server notify me while the app is CLOSED?" (M3.6, RFC 9749 — see ADR-010.)
 *
 * The honest answer today is no, for every JMAP server in existence, and the app says so rather than
 * offering a switch that could never work (NFR-PRIV-02: document what a static client cannot do). The
 * probe is not decoration: it is what makes the statement *checked* rather than hardcoded, so the day
 * a server ships the capability the UI tells the truth without a release.
 */

import { getWebPushVapidCapability } from '@waxwing/jmap'
import { useSessionOptional } from '../app/session/context'

/** Does the server advertise `urn:ietf:params:jmap:webpush-vapid` with a usable key? */
export function serverSupportsBackgroundPush(
  session: Parameters<typeof getWebPushVapidCapability>[0] | null,
): boolean {
  if (session === null) return false
  return getWebPushVapidCapability(session) !== null
}

/** The same, from the React session context. `false` when disconnected — we cannot promise what we cannot check. */
export function useBackgroundPushSupport(): boolean {
  const connected = useSessionOptional()
  return serverSupportsBackgroundPush(connected?.jmapSession ?? null)
}

/**
 * "Can this server notify me while the app is CLOSED?" (M3.6, RFC 9749 — see ADR-010.)
 *
 * Servers that can DO exist: Stalwart v0.16.14 (2026-07-20) ships RFC 9749 and auto-generates a
 * VAPID keypair, so this probe now returns `true` against a stock install. Waxwing still cannot —
 * the client half (subscribe, `PushSubscription/set`, a `push` listener) is unimplemented, and
 * reversing ADR-010 is an open owner decision. So a `true` here means "the server could, we do not
 * yet", never "it works"; the settings copy is worded accordingly (NFR-PRIV-02: document what a
 * static client cannot do). The probe is not decoration — it is what keeps that statement *checked*
 * against the live session rather than hardcoded.
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

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

import { Capabilities, getWebPushVapidCapability, hasCapability, type Session } from '@waxwing/jmap'
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

/**
 * "Can this server put the MESSAGE in the push?" (`draft-ietf-jmap-emailpush-03`; ADR-017 amendment
 * of 2026-08-21.)
 *
 * A second, independent probe rather than a widening of the first, because the two capabilities are
 * genuinely independent and a client that conflated them would get both wrong. RFC 9749
 * (`webpush-vapid`) is what makes a background push POSSIBLE at all; this draft only changes what
 * that push CONTAINS. Stalwart v0.16.16+ has both; a server can have the first without the second —
 * Stalwart itself did, up to v0.16.15 — and a server with neither must keep working exactly as it
 * does today, which is the reason every caller of this returns `false` on `null`.
 *
 * Presence only. The capability object carries nothing a client reads; what may be asked for is
 * discovered by asking (an unknown `properties` entry comes back as `invalidProperties`).
 */
export function serverSupportsEmailPush(session: Session | null): boolean {
  if (session === null) return false
  return hasCapability(session, Capabilities.emailPush)
}

/** The same, from the React session context. `false` while disconnected. */
export function useEmailPushSupport(): boolean {
  const connected = useSessionOptional()
  return serverSupportsEmailPush(connected?.jmapSession ?? null)
}
